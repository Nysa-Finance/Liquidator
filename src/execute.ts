import {
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  type Address,
  type Signature,
  type TokenBalance,
} from '@solana/kit';
import { Decimal } from 'decimal.js';
import { Reserve } from '@kamino-finance/klend-sdk';
import { CFG, FLASH_SOURCE } from './config.js';
import { log } from './logger.js';
import type { RpcClient, RpcPool } from './rpc.js';

/**
 * Simulation, priority fee, submission, confirmation.
 *
 * Non-negotiable rule: nothing is submitted that has not been simulated, and a
 * simulation does not count as passed merely because `err == null` — the real
 * delta of the USDC token account is read.
 */

export type SimResult = {
  ok: boolean;
  err: unknown;
  unitsConsumed: number;
  logs: readonly string[];
  usdcDelta: bigint | null;
};

/** Reads amount (u64 LE @ offset 64) from a base64 SPL token account. */
function tokenAmountFromBase64(data: string): bigint {
  const buf = Buffer.from(data, 'base64');
  if (buf.length < 72) return 0n;
  return buf.readBigUInt64LE(64);
}

export async function simulate(
  rpc: RpcClient,
  wireTxBase64: string,
  usdcAta: Address,
  usdcBefore: bigint,
): Promise<SimResult> {
  const res = await rpc
    .simulateTransaction(wireTxBase64 as never, {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
      accounts: { encoding: 'base64', addresses: [usdcAta] },
    })
    .send();

  const v = res.value;
  const acc = v.accounts?.[0];
  let usdcDelta: bigint | null = null;
  if (acc && Array.isArray(acc.data)) {
    usdcDelta = tokenAmountFromBase64(acc.data[0] as string) - usdcBefore;
  }

  return {
    ok: v.err === null,
    err: v.err,
    unitsConsumed: Number(v.unitsConsumed ?? 0n),
    logs: v.logs ?? [],
    usdcDelta,
  };
}

/**
 * Adaptive priority fee.
 *
 * Cost is `computeUnitLimit × price`, not `unitsConsumed × price`: an inflated
 * limit is wasted money. The cap relative to expected profit avoids handing the
 * whole margin to validators in a race.
 */
export class PriorityFeeOracle {
  private multiplier = 1;

  async suggest(
    rpc: RpcClient,
    writableAccounts: Address[],
    computeUnitLimit: number,
    expectedProfitUsdc: Decimal,
    solPriceUsdc: number,
  ): Promise<bigint> {
    let base = 1_000n; // fallback micro-lamports/CU
    try {
      const fees = await rpc.getRecentPrioritizationFees(writableAccounts).send();
      const vals = fees.map((f) => Number(f.prioritizationFee)).sort((a, b) => a - b);
      if (vals.length > 0) {
        const p75 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.75))]!;
        base = BigInt(Math.max(1, Math.round(p75)));
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'getRecentPrioritizationFees failed, using fallback');
    }

    let price = base * BigInt(this.multiplier);

    // absolute cap
    const lamports = (price * BigInt(computeUnitLimit)) / 1_000_000n;
    if (lamports > BigInt(CFG.maxPriorityLamports)) {
      price = (BigInt(CFG.maxPriorityLamports) * 1_000_000n) / BigInt(computeUnitLimit);
    }

    // cap relative to expected profit
    const maxUsdc = expectedProfitUsdc.mul(CFG.maxPriorityProfitFraction);
    const maxLamports = maxUsdc.div(solPriceUsdc).mul(1e9);
    if (maxLamports.gt(0)) {
      const capPrice = BigInt(maxLamports.mul(1e6).div(computeUnitLimit).floor().toFixed(0));
      if (capPrice < price) price = capPrice;
    }

    return price > 0n ? price : 1n;
  }

  onRaceLost(): void {
    this.multiplier = Math.min(this.multiplier * 2, 16);
  }
  onSuccess(): void {
    this.multiplier = Math.max(1, Math.floor(this.multiplier * 0.9));
  }
}

export async function sendAndConfirm(
  pool: RpcPool,
  wireTxBase64: string,
  lastValidBlockHeight: bigint,
): Promise<{ signature: string; landed: boolean; err: unknown }> {
  const rpc = pool.active();

  // The transaction is signed, so its signature is fixed and broadcasting it
  // more than once is idempotent. Send on every endpoint: a primary that is
  // slow or behind loses a race the secondary would have won.
  const broadcast = () =>
    Promise.allSettled(
      pool.all().map((c) =>
        c
          .sendTransaction(wireTxBase64 as never, {
            encoding: 'base64',
            skipPreflight: true, // we already ran preflight ourselves, and better
            maxRetries: 0n, // rebroadcast handled below
            preflightCommitment: 'processed',
          })
          .send(),
      ),
    );

  const first = await broadcast();
  const ok = first.find((r) => r.status === 'fulfilled');
  if (!ok) {
    const why = first.map((r) => (r.status === 'rejected' ? String(r.reason) : '')).join('; ');
    return { signature: '', landed: false, err: `every endpoint refused the transaction: ${why}` };
  }
  const signature = (ok as PromiseFulfilledResult<Signature>).value;

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const statuses = await rpc.getSignatureStatuses([signature]).send();
    const st = statuses.value[0];
    if (st) {
      if (st.err) return { signature, landed: true, err: st.err };
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
        return { signature, landed: true, err: null };
      }
    }
    const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
    if (height > lastValidBlockHeight) {
      return { signature, landed: false, err: 'blockhash-expired' };
    }
    await broadcast();
    await new Promise((r) => setTimeout(r, 400));
  }
  return { signature, landed: false, err: 'timeout' };
}

export async function signToWire(message: Parameters<typeof signTransactionMessageWithSigners>[0]) {
  const signed = await signTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

/** What a confirmed transaction actually did, as the chain recorded it. */
export type Settlement = {
  /** real USDC movement on the liquidator's account, base units */
  usdcDelta: bigint;
  /** what the transaction actually cost, mandatory fee plus priority fee */
  feeLamports: bigint;
};

type Meta = {
  fee: bigint;
  preTokenBalances?: readonly TokenBalance[];
  postTokenBalances?: readonly TokenBalance[];
};

/**
 * Pulls the real outcome out of a confirmed transaction's metadata.
 *
 * Balances are matched on owner and mint rather than on account index: a v0
 * transaction compressed with a lookup table resolves its indices through
 * `loadedAddresses`, and matching by index would silently read the wrong
 * account. Kept separate from the RPC call so it can be tested on its own.
 */
export function settlementFromMeta(meta: Meta | null, owner: Address, mint: Address): Settlement | null {
  if (!meta) return null;
  const amount = (balances: readonly TokenBalance[] | undefined) => {
    const hit = balances?.find((b) => b.owner === owner && b.mint === mint);
    return hit ? BigInt(hit.uiTokenAmount.amount) : 0n;
  };
  return {
    usdcDelta: amount(meta.postTokenBalances) - amount(meta.preTokenBalances),
    feeLamports: BigInt(meta.fee),
  };
}

/**
 * Reads back what a confirmed transaction really settled.
 *
 * The estimate is what the bot believed before sending; this is what happened.
 * Without the comparison an optimistic slippage model never shows up, and the
 * fees burned on transactions that failed are never counted at all.
 */
export async function reconcile(
  rpc: RpcClient,
  signature: string,
  owner: Address,
  mint: Address,
): Promise<Settlement | null> {
  // The transaction can take a moment to be queryable after confirmation.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const tx = await rpc
        .getTransaction(signature as never, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
        })
        .send();
      if (tx) return settlementFromMeta(tx.meta as Meta | null, owner, mint);
    } catch (e) {
      log.debug({ signature, err: String(e) }, 'reconcile attempt failed');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log.warn({ signature }, 'could not read the confirmed transaction back');
  return null;
}

/**
 * Running total of what the bot actually made and actually spent.
 *
 * The number that decides whether this is worth running is confirmed proceeds
 * minus the fees burned on everything that failed — a run can show a profit on
 * every single liquidation and still lose money on the ones that did not land.
 */
export class Ledger {
  private usdcEarned = 0n;
  private lamportsSpent = 0n;
  private won = 0;
  private lost = 0;

  win(s: Settlement): void {
    this.usdcEarned += s.usdcDelta;
    this.lamportsSpent += s.feeLamports;
    this.won += 1;
  }

  /** A transaction that landed with an error still paid its fee. */
  loss(feeLamports: bigint): void {
    this.lamportsSpent += feeLamports;
    this.lost += 1;
  }

  summary() {
    const attempts = this.won + this.lost;
    return {
      usdcEarned: Number(this.usdcEarned) / 1e6,
      solSpent: Number(this.lamportsSpent) / 1e9,
      won: this.won,
      lost: this.lost,
      landedRate: attempts === 0 ? 0 : this.won / attempts,
    };
  }
}

/**
 * Reads how much the flash source reserve can lend right now.
 *
 * It sits in a different lending market from the target, so it is not in that
 * market's reserve map — looking it up there silently returns nothing and the
 * pre-check never fires.
 */
export async function readFlashLiquidity(rpc: RpcClient): Promise<Decimal> {
  const acc = await rpc.getAccountInfo(FLASH_SOURCE.reserve, { encoding: 'base64' }).send();
  if (!acc.value) return new Decimal(0);
  const reserve = Reserve.decode(Buffer.from((acc.value.data as [string, string])[0], 'base64'));
  return new Decimal(reserve.liquidity.totalAvailableAmount.toString());
}

/**
 * Holds back a position that keeps failing.
 *
 * Without it a position that can never succeed is retried every tick forever,
 * paying a fee each time. Back-off doubles per consecutive failure.
 */
export class Quarantine {
  private readonly held = new Map<string, { until: bigint; strikes: number }>();

  isHeld(obligation: string, slot: bigint): boolean {
    const e = this.held.get(obligation);
    if (!e) return false;
    if (slot >= e.until) {
      this.held.delete(obligation);
      return false;
    }
    return true;
  }

  record(obligation: string, slot: bigint, reason: string): void {
    const strikes = (this.held.get(obligation)?.strikes ?? 0) + 1;
    // 30 slots (~12s), doubling per strike, capped at roughly 20 minutes
    const slots = BigInt(Math.min(30 * 2 ** (strikes - 1), 3000));
    this.held.set(obligation, { until: slot + slots, strikes });
    log.debug({ obligation, strikes, holdSlots: slots.toString(), reason }, 'quarantined');
  }
}

/** In-process lock: one plan in flight per obligation. */
export class InFlightGuard {
  private readonly inFlight = new Map<string, number>();

  tryAcquire(obligation: string, ttlMs = 90_000): boolean {
    const now = Date.now();
    const until = this.inFlight.get(obligation);
    if (until !== undefined && until > now) return false;
    this.inFlight.set(obligation, now + ttlMs);
    return true;
  }
  release(obligation: string): void {
    this.inFlight.delete(obligation);
  }
}

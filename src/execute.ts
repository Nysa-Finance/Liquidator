import {
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  type Address,
  type Signature,
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

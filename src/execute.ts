import {
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  type Address,
} from '@solana/kit';
import { Decimal } from 'decimal.js';
import { CFG } from './config.js';
import { log } from './logger.js';
import type { RpcClient, RpcPool } from './rpc.js';

/**
 * Simulazione, priority fee, invio, conferma.
 *
 * Regola non negoziabile: non si invia nulla che non sia stato simulato, e la
 * simulazione non si considera superata solo perché `err == null` — si legge il
 * delta reale dell'ATA USDC.
 */

export type SimResult = {
  ok: boolean;
  err: unknown;
  unitsConsumed: number;
  logs: readonly string[];
  usdcDelta: bigint | null;
};

/** Legge l'amount (u64 LE @ offset 64) da un SPL token account base64. */
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
 * Priority fee adattiva.
 *
 * Il costo è `computeUnitLimit × price`, non `unitsConsumed × price`: un limite
 * gonfiato è denaro buttato. Il cap relativo al profitto atteso evita di regalare
 * ai validator tutto il margine in una gara.
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
    let base = 1_000n; // micro-lamport/CU di fallback
    try {
      const fees = await rpc.getRecentPrioritizationFees(writableAccounts).send();
      const vals = fees.map((f) => Number(f.prioritizationFee)).sort((a, b) => a - b);
      if (vals.length > 0) {
        const p75 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.75))]!;
        base = BigInt(Math.max(1, Math.round(p75)));
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'getRecentPrioritizationFees fallita, uso fallback');
    }

    let price = base * BigInt(this.multiplier);

    // cap assoluto
    const lamports = (price * BigInt(computeUnitLimit)) / 1_000_000n;
    if (lamports > BigInt(CFG.maxPriorityLamports)) {
      price = (BigInt(CFG.maxPriorityLamports) * 1_000_000n) / BigInt(computeUnitLimit);
    }

    // cap relativo al profitto atteso
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
  const signature = await rpc
    .sendTransaction(wireTxBase64 as never, {
      encoding: 'base64',
      skipPreflight: true, // la preflight l'abbiamo già fatta noi, e meglio
      maxRetries: 0n,      // rebroadcast gestito qui sotto
      preflightCommitment: 'processed',
    })
    .send();

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
    // rebroadcast: la signature è identica, l'operazione è idempotente
    await rpc
      .sendTransaction(wireTxBase64 as never, {
        encoding: 'base64',
        skipPreflight: true,
        maxRetries: 0n,
      })
      .send()
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
  }
  return { signature, landed: false, err: 'timeout' };
}

export async function signToWire(message: Parameters<typeof signTransactionMessageWithSigners>[0]) {
  const signed = await signTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

/** Lock in-process: un solo piano in volo per obligation. */
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

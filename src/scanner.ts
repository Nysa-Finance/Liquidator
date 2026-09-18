import type { Address, Base58EncodedBytes } from '@solana/kit';
import type { RpcClient } from './rpc.js';
import { KLEND_PROGRAM } from './config.js';

/**
 * Health prefilter over EVERY obligation of a market, in a single RPC call.
 *
 * The idea: `getProgramAccounts` accepts a `dataSlice`, i.e. it can return only
 * a window of bytes per account. Instead of downloading 106,000 obligations ×
 * 3,344 bytes (~355 MB) we download 64 bytes each (~7 MB) — enough to know who
 * sits above the liquidation threshold.
 *
 * An obligation is above threshold when
 *     borrow_factor_adjusted_debt_value_sf >= unhealthy_borrow_value_sf
 * (both are scaled USD values sharing the same LTV denominator, so their ratio
 * IS the ratio between LTV and threshold).
 *
 * WARNING: these fields hold the state of the LAST successful
 * `refresh_obligation`, not the state at current prices. The output is a list of
 * CANDIDATES to verify, not a list of certainties.
 */

/** OBLIGATION_SIZE (3336) + 8 bytes of Anchor discriminator. */
export const OBLIGATION_ACCOUNT_SIZE = 3344;

/** RESERVE_SIZE (8616) + 8 bytes of Anchor discriminator. */
export const RESERVE_ACCOUNT_SIZE = 8624;

/**
 * One entry of a Scope `OraclePrices` account.
 * Layout: disc(8) + oracle_mappings: Pubkey(32) + prices: [DatedPrice; 512],
 * where DatedPrice = value u64 | exp u64 | last_updated_slot u64 |
 * unix_timestamp u64 | [u8; 24], 56 bytes each.
 *
 * klend reads this account directly, with no CPI into Scope, so these bytes are
 * exactly what a reserve refresh will consume.
 */
export function scopePrice(feed: Buffer, index: number) {
  const o = 40 + index * 56;
  const value = feed.readBigUInt64LE(o);
  const exp = feed.readBigUInt64LE(o + 8);
  return {
    value,
    exp,
    slot: feed.readBigUInt64LE(o + 16),
    unixTimestamp: feed.readBigUInt64LE(o + 24),
    price: Number(value) / 10 ** Number(exp),
    offset: o,
  };
}

/**
 * Field offsets inside the account, discriminator included.
 * Derived empirically and re-verified by `tests/live.readonly.test.ts` against
 * the official SDK decoder: if Kamino changes the struct, that test fails
 * instead of letting wrong numbers through.
 */
export const OBLIGATION_OFFSETS = {
  lendingMarket: 32,
  depositedValueSf: 1192,
  borrowFactorAdjustedDebtValueSf: 2208,
  borrowedAssetsMarketValueSf: 2224,
  allowedBorrowValueSf: 2240,
  unhealthyBorrowValueSf: 2256,
} as const;

/** Window covering the four aggregate values at the tail of the struct. */
export const HEALTH_WINDOW = {
  offset: OBLIGATION_OFFSETS.borrowFactorAdjustedDebtValueSf,
  length: 64,
} as const;

export type HealthScan = { total: number; rows: HealthRow[] };

export type HealthRow = {
  obligation: Address;
  /** borrow-factor-adjusted debt, in 2^60-scaled units */
  debtValueSf: bigint;
  borrowedAssetsValueSf: bigint;
  allowedBorrowValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  /** 1.0 = exactly at the liquidation threshold; > 1 = above it */
  healthRatio: number;
  /** 1.0 = exactly at the borrow limit */
  borrowUtilization: number;
};

const SF = 2 ** 60;

function readU128LE(b: Buffer, o: number): bigint {
  return b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
}

export function decodeHealthWindow(obligation: Address, data: Buffer): HealthRow | null {
  if (data.length < HEALTH_WINDOW.length) return null;
  const base = HEALTH_WINDOW.offset;
  const debtValueSf = readU128LE(data, OBLIGATION_OFFSETS.borrowFactorAdjustedDebtValueSf - base);
  const borrowedAssetsValueSf = readU128LE(data, OBLIGATION_OFFSETS.borrowedAssetsMarketValueSf - base);
  const allowedBorrowValueSf = readU128LE(data, OBLIGATION_OFFSETS.allowedBorrowValueSf - base);
  const unhealthyBorrowValueSf = readU128LE(data, OBLIGATION_OFFSETS.unhealthyBorrowValueSf - base);

  if (debtValueSf === 0n || unhealthyBorrowValueSf === 0n) return null; // no usable debt

  return {
    obligation,
    debtValueSf,
    borrowedAssetsValueSf,
    allowedBorrowValueSf,
    unhealthyBorrowValueSf,
    healthRatio: Number(debtValueSf) / Number(unhealthyBorrowValueSf),
    borrowUtilization:
      allowedBorrowValueSf === 0n ? Infinity : Number(debtValueSf) / Number(allowedBorrowValueSf),
  };
}

/** USD value of a 2^60-scaled field. */
export function sfToUsd(sf: bigint): number {
  return Number(sf) / SF;
}

export type ScanOptions = {
  /**
   * Drop positions below this debt threshold, in USD.
   *
   * This matters: on the Main Market ~10,500 obligations read as "above
   * threshold", but the vast majority are closed or dust positions whose
   * aggregate values stayed frozen at their last refresh. Without this filter
   * the candidate list is dominated by noise.
   */
  minDebtUsd?: number;
};

export async function scanObligationHealth(
  rpc: RpcClient,
  market: Address,
  programId: Address = KLEND_PROGRAM,
  opts: ScanOptions = {},
): Promise<HealthScan> {
  const res = await rpc
    .getProgramAccounts(programId, {
      encoding: 'base64',
      dataSlice: HEALTH_WINDOW,
      filters: [
        { dataSize: BigInt(OBLIGATION_ACCOUNT_SIZE) },
        {
          memcmp: {
            offset: BigInt(OBLIGATION_OFFSETS.lendingMarket),
            bytes: market as unknown as Base58EncodedBytes,
            encoding: 'base58',
          },
        },
      ],
    })
    .send();
  // without `withContext` the RPC returns the array directly
  const accounts = res as unknown as { pubkey: Address; account: { data: [string, string] } }[];

  const rows: HealthRow[] = [];
  for (const a of accounts) {
    const data = Buffer.from(a.account.data[0], 'base64');
    const row = decodeHealthWindow(a.pubkey, data);
    if (!row) continue;
    if (opts.minDebtUsd !== undefined && sfToUsd(row.debtValueSf) < opts.minDebtUsd) continue;
    rows.push(row);
  }
  rows.sort((x, y) => y.healthRatio - x.healthRatio);
  return { total: accounts.length, rows };
}

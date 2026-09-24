import { address, type Address } from '@solana/kit';

/**
 * Constants VERIFIED on-chain / against program source, last re-read at slot
 * ~448,090,000 (2026-09-18). Every value here was read, not assumed.
 * See docs/01-protocol.md.
 *
 * WARNING: the risk parameters (bonus, close factor, fees) are mirrored here
 * ONLY as a sanity check. At runtime always re-read them from the on-chain
 * accounts: a curator can change them at any time via update_reserve_config.
 */

// ── Programs ───────────────────────────────────────────────────────────────
export const KLEND_PROGRAM = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const WHIRLPOOL_PROGRAM_ID = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const SYSVAR_INSTRUCTIONS = address('Sysvar1nstructions1111111111111111111111111');
export const FARMS_PROGRAM = address('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');

/**
 * Where the SOL price comes from, for pricing fees.
 *
 * Kamino's main Scope feed, whose first three entries carry SOL/ETH/BTC —
 * verified live: 113.05 / 2638.78 / 83302.37. Deliberately independent of what
 * the reserves read: a reserve can be repointed at another feed, as USDY was.
 */
export const SOL_PRICE_FEED = address('3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C');
export const SOL_SCOPE_INDEX = 0;

/** Used only when the feed cannot be read; the fee ceiling is then approximate. */
export const SOL_PRICE_FALLBACK_USD = 150;

// ── Target market: "USDY Ondo Market" ──────────────────────────────────────
export const TARGET_MARKET = {
  address: address('F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy'),
  name: 'USDY Ondo Market',
  owner: address('66pW72Fchnr34FGgXrxheGs3BbUsDSwJmGcK7m8Bz1Yv'),
  // parameters read on-chain, used as a sanity check against runtime state
  liquidationMaxDebtCloseFactorPct: 25,
  maxLiquidatableDebtMarketValueAtOnce: 30_000,
  /** Below this debt value in USD the program demands a FULL repayment. */
  minFullLiquidationValueThreshold: 100,
  insolvencyRiskUnhealthyLtvPct: 97,
  isPermissioned: false, // permissioningAuthority == 11111111111111111111111111111111
} as const;

// ── Reserves of the target market ──────────────────────────────────────────
export const USDY_RESERVE = {
  address: address('rpTGWR3JDjjPfXLCg5Fx1GpSdUxPt1pxW7fwXGUT6js'),
  symbol: 'USDY',
  liquidityMint: address('A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6'),
  decimals: 6,
  tokenProgram: TOKEN_PROGRAM,
  supplyVault: address('AVxf9dXFj5M7xCM7SU6cRM2FnUtZyeWcqHSJVt5Fbdsk'),
  feeVault: address('RAZFwzfLEZMzG9toay62VPH5WdUgq8GUhJEdjqzb2yS'),
  collateralMint: address('C7dKsFYaM2DcVJSDjouPTfLc9292Lkd5ti9VQCdx2UDg'),
  collateralSupplyVault: address('AdF4ybj8neZkqoiyxFLkkieRHMboJkDqc1BZGG6SDPhx'),
  /**
   * Repointed by the curator around 24 Sep 2026: it used to read index 3 of the
   * main feed, which is where Kamino parks retired assets and reads 0.000001 USD.
   * The two reserves no longer share a feed, so each carries its own.
   */
  scopeFeed: address('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH'),
  scopeChain: [406],
  loanToValuePct: 92,
  liquidationThresholdPct: 95,
  minLiquidationBonusBps: 200,
  maxLiquidationBonusBps: 500,
  protocolLiquidationFeePct: 0,
  borrowFactorPct: 100,
  hasFarms: false,
} as const;

export const USDC_RESERVE = {
  address: address('GQr5hXuRgHAmguh6EqcpeJXrMyqCQch4P6XkSvawwNk2'),
  symbol: 'USDC',
  liquidityMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  decimals: 6,
  tokenProgram: TOKEN_PROGRAM,
  supplyVault: address('68YwkFhagT33k8485VtX1MhMYpab97c1MjpWcXFuTYea'),
  feeVault: address('HS5RA3CPZsUvgsKTsgn17tUqKMXiQcCCXK6tiJGfaj1G'),
  collateralMint: address('Eyq6nikS6Mh5zsG2iLCLAB9Rz2dUEsxR5aqMAdxCdQLZ'),
  scopeFeed: address('3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C'),
  scopeChain: [20, 230],
  borrowFactorPct: 100,
  hasFarms: false,
} as const;

/**
 * Flash loan source.
 *
 * NOT the Nysa market's USDC reserve: it holds 0.1 USDC. The Main Market holds
 * ~23M. flash_borrow/flash_repay impose no link between the borrowed reserve and
 * the market of the liquidated obligation (verified in
 * handler_flash_borrow_reserve_liquidity.rs).
 */
export const FLASH_SOURCE = {
  market: address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'),
  reserve: address('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'),
  liquidityMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  supplyVault: address('Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6'),
  feeVault: address('BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX'),
  tokenProgram: TOKEN_PROGRAM,
  /** flash_loan_fee_sf = 11529215046068, 2^60 scale → 1e-5 = 0.001% = 0.1 bps */
  flashLoanFeeRate: 11529215046068 / 2 ** 60,
} as const;

// ── Orca exit pool ─────────────────────────────────────────────────────────
export const ORCA_POOL = {
  address: address('AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD'),
  /** mint A = USDY, mint B = USDC → selling USDY is a_to_b = true */
  tokenMintA: address('A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6'),
  tokenMintB: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  tokenVaultA: address('7jLEfNKea3UUrRUbxVMjZQc8vLohAUaZ7vo3akpnWW8V'),
  tokenVaultB: address('2vKEGgEzrDa3zGAdszdwmpygEYSTJvYVhPpp6WBY55eS'),
  tickSpacing: 16,
  /** feeRate 1600 on a 1e6 base → 0.16% */
  feeRate: 1600,
  addressLookupTable: address('9iiRsm2M5jaFnDbgAjBbbasTwo6m3AV6N22k1ANt47Bm'),
} as const;

// ── Configuration from .env ────────────────────────────────────────────────
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}
/**
 * Every comparison against NaN is false, so an unparsable threshold would not
 * reject anything — a losing plan would sail past minimum profit, minimum margin
 * and the oracle divergence guard in silence. Refuse to start instead.
 *
 * The usual way to get here is an inline comment in the env file: systemd's
 * EnvironmentFile and `docker run --env-file` keep everything after the `#` as
 * part of the value, unlike a shell or Node's --env-file.
 */
function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${name}="${v}" is not a number. Remove any trailing comment: systemd and ` +
        `docker --env-file keep everything after the '#' as part of the value.`,
    );
  }
  return n;
}

/**
 * Required fields are lazy getters: importing the verified constants (from a
 * read-only script, say) must not demand a keypair.
 */
export const CFG = {
  get rpcPrimary() { return req('RPC_PRIMARY'); },
  get rpcSecondary() { return process.env.RPC_SECONDARY ?? ''; },
  get wsPrimary() { return process.env.WS_PRIMARY ?? ''; },
  get keypairPath() { return req('KEYPAIR_PATH'); },

  /** Defaults to true on purpose. Turn it off by hand, deliberately. */
  get dryRun() { return (process.env.DRY_RUN ?? 'true') !== 'false'; },

  get minProfitUsdc() { return num('MIN_PROFIT_USDC', 2.0); },
  get minMarginBps() { return num('MIN_MARGIN_BPS', 50); },
  get maxOracleDivergenceBps() { return num('MAX_ORACLE_DIVERGENCE_BPS', 100); },
  get liqSlippageBps() { return num('LIQ_SLIPPAGE_BPS', 50); },
  get swapSlippageBps() { return num('SWAP_SLIPPAGE_BPS', 30); },
  get maxPriorityLamports() { return num('MAX_PRIORITY_LAMPORTS', 2_000_000); },
  get maxPriorityProfitFraction() { return num('MAX_PRIORITY_PROFIT_FRACTION', 0.25); },

  get maxSnapshotAgeSlots() { return num('MAX_SNAPSHOT_AGE_SLOTS', 4); },
  get scanIntervalMs() { return num('SCAN_INTERVAL_MS', 2000); },
  get lookupTable() { return process.env.LOOKUP_TABLE ?? ''; },
  get logLevel() { return process.env.LOG_LEVEL ?? 'info'; },
} as const;

/**
 * Fails fast on a configuration that would quietly misbehave. Called once at
 * start-up so a bad value stops the bot instead of disarming a guard.
 */
export function validateConfig(): void {
  // touching every getter forces num() to parse, and to throw on garbage
  const c = {
    minProfitUsdc: CFG.minProfitUsdc,
    minMarginBps: CFG.minMarginBps,
    maxOracleDivergenceBps: CFG.maxOracleDivergenceBps,
    maxSnapshotAgeSlots: CFG.maxSnapshotAgeSlots,
    liqSlippageBps: CFG.liqSlippageBps,
    swapSlippageBps: CFG.swapSlippageBps,
    maxPriorityLamports: CFG.maxPriorityLamports,
    maxPriorityProfitFraction: CFG.maxPriorityProfitFraction,
    scanIntervalMs: CFG.scanIntervalMs,
  };

  for (const [k, v] of Object.entries(c)) {
    if (v < 0) throw new Error(`${k} must not be negative, got ${v}`);
  }

  // The swap is sized on the guaranteed minimum, so this haircut comes straight
  // out of the bonus. At the 200 bps floor the break-even is about 180 bps once
  // the Orca fee and the flash fee are paid; past that the swap no longer
  // repays the flash loan and every liquidation reverts.
  const MAX_SAFE_LIQ_SLIPPAGE_BPS = 150;
  if (c.liqSlippageBps > MAX_SAFE_LIQ_SLIPPAGE_BPS) {
    throw new Error(
      `LIQ_SLIPPAGE_BPS=${c.liqSlippageBps} exceeds ${MAX_SAFE_LIQ_SLIPPAGE_BPS}: the haircut ` +
        `would eat the 200 bps minimum bonus and the swap could not repay the flash loan`,
    );
  }
  if (c.maxPriorityProfitFraction > 1) {
    throw new Error(`MAX_PRIORITY_PROFIT_FRACTION=${c.maxPriorityProfitFraction} would pay out more than the profit`);
  }
}

export type { Address };

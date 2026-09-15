import { address, type Address } from '@solana/kit';
import 'dotenv/config';

/**
 * Costanti VERIFICATE on-chain / su sorgente allo slot ~446.813.000 (2026-09-13).
 * Ogni valore qui è stato letto, non assunto. Vedi docs/00-VERDETTO.md.
 *
 * ATTENZIONE: i parametri di rischio (bonus, close factor, fee) sono replicati qui
 * SOLO come sanity check. A runtime vanno sempre riletti dagli account on-chain:
 * un curator può cambiarli in qualunque momento con update_reserve_config.
 */

// ── Programmi ──────────────────────────────────────────────────────────────
export const KLEND_PROGRAM = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const WHIRLPOOL_PROGRAM = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
export const SCOPE_PROGRAM = address('HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const SYSVAR_INSTRUCTIONS = address('Sysvar1nstructions1111111111111111111111111');
export const FARMS_PROGRAM = address('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');

// ── Market bersaglio: "Nysa First Trial" ───────────────────────────────────
export const TARGET_MARKET = {
  address: address('F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy'),
  name: 'Nysa First Trial',
  owner: address('66pW72Fchnr34FGgXrxheGs3BbUsDSwJmGcK7m8Bz1Yv'),
  scopePrices: address('3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C'),
  // parametri letti on-chain, per sanity check contro lo stato runtime
  liquidationMaxDebtCloseFactorPct: 20,
  maxLiquidatableDebtMarketValueAtOnce: 500_000,
  minFullLiquidationValueThreshold: 2,
  insolvencyRiskUnhealthyLtvPct: 95,
  isPermissioned: false, // permissioningAuthority == 11111111111111111111111111111111
} as const;

// ── Reserve del market bersaglio ───────────────────────────────────────────
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
  loanToValuePct: 70,
  liquidationThresholdPct: 75,
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
  collateralSupplyVault: address('AHyTfgUZKsoAgFMx6HtxzhAb7EpUfoaScuJAYRd3tLpm'),
  borrowFactorPct: 100,
  hasFarms: false,
} as const;

/**
 * Sorgente del flash loan.
 *
 * NON si usa la reserve USDC del market Nysa: ha 0,1 USDC di liquidità.
 * Il Main Market ne ha ~23 M. flash_borrow/flash_repay non impongono alcun legame
 * tra la reserve del prestito e il market dell'obligation liquidata (verificato in
 * handler_flash_borrow_reserve_liquidity.rs).
 */
export const FLASH_SOURCE = {
  market: address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'),
  reserve: address('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'),
  liquidityMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  supplyVault: address('Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6'),
  feeVault: address('BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX'),
  tokenProgram: TOKEN_PROGRAM,
  /** flash_loan_fee_sf = 11529215046068, scala 2^60 → 1e-5 = 0,001 % = 0,1 bps */
  flashLoanFeeRate: 11529215046068 / 2 ** 60,
} as const;

// ── Pool Orca di uscita ────────────────────────────────────────────────────
export const ORCA_POOL = {
  address: address('AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD'),
  /** mint A = USDY, mint B = USDC → vendere USDY è a_to_b = true */
  tokenMintA: address('A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6'),
  tokenMintB: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  tokenVaultA: address('7jLEfNKea3UUrRUbxVMjZQc8vLohAUaZ7vo3akpnWW8V'),
  tokenVaultB: address('2vKEGgEzrDa3zGAdszdwmpygEYSTJvYVhPpp6WBY55eS'),
  tickSpacing: 16,
  /** feeRate 1600 su base 1e6 → 0,16 % */
  feeRate: 1600,
  addressLookupTable: address('9iiRsm2M5jaFnDbgAjBbbasTwo6m3AV6N22k1ANt47Bm'),
} as const;

// ── Config da .env ─────────────────────────────────────────────────────────
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variabile d'ambiente mancante: ${name}`);
  return v;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  return v === undefined ? dflt : Number(v);
}

/**
 * I campi obbligatori sono getter pigri: importare le costanti verificate
 * (per esempio da uno script di sola lettura) non deve pretendere una keypair.
 */
export const CFG = {
  get rpcPrimary() { return req('RPC_PRIMARY'); },
  get rpcSecondary() { return process.env.RPC_SECONDARY ?? ''; },
  get wsPrimary() { return process.env.WS_PRIMARY ?? ''; },
  get keypairPath() { return req('KEYPAIR_PATH'); },

  /** Default true di proposito. Si disattiva a mano, consapevolmente. */
  get dryRun() { return (process.env.DRY_RUN ?? 'true') !== 'false'; },

  get minProfitUsdc() { return num('MIN_PROFIT_USDC', 2.0); },
  get minMarginBps() { return num('MIN_MARGIN_BPS', 50); },
  get maxOracleDivergenceBps() { return num('MAX_ORACLE_DIVERGENCE_BPS', 100); },
  get maxSnapshotAgeSlots() { return num('MAX_SNAPSHOT_AGE_SLOTS', 4); },
  get liqSlippageBps() { return num('LIQ_SLIPPAGE_BPS', 50); },
  get swapSlippageBps() { return num('SWAP_SLIPPAGE_BPS', 30); },
  get maxPriorityLamports() { return num('MAX_PRIORITY_LAMPORTS', 2_000_000); },
  get maxPriorityProfitFraction() { return num('MAX_PRIORITY_PROFIT_FRACTION', 0.25); },

  get scanIntervalMs() { return num('SCAN_INTERVAL_MS', 2000); },
  get logLevel() { return process.env.LOG_LEVEL ?? 'info'; },
} as const;

export type ReserveRef = typeof USDY_RESERVE | typeof USDC_RESERVE;
export type { Address };

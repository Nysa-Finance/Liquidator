import { Decimal } from 'decimal.js';
import type { KaminoMarket, KaminoObligation, KaminoReserve } from '@kamino-finance/klend-sdk';
import type { Address } from '@solana/kit';
import { CFG, FLASH_SOURCE, USDC_RESERVE, USDY_RESERVE } from './config.js';
import type { Eligibility } from './eligibility.js';
import { quoteUsdyToUsdc, spotPrice, type OrcaContext } from './build/orca.js';

/**
 * Profitability engine — see docs/03-profitability.md.
 *
 * Π ≈ R · [ (1+b)·ρ·(1−s)·(1−f_orca) − (1+φ) ] − c_base − c_prio
 *
 * where ρ = Orca price / Scope price. ρ is the real risk factor: a 1.8%
 * mismatch wipes out a 2% bonus.
 */

export type PlanReject =
  | 'no-collateral-liquidity'        // you would receive cUSDY instead of USDY
  | 'insufficient-flash-liquidity'
  | 'oracle-divergence'
  | 'below-min-profit'
  | 'below-min-margin'
  | 'dust';

export type LiquidationPlan = {
  obligation: Address;
  slot: bigint;
  /** USDC repaid, base units */
  repayAmount: bigint;
  /** on-chain guard on the liquidation instruction */
  minReceivedUsdy: bigint;
  /** on-chain guard on the Orca swap */
  minUsdcOut: bigint;
  expectedUsdyOut: bigint;
  expectedUsdcOut: bigint;
  expectedProfitUsdc: Decimal;
  worstCaseProfitUsdc: Decimal;
  bonusRate: Decimal;
  oracleRatio: Decimal;
};

export type PlanResult = { ok: true; plan: LiquidationPlan } | { ok: false; reason: PlanReject };

const BPS = new Decimal(10_000);

export function buildPlan(args: {
  market: KaminoMarket;
  obligation: KaminoObligation;
  debtReserve: KaminoReserve;
  collReserve: KaminoReserve;
  eligibility: Extract<Eligibility, { ok: true }>;
  orca: OrcaContext;
  slot: bigint;
  nowSeconds: bigint;
  /** fixed-cost estimate in USDC (base fee + priority fee, converted) */
  fixedCostUsdc: Decimal;
}): PlanResult {
  const { obligation, debtReserve, collReserve, eligibility, orca } = args;

  const borrow = obligation.getBorrowByReserve(debtReserve.address as Address);
  const deposit = obligation.getDepositByReserve(collReserve.address as Address);
  if (!borrow || !deposit) return { ok: false, reason: 'dust' };

  const pxDebt = debtReserve.getOracleMarketPrice();   // USDC/USD, ~1
  const pxColl = collReserve.getOracleMarketPrice();   // USDY/USD, ~1,14
  if (pxDebt.lte(0) || pxColl.lte(0)) return { ok: false, reason: 'oracle-divergence' };

  // ── 1. how much can be repaid ─────────────────────────────────────────
  const debtLamports = borrow.amount; // base units USDC
  const maxByCloseFactor = debtLamports.mul(eligibility.closeFactor);
  const maxByMarketCap = new Decimal(
    args.market.state.maxLiquidatableDebtMarketValueAtOnce.toString(),
  ).div(pxDebt).mul(10 ** USDC_RESERVE.decimals);

  let repay = Decimal.min(maxByCloseFactor, maxByMarketCap).floor();
  if (repay.lte(0)) return { ok: false, reason: 'dust' };

  // ── 2. collateral received ────────────────────────────────────────────
  const bonusMul = eligibility.bonusRate.add(1);
  const seizedValueUsd = repay.div(10 ** USDC_RESERVE.decimals).mul(pxDebt).mul(bonusMul);
  let usdyGross = seizedValueUsd.div(pxColl).mul(10 ** USDY_RESERVE.decimals).floor();

  // cap at the collateral actually deposited
  const depositLamports = deposit.amount;
  if (usdyGross.gt(depositLamports)) {
    usdyGross = depositLamports;
    repay = depositLamports
      .div(10 ** USDY_RESERVE.decimals).mul(pxColl)
      .div(bonusMul).div(pxDebt).mul(10 ** USDC_RESERVE.decimals).floor();
  }

  // ── 3. does the USDY reserve hold enough liquidity to REDEEM? ─────────
  // If not, the instruction succeeds but hands you cUSDY rather than USDY: the
  // swap then fails and the whole transaction reverts. See docs/01-protocol.md.
  const availableUsdy = collReserve.getLiquidityAvailableAmount();
  if (usdyGross.gt(availableUsdy)) return { ok: false, reason: 'no-collateral-liquidity' };

  // protocol_liquidation_fee = max(ceil(bonus_part * pct), 1) → at least 1 lamport
  const bonusPart = usdyGross.minus(usdyGross.div(bonusMul));
  const protoFee = Decimal.max(
    bonusPart.mul(collReserve.state.config.protocolLiquidationFeePct).div(100).ceil(),
    1,
  );
  const usdyNet = usdyGross.minus(protoFee);
  if (usdyNet.lte(0)) return { ok: false, reason: 'dust' };

  // ── 4. liquidity available for the flash loan ─────────────────────────
  // (simulation is the final word; this only avoids certainly-doomed txs)
  const flashReserve = args.market.getReserveByAddress(FLASH_SOURCE.reserve);
  if (flashReserve && repay.gt(flashReserve.getLiquidityAvailableAmount())) {
    return { ok: false, reason: 'insufficient-flash-liquidity' };
  }

  // ── 5. Orca quote ─────────────────────────────────────────────────────
  const usdyIn = BigInt(usdyNet.toFixed(0));
  const quote = quoteUsdyToUsdc(orca, usdyIn, CFG.swapSlippageBps, args.nowSeconds);

  // ρ = Orca market price / Scope oracle price (both USDY denominated in USDC)
  const orcaSpot = new Decimal(spotPrice(orca.pool));
  const scopeUsdyInUsdc = pxColl.div(pxDebt);
  const rho = orcaSpot.div(scopeUsdyInUsdc);
  if (rho.minus(1).abs().mul(BPS).gt(CFG.maxOracleDivergenceBps)) {
    return { ok: false, reason: 'oracle-divergence' };
  }

  // ── 6. profit ─────────────────────────────────────────────────────────
  const flashFee = repay.mul(FLASH_SOURCE.flashLoanFeeRate).ceil();
  const usdcOut = new Decimal(quote.tokenEstOut.toString());
  const usdcOutWorst = new Decimal(quote.tokenMinOut.toString());

  const toUsdc = (x: Decimal) => x.div(10 ** USDC_RESERVE.decimals);
  const expectedProfit = toUsdc(usdcOut.minus(repay).minus(flashFee)).minus(args.fixedCostUsdc);
  const worstProfit = toUsdc(usdcOutWorst.minus(repay).minus(flashFee)).minus(args.fixedCostUsdc);

  if (worstProfit.lt(CFG.minProfitUsdc)) return { ok: false, reason: 'below-min-profit' };
  const marginBps = expectedProfit.div(toUsdc(repay)).mul(BPS);
  if (marginBps.lt(CFG.minMarginBps)) return { ok: false, reason: 'below-min-margin' };

  // ── 7. on-chain guards ────────────────────────────────────────────────
  const minReceivedUsdy = BigInt(
    usdyNet.mul(BPS.minus(CFG.liqSlippageBps)).div(BPS).floor().toFixed(0),
  );

  return {
    ok: true,
    plan: {
      obligation: obligation.obligationAddress as Address,
      slot: args.slot,
      repayAmount: BigInt(repay.toFixed(0)),
      minReceivedUsdy,
      minUsdcOut: quote.tokenMinOut,
      expectedUsdyOut: usdyIn,
      expectedUsdcOut: quote.tokenEstOut,
      expectedProfitUsdc: expectedProfit,
      worstCaseProfitUsdc: worstProfit,
      bonusRate: eligibility.bonusRate,
      oracleRatio: rho,
    },
  };
}

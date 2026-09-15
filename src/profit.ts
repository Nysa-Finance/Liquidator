import { Decimal } from 'decimal.js';
import type { KaminoMarket, KaminoObligation, KaminoReserve } from '@kamino-finance/klend-sdk';
import type { Address } from '@solana/kit';
import { CFG, FLASH_SOURCE, USDC_RESERVE, USDY_RESERVE } from './config.js';
import type { Eligibility } from './eligibility.js';
import { quoteUsdyToUsdc, spotPrice, type OrcaContext } from './build/orca.js';

/**
 * Motore di profittabilità — vedi docs/04-profittabilita.md.
 *
 * Π ≈ R · [ (1+b)·ρ·(1−s)·(1−f_orca) − (1+φ) ] − c_base − c_prio
 *
 * dove ρ = prezzo Orca / prezzo Scope. ρ è il vero fattore di rischio: un
 * disallineamento dell'1,8 % azzera un bonus del 2 %.
 */

export type PlanReject =
  | 'no-collateral-liquidity'        // riceveresti cUSDY invece di USDY
  | 'insufficient-flash-liquidity'
  | 'oracle-divergence'
  | 'below-min-profit'
  | 'below-min-margin'
  | 'dust';

export type LiquidationPlan = {
  obligation: Address;
  slot: bigint;
  /** USDC ripagati, base units */
  repayAmount: bigint;
  /** guardia on-chain sulla ix di liquidazione */
  minReceivedUsdy: bigint;
  /** guardia on-chain sullo swap Orca */
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
  /** stima costi fissi in USDC (base fee + priority fee convertite) */
  fixedCostUsdc: Decimal;
}): PlanResult {
  const { obligation, debtReserve, collReserve, eligibility, orca } = args;

  const borrow = obligation.getBorrowByReserve(debtReserve.address as Address);
  const deposit = obligation.getDepositByReserve(collReserve.address as Address);
  if (!borrow || !deposit) return { ok: false, reason: 'dust' };

  const pxDebt = debtReserve.getOracleMarketPrice();   // USDC/USD, ~1
  const pxColl = collReserve.getOracleMarketPrice();   // USDY/USD, ~1,14
  if (pxDebt.lte(0) || pxColl.lte(0)) return { ok: false, reason: 'oracle-divergence' };

  // ── 1. quanto posso ripagare ──────────────────────────────────────────
  const debtLamports = borrow.amount; // base units USDC
  const maxByCloseFactor = debtLamports.mul(eligibility.closeFactor);
  const maxByMarketCap = new Decimal(
    args.market.state.maxLiquidatableDebtMarketValueAtOnce.toString(),
  ).div(pxDebt).mul(10 ** USDC_RESERVE.decimals);

  let repay = Decimal.min(maxByCloseFactor, maxByMarketCap).floor();
  if (repay.lte(0)) return { ok: false, reason: 'dust' };

  // ── 2. collaterale che ricevo ─────────────────────────────────────────
  const bonusMul = eligibility.bonusRate.add(1);
  const seizedValueUsd = repay.div(10 ** USDC_RESERVE.decimals).mul(pxDebt).mul(bonusMul);
  let usdyGross = seizedValueUsd.div(pxColl).mul(10 ** USDY_RESERVE.decimals).floor();

  // cap sul collaterale effettivamente depositato
  const depositLamports = deposit.amount;
  if (usdyGross.gt(depositLamports)) {
    usdyGross = depositLamports;
    repay = depositLamports
      .div(10 ** USDY_RESERVE.decimals).mul(pxColl)
      .div(bonusMul).div(pxDebt).mul(10 ** USDC_RESERVE.decimals).floor();
  }

  // ── 3. la reserve USDY ha abbastanza liquidità per REDIMERE? ──────────
  // Se no, la ix riesce ma ti consegna cUSDY, non USDY: lo swap poi fallisce
  // e l'intera transazione fa revert. Vedi docs/00-VERDETTO.md §4.
  const availableUsdy = collReserve.getLiquidityAvailableAmount();
  if (usdyGross.gt(availableUsdy)) return { ok: false, reason: 'no-collateral-liquidity' };

  // protocol_liquidation_fee = max(ceil(bonus_part * pct), 1) → minimo 1 lamport
  const bonusPart = usdyGross.minus(usdyGross.div(bonusMul));
  const protoFee = Decimal.max(
    bonusPart.mul(collReserve.state.config.protocolLiquidationFeePct).div(100).ceil(),
    1,
  );
  const usdyNet = usdyGross.minus(protoFee);
  if (usdyNet.lte(0)) return { ok: false, reason: 'dust' };

  // ── 4. liquidità disponibile per il flash loan ────────────────────────
  // (il controllo definitivo lo fa la simulazione; qui evitiamo tx sicuramente perse)
  const flashReserve = args.market.getReserveByAddress(FLASH_SOURCE.reserve);
  if (flashReserve && repay.gt(flashReserve.getLiquidityAvailableAmount())) {
    return { ok: false, reason: 'insufficient-flash-liquidity' };
  }

  // ── 5. quote Orca ─────────────────────────────────────────────────────
  const usdyIn = BigInt(usdyNet.toFixed(0));
  const quote = quoteUsdyToUsdc(orca, usdyIn, CFG.swapSlippageBps, args.nowSeconds);

  // ρ = prezzo di mercato Orca / prezzo oracolo Scope (entrambi USDY in USDC)
  const orcaSpot = new Decimal(spotPrice(orca.pool));
  const scopeUsdyInUsdc = pxColl.div(pxDebt);
  const rho = orcaSpot.div(scopeUsdyInUsdc);
  if (rho.minus(1).abs().mul(BPS).gt(CFG.maxOracleDivergenceBps)) {
    return { ok: false, reason: 'oracle-divergence' };
  }

  // ── 6. profitto ───────────────────────────────────────────────────────
  const flashFee = repay.mul(FLASH_SOURCE.flashLoanFeeRate).ceil();
  const usdcOut = new Decimal(quote.tokenEstOut.toString());
  const usdcOutWorst = new Decimal(quote.tokenMinOut.toString());

  const toUsdc = (x: Decimal) => x.div(10 ** USDC_RESERVE.decimals);
  const expectedProfit = toUsdc(usdcOut.minus(repay).minus(flashFee)).minus(args.fixedCostUsdc);
  const worstProfit = toUsdc(usdcOutWorst.minus(repay).minus(flashFee)).minus(args.fixedCostUsdc);

  if (worstProfit.lt(CFG.minProfitUsdc)) return { ok: false, reason: 'below-min-profit' };
  const marginBps = expectedProfit.div(toUsdc(repay)).mul(BPS);
  if (marginBps.lt(CFG.minMarginBps)) return { ok: false, reason: 'below-min-margin' };

  // ── 7. guardie on-chain ───────────────────────────────────────────────
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

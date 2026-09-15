import { Decimal } from 'decimal.js';
import type { KaminoMarket, KaminoObligation, KaminoReserve } from '@kamino-finance/klend-sdk';
import type { Address } from '@solana/kit';

/**
 * Off-chain replica of `state/liquidation_operations.rs`.
 *
 * Its ONLY job is to discard non-liquidatable candidates quickly and estimate
 * the bonus. The truth stays on-chain: every plan then goes through
 * `simulateTransaction`.
 */

export type EligibilityReject =
  | 'healthy'
  | 'price-triggered-liquidation-disabled'
  | 'emergency-mode'
  | 'no-debt'
  | 'no-collateral'
  | 'borrow-factor-priority'
  | 'lowest-liquidation-ltv-priority';

export type Eligibility =
  | { ok: false; reason: EligibilityReject }
  | {
      ok: true;
      /** rate, not bps: 0.02 = 2% */
      bonusRate: Decimal;
      /** fraction of the debt repayable in one shot (effective close factor) */
      closeFactor: Decimal;
      ltv: Decimal;
      liquidationLtv: Decimal;
      noBfLtv: Decimal;
    };

/**
 * `calculate_liquidation_bonus` (klend, verified against source).
 *
 *   if noBfLtv >= 0.99 → bad-debt branch
 *   otherwise          → max(minReserveBonus, ltv - maxAllowedLtv), capped at
 *                        maxReserveBonus and at (1 - noBfLtv)
 */
export function calculateLiquidationBonus(args: {
  collMinBps: number;
  collMaxBps: number;
  collBadDebtBps: number;
  debtMinBps: number;
  debtMaxBps: number;
  debtBadDebtBps: number;
  /** e-mode cap; pass 65535 (u16::MAX) when there is no elevation group */
  emodeMaxBonusBps: number;
  ltv: Decimal;
  maxAllowedLtv: Decimal;
  noBfLtv: Decimal;
}): Decimal {
  const BAD_DEBT_LTV = new Decimal(1);
  const diffToBadDebt = Decimal.max(BAD_DEBT_LTV.minus(args.noBfLtv), 0);

  if (args.noBfLtv.gte(0.99)) {
    const badDebtBonus = new Decimal(Math.min(args.collBadDebtBps, args.debtBadDebtBps)).div(10_000);
    return args.noBfLtv.lt(BAD_DEBT_LTV) ? Decimal.max(badDebtBonus, diffToBadDebt) : badDebtBonus;
  }

  const unhealthyFactor = args.ltv.minus(args.maxAllowedLtv);
  const maxBonus = new Decimal(
    Math.min(Math.max(args.collMaxBps, args.debtMaxBps), args.emodeMaxBonusBps),
  ).div(10_000);
  const minReserveBonus = new Decimal(Math.max(args.collMinBps, args.debtMinBps)).div(10_000);

  const minBonus = Decimal.max(minReserveBonus, unhealthyFactor);
  const collared = Decimal.min(minBonus, maxBonus);
  return Decimal.min(collared, diffToBadDebt);
}

export function evaluate(
  market: KaminoMarket,
  obligation: KaminoObligation,
  debtReserve: KaminoReserve,
  collReserve: KaminoReserve,
): Eligibility {
  const m = market.state;

  if (m.emergencyMode !== 0) return { ok: false, reason: 'emergency-mode' };
  if (m.priceTriggeredLiquidationDisabled !== 0) {
    return { ok: false, reason: 'price-triggered-liquidation-disabled' };
  }

  const borrow = obligation.getBorrowByReserve(debtReserve.address as Address);
  const deposit = obligation.getDepositByReserve(collReserve.address as Address);
  if (!borrow || borrow.amount.lte(0)) return { ok: false, reason: 'no-debt' };
  if (!deposit || deposit.amount.lte(0)) return { ok: false, reason: 'no-collateral' };

  const ltv = obligation.loanToValue();
  const liqLtv = obligation.liquidationLtv();
  const noBfLtv = obligation.noBfLoanToValue();

  if (ltv.lt(liqLtv)) return { ok: false, reason: 'healthy' };

  // Program priority rules — violating them makes the instruction revert.
  // `highest_borrow_factor_pct` / `lowest_reserve_deposit_liquidation_ltv` are
  // maintained by the program on the obligation; we recompute them from the
  // positions.
  let highestBorrowFactorPct = 0;
  for (const r of obligation.getBorrowReserves()) {
    const res = market.getReserveByAddress(r);
    if (res) highestBorrowFactorPct = Math.max(highestBorrowFactorPct, Number(res.state.config.borrowFactorPct));
  }
  if (Number(debtReserve.state.config.borrowFactorPct) < highestBorrowFactorPct) {
    return { ok: false, reason: 'borrow-factor-priority' };
  }

  let lowestLiqLtvPct = Number.POSITIVE_INFINITY;
  for (const r of obligation.getDepositReserves()) {
    const res = market.getReserveByAddress(r);
    if (res) lowestLiqLtvPct = Math.min(lowestLiqLtvPct, res.state.config.liquidationThresholdPct);
  }
  if (collReserve.state.config.liquidationThresholdPct > lowestLiqLtvPct) {
    return { ok: false, reason: 'lowest-liquidation-ltv-priority' };
  }

  const bonusRate = calculateLiquidationBonus({
    collMinBps: collReserve.state.config.minLiquidationBonusBps,
    collMaxBps: collReserve.state.config.maxLiquidationBonusBps,
    collBadDebtBps: collReserve.state.config.badDebtLiquidationBonusBps,
    debtMinBps: debtReserve.state.config.minLiquidationBonusBps,
    debtMaxBps: debtReserve.state.config.maxLiquidationBonusBps,
    debtBadDebtBps: debtReserve.state.config.badDebtLiquidationBonusBps,
    emodeMaxBonusBps: 65535,
    ltv,
    maxAllowedLtv: liqLtv,
    noBfLtv,
  });

  // `max_liquidatable_borrowed_amount`: close factor is 100% above the insolvency threshold
  const closeFactor = ltv.gt(new Decimal(m.insolvencyRiskUnhealthyLtvPct).div(100))
    ? new Decimal(1)
    : new Decimal(m.liquidationMaxDebtCloseFactorPct).div(100);

  return { ok: true, bonusRate, closeFactor, ltv, liquidationLtv: liqLtv, noBfLtv };
}

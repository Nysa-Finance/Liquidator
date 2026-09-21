import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { calculateLiquidationBonus } from '../src/eligibility.js';
import { buildPlan } from '../src/profit.js';
import { Ledger, settlementFromMeta } from '../src/execute.js';
import { validateConfig } from '../src/config.js';
import { USDC_RESERVE, USDY_RESERVE } from '../src/config.js';
import { decodeWhirlpoolData, orcaContextFromAccounts } from '../src/build/orca.js';
import { loadWorld } from './world.js';
import { ORCA_POOL } from '../src/config.js';

/**
 * The decision layer, tested directly.
 *
 * The end-to-end test builds its plan by hand, so nothing exercised buildPlan or
 * the bonus rules until now — which is exactly how the swap was sized on the
 * estimate rather than the guaranteed minimum without anyone noticing.
 *
 * Only the Orca context is real, loaded from the local fork; market, reserves
 * and obligation are the smallest stubs that satisfy the reads buildPlan makes.
 */

const USDY_PX = new Decimal(1.1435);
const USDC_PX = new Decimal(1);

async function realOrcaContext() {
  const world = await loadWorld();
  const acc = world.svm.getAccount(ORCA_POOL.address);
  assert.ok(acc && 'data' in acc && acc.data, 'Orca pool missing from fixtures');
  const pool = decodeWhirlpoolData(acc.data as Uint8Array);
  const probe = await orcaContextFromAccounts({ pool, tickArrayData: [null, null, null], slot: world.slot });
  return orcaContextFromAccounts({
    pool,
    tickArrayData: probe.tickArrays.map((a) => {
      const t = world.svm.getAccount(a);
      const d = t && 'data' in t ? (t.data as Uint8Array) : null;
      return d && d.length > 0 ? d : null;
    }),
    slot: world.slot,
  });
}

/** Minimal stand-ins for the five fields buildPlan actually reads. */
function stubs(opts: { debtUsdc: number; depositUsdy: number; closeFactor: number; minFullLiq: number }) {
  const debt = new Decimal(opts.debtUsdc).mul(1e6);
  const deposit = new Decimal(opts.depositUsdy).mul(1e6);
  return {
    market: {
      state: {
        maxLiquidatableDebtMarketValueAtOnce: 30_000,
        minFullLiquidationValueThreshold: opts.minFullLiq,
      },
    },
    obligation: {
      obligationAddress: 'ob1',
      getBorrowByReserve: () => ({ amount: debt }),
      getDepositByReserve: () => ({ amount: deposit }),
    },
    debtReserve: { address: USDC_RESERVE.address, getOracleMarketPrice: () => USDC_PX },
    collReserve: {
      address: USDY_RESERVE.address,
      getOracleMarketPrice: () => USDY_PX,
      getLiquidityAvailableAmount: () => new Decimal(1e12),
      state: { config: { protocolLiquidationFeePct: 0 } },
    },
    eligibility: { bonusRate: new Decimal(0.02), closeFactor: new Decimal(opts.closeFactor) },
  };
}

// ── the bonus rules ────────────────────────────────────────────────────────

test('the solvency cap holds the bonus down once LTV approaches 100%', () => {
  const args = {
    collMinBps: 200, collMaxBps: 500, collBadDebtBps: 10,
    debtMinBps: 200, debtMaxBps: 500, debtBadDebtBps: 10,
    emodeMaxBonusBps: 65535,
    maxAllowedLtv: new Decimal(0.95),
  };
  const at = (ltv: number) =>
    calculateLiquidationBonus({ ...args, ltv: new Decimal(ltv), noBfLtv: new Decimal(ltv) })
      .mul(10_000).toNumber();

  // flat at the 200 bps floor while the cap is still loose
  assert.equal(at(0.95), 200);
  assert.equal(at(0.97), 200);
  assert.equal(at(0.98), 200);
  // 1 - noBfLtv starts biting before the growth term ever reaches 500 bps
  assert.ok(at(0.985) < 200 && at(0.985) > 100, `expected ~150 bps, got ${at(0.985)}`);
  // the documented 500 bps ceiling is unreachable at a 95% threshold
  for (const ltv of [0.95, 0.96, 0.97, 0.98, 0.985]) {
    assert.ok(at(ltv) <= 500, `bonus exceeded its cap at ltv ${ltv}`);
  }
});

test('the bad-debt branch takes over above 99% and collapses the bonus', () => {
  const b = calculateLiquidationBonus({
    collMinBps: 200, collMaxBps: 500, collBadDebtBps: 10,
    debtMinBps: 200, debtMaxBps: 500, debtBadDebtBps: 10,
    emodeMaxBonusBps: 65535,
    ltv: new Decimal(0.995), noBfLtv: new Decimal(0.995), maxAllowedLtv: new Decimal(0.95),
  }).mul(10_000).toNumber();
  assert.ok(b > 0 && b <= 50, `expected a collapsed bonus near 50 bps, got ${b}`);
});

// ── the planner ────────────────────────────────────────────────────────────

test('the swap is sized on the guaranteed minimum, never on the estimate', async () => {
  const orca = await realOrcaContext();
  const res = buildPlan({
    ...stubs({ debtUsdc: 20_000, depositUsdy: 20_000, closeFactor: 0.25, minFullLiq: 100 }),
    orca, slot: 1n, nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    fixedCostUsdc: new Decimal(0.01), flashAvailable: new Decimal(1e13),
  } as never);

  assert.ok(res.ok, `plan rejected: ${res.ok === false ? res.reason : ''}`);
  // klend guarantees minReceivedUsdy and may deliver more; spending more than
  // the guarantee is what reverts the whole transaction.
  assert.ok(
    res.plan.expectedUsdyOut <= res.plan.minReceivedUsdy,
    `swap spends ${res.plan.expectedUsdyOut} but only ${res.plan.minReceivedUsdy} is guaranteed`,
  );
});

test('the close factor caps a normal repayment', async () => {
  const orca = await realOrcaContext();
  const res = buildPlan({
    ...stubs({ debtUsdc: 20_000, depositUsdy: 20_000, closeFactor: 0.25, minFullLiq: 100 }),
    orca, slot: 1n, nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    fixedCostUsdc: new Decimal(0.01), flashAvailable: new Decimal(1e13),
  } as never);
  assert.ok(res.ok);
  assert.equal(res.plan.repayAmount, 5_000_000_000n, '25% of a 20,000 USDC debt');
});

test('below min_full_liquidation_value_threshold the whole debt is repaid', async () => {
  const orca = await realOrcaContext();
  // $80 of debt, under the market's $100 floor: klend refuses a partial
  // repayment with RepayTooSmallForFullLiquidation, so the close factor must
  // not apply.
  //
  // The profit floor is dropped here because it would reject this plan on its
  // own — $80 at a 2% bonus grosses about $1.60. Which is the real lesson of
  // this branch: a forced full liquidation of a sub-$100 debt is rarely worth
  // taking, and the default MIN_PROFIT_USDC=2 already declines it.
  const saved = process.env.MIN_PROFIT_USDC;
  process.env.MIN_PROFIT_USDC = '0';
  try {
    const res = buildPlan({
      ...stubs({ debtUsdc: 80, depositUsdy: 200, closeFactor: 0.25, minFullLiq: 100 }),
      orca, slot: 1n, nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
      fixedCostUsdc: new Decimal(0), flashAvailable: new Decimal(1e13),
    } as never);
    assert.ok(res.ok, `plan rejected: ${res.ok === false ? res.reason : ''}`);
    assert.equal(res.plan.repayAmount, 80_000_000n, 'the full debt, not 25% of it');
  } finally {
    if (saved === undefined) delete process.env.MIN_PROFIT_USDC;
    else process.env.MIN_PROFIT_USDC = saved;
  }
});

test('the default profit floor declines a forced full liquidation that is too small', async () => {
  const orca = await realOrcaContext();
  const res = buildPlan({
    ...stubs({ debtUsdc: 80, depositUsdy: 200, closeFactor: 0.25, minFullLiq: 100 }),
    orca, slot: 1n, nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    fixedCostUsdc: new Decimal(0), flashAvailable: new Decimal(1e13),
  } as never);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, 'below-min-profit');
});

test('the 30,000 USD per-liquidation cap binds on a large debt', async () => {
  const orca = await realOrcaContext();
  const res = buildPlan({
    ...stubs({ debtUsdc: 1_000_000, depositUsdy: 1_000_000, closeFactor: 0.25, minFullLiq: 100 }),
    orca, slot: 1n, nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    fixedCostUsdc: new Decimal(0.01), flashAvailable: new Decimal(1e13),
  } as never);
  assert.ok(res.ok);
  // 25% would be 250,000 USDC; the market cap is 30,000
  assert.equal(res.plan.repayAmount, 30_000_000_000n);
});

test('a plan is refused when the flash source cannot fund the repayment', async () => {
  const orca = await realOrcaContext();
  const res = buildPlan({
    ...stubs({ debtUsdc: 20_000, depositUsdy: 20_000, closeFactor: 0.25, minFullLiq: 100 }),
    orca, slot: 1n, nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    fixedCostUsdc: new Decimal(0.01),
    flashAvailable: new Decimal(1_000_000), // 1 USDC against a 5,000 USDC repayment
  } as never);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, 'insufficient-flash-liquidity');
});

// ── the configuration guard ────────────────────────────────────────────────

test('an unparsable threshold stops the bot instead of disarming the guard', () => {
  const saved = process.env.MIN_PROFIT_USDC;
  try {
    // exactly what systemd hands over when .env carries a trailing comment
    process.env.MIN_PROFIT_USDC = '2.0   # minimum worst-case profit';
    assert.throws(() => validateConfig(), /not a number/);
  } finally {
    if (saved === undefined) delete process.env.MIN_PROFIT_USDC;
    else process.env.MIN_PROFIT_USDC = saved;
  }
});

test('a haircut that would outgrow the bonus is refused', () => {
  const saved = process.env.LIQ_SLIPPAGE_BPS;
  try {
    process.env.LIQ_SLIPPAGE_BPS = '300';
    assert.throws(() => validateConfig(), /could not repay the flash loan/);
  } finally {
    if (saved === undefined) delete process.env.LIQ_SLIPPAGE_BPS;
    else process.env.LIQ_SLIPPAGE_BPS = saved;
  }
});

// ── settlement accounting ──────────────────────────────────────────────────

test('the settlement is read from owner and mint, not from account order', () => {
  const owner = 'Liq11111111111111111111111111111111111111' as never;
  const usdc = USDC_RESERVE.liquidityMint;
  const other = 'Someone1111111111111111111111111111111111' as never;

  // Deliberately noisy: another wallet's USDC, and our own USDY, both sitting
  // ahead of the entry that matters. A v0 transaction compressed with a lookup
  // table resolves account indices through loadedAddresses, so anything keyed
  // on position would read one of these instead.
  const settled = settlementFromMeta(
    {
      fee: 5_000n,
      preTokenBalances: [
        { accountIndex: 0, mint: usdc, owner: other, uiTokenAmount: { amount: '999999' } },
        { accountIndex: 1, mint: USDY_RESERVE.liquidityMint, owner, uiTokenAmount: { amount: '4000' } },
        { accountIndex: 2, mint: usdc, owner, uiTokenAmount: { amount: '1000000' } },
      ],
      postTokenBalances: [
        { accountIndex: 0, mint: usdc, owner: other, uiTokenAmount: { amount: '111111' } },
        { accountIndex: 1, mint: USDY_RESERVE.liquidityMint, owner, uiTokenAmount: { amount: '245192' } },
        { accountIndex: 2, mint: usdc, owner, uiTokenAmount: { amount: '1318621' } },
      ],
    } as never,
    owner,
    usdc,
  );

  assert.ok(settled);
  assert.equal(settled.usdcDelta, 318_621n, 'the USDC gain on our own account');
  assert.equal(settled.feeLamports, 5_000n);
});

test('an account absent from the balances reads as no movement, not as a crash', () => {
  const settled = settlementFromMeta(
    { fee: 5_000n, preTokenBalances: [], postTokenBalances: [] } as never,
    'Liq11111111111111111111111111111111111111' as never,
    USDC_RESERVE.liquidityMint,
  );
  assert.ok(settled);
  assert.equal(settled.usdcDelta, 0n);
});

test('the ledger separates what was earned from what was burned losing', () => {
  const ledger = new Ledger();
  ledger.win({ usdcDelta: 318_621n, feeLamports: 5_000n });
  ledger.win({ usdcDelta: 120_000n, feeLamports: 5_000n });
  ledger.loss(5_000n);
  ledger.loss(5_000n);
  ledger.loss(5_000n);

  const s = ledger.summary();
  assert.equal(s.usdcEarned.toFixed(6), '0.438621');
  assert.equal(s.solSpent.toFixed(9), '0.000025000', 'every attempt paid, won or lost');
  assert.equal(s.won, 2);
  assert.equal(s.lost, 3);
  assert.equal(s.landedRate.toFixed(2), '0.40', 'the number that says whether this is worth running');
});

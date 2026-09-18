import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, type Address } from '@solana/kit';
import { Obligation, Reserve, LendingMarket } from '@kamino-finance/klend-sdk';
import {
  KLEND_PROGRAM,
  ORCA_POOL,
  TARGET_MARKET,
  USDC_RESERVE,
  USDY_RESERVE,
  FLASH_SOURCE,
  CFG,
} from '../src/config.js';
import {
  OBLIGATION_ACCOUNT_SIZE,
  OBLIGATION_OFFSETS,
  scanObligationHealth,
  scopePrice,
  sfToUsd,
  type HealthRow,
} from '../src/scanner.js';
import { loadOrcaContext, quoteUsdyToUsdc, spotPrice } from '../src/build/orca.js';
import { createReadOnlyRpc, WriteAttemptError } from '../src/readonly.js';

/**
 * READ-ONLY tests against real mainnet.
 *
 * No key, no signature, nothing submitted: the RPC client refuses any method
 * that is not a read, up front (see tests/readonly-rpc.ts). They run against an
 * ACTIVE market (Kamino's Main Market by default) because the project's target
 * market is still empty.
 *
 *   npm run test:live
 *   RPC=https://... LIVE_MARKET=<pubkey> npm run test:live
 */

const rpc = createReadOnlyRpc(process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com');
const market = address(process.env.LIVE_MARKET ?? '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);

async function accountData(pk: Address): Promise<Buffer> {
  const r = await rpc.getAccountInfo(pk, { encoding: 'base64' }).send();
  assert.ok(r.value, `account ${pk} does not exist`);
  return Buffer.from((r.value.data as [string, string])[0], 'base64');
}

// ─────────────────────────────────────────────────────────────────────────────

test('the client really is read-only: a submission is blocked before it leaves', async () => {
  await assert.rejects(
    () => rpc.sendTransaction('AA' as never, { encoding: 'base64' }).send(),
    (e: unknown) => e instanceof WriteAttemptError,
    'sendTransaction should have been rejected by the transport',
  );
});

test('the prefilter offsets match the official decoder', async () => {
  // If Kamino changes the Obligation struct, this test fails instead of
  // letting wrong numbers through the scanner.
  const list = await rpc
    .getProgramAccounts(KLEND_PROGRAM, {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: BigInt(OBLIGATION_ACCOUNT_SIZE) },
        { memcmp: { offset: 32n, bytes: market as never, encoding: 'base58' } },
      ],
    })
    .send();
  const all = list as unknown as { pubkey: Address }[];
  assert.ok(all.length > 0, `no obligations in market ${market}`);

  const sample = await rpc
    .getMultipleAccounts(all.slice(0, 40).map((a) => a.pubkey), { encoding: 'base64' })
    .send();

  let checked = 0;
  for (const acc of sample.value) {
    if (!acc) continue;
    const b = Buffer.from((acc.data as [string, string])[0], 'base64');
    const o = Obligation.decode(b);
    if (BigInt(o.depositedValueSf.toString()) === 0n) continue;

    assert.equal(u128(b, OBLIGATION_OFFSETS.depositedValueSf), BigInt(o.depositedValueSf.toString()));
    assert.equal(
      u128(b, OBLIGATION_OFFSETS.borrowFactorAdjustedDebtValueSf),
      BigInt(o.borrowFactorAdjustedDebtValueSf.toString()),
    );
    assert.equal(
      u128(b, OBLIGATION_OFFSETS.allowedBorrowValueSf),
      BigInt(o.allowedBorrowValueSf.toString()),
    );
    assert.equal(
      u128(b, OBLIGATION_OFFSETS.unhealthyBorrowValueSf),
      BigInt(o.unhealthyBorrowValueSf.toString()),
    );
    checked += 1;
    if (checked >= 5) break;
  }
  assert.ok(checked >= 1, 'no obligation with a deposited value: unusable sample');
  console.log(`    offsets verified against ${checked} real obligations`);
});

test('health prefilter across every obligation of the active market', async (t) => {
  const t0 = Date.now();
  const { rows } = await scanObligationHealth(rpc, market);
  const ms = Date.now() - t0;

  assert.ok(rows.length > 0, 'no obligation carries debt');

  const overThreshold = rows.filter((r) => r.healthRatio >= 1);
  const atRisk = rows.filter((r) => r.healthRatio >= 0.95 && r.healthRatio < 1);

  console.log(`    ${rows.length} obligations with debt in ${ms} ms (a single RPC call)`);
  console.log(`    above threshold: ${overThreshold.length}   at risk (95-100%): ${atRisk.length}`);

  const fmt = (r: HealthRow) =>
    `${r.obligation}  health ${(r.healthRatio * 100).toFixed(1)}%  debt $${sfToUsd(r.debtValueSf).toFixed(2)}`;

  // Without a debt floor the ranking is dominated by closed or dust positions,
  // whose aggregate values stayed frozen at their last refresh.
  console.log('    top 5 WITHOUT a debt filter:');
  for (const r of rows.slice(0, 5)) console.log(`      ${fmt(r)}`);

  const real = rows.filter((r) => sfToUsd(r.debtValueSf) >= 100);
  const realOver = real.filter((r) => r.healthRatio >= 1);
  console.log(`    with debt >= $100: ${real.length}   of which above threshold: ${realOver.length}`);
  console.log('    top 5 real candidates:');
  for (const r of real.slice(0, 5)) console.log(`      ${fmt(r)}`);

  // The prefilter reads the LAST state saved on-chain, not current prices:
  // it is a candidate list, not a certainty. Here we only check consistency.
  for (const r of rows.slice(0, 50)) {
    assert.ok(r.debtValueSf > 0n && r.unhealthyBorrowValueSf > 0n);
    assert.ok(Number.isFinite(r.healthRatio) && r.healthRatio > 0);
  }
  t.diagnostic(`sorted descending: ${rows[0]!.healthRatio >= rows.at(-1)!.healthRatio}`);
});

test('the top candidates decode and the numbers add up', async () => {
  const { rows } = await scanObligationHealth(rpc, market, KLEND_PROGRAM, { minDebtUsd: 100 });
  const top = rows.slice(0, 10);
  const accs = await rpc
    .getMultipleAccounts(top.map((r) => r.obligation), { encoding: 'base64' })
    .send();

  let verified = 0;
  for (const [i, acc] of accs.value.entries()) {
    if (!acc) continue;
    const o = Obligation.decode(Buffer.from((acc.data as [string, string])[0], 'base64'));
    const row = top[i]!;

    const dv = Number(o.depositedValueSf.toString());
    const bf = Number(o.borrowFactorAdjustedDebtValueSf.toString());
    const uh = Number(o.unhealthyBorrowValueSf.toString());
    if (dv === 0) continue;

    // the prefilter ratio must match LTV / threshold computed from the decode
    const expected = bf / dv / (uh / dv);
    assert.ok(
      Math.abs(expected - row.healthRatio) < 1e-9,
      `health mismatch on ${row.obligation}: ${expected} vs ${row.healthRatio}`,
    );

    const nDeposits = o.deposits.filter((d) => BigInt(d.depositedAmount.toString()) > 0n).length;
    const nBorrows = o.borrows.filter((b) => BigInt(b.borrowedAmountSf.toString()) > 0n).length;
    console.log(
      `    ${row.obligation}  LTV ${((bf / dv) * 100).toFixed(2)}%  threshold ${((uh / dv) * 100).toFixed(2)}%  ` +
        `deposits ${nDeposits}  borrows ${nBorrows}`,
    );
    verified += 1;
  }
  assert.ok(verified > 0, 'no candidate decoded');
});

test('the constants in src/config.ts still match on-chain state', async () => {
  const m = LendingMarket.decode(await accountData(TARGET_MARKET.address));
  assert.equal(m.liquidationMaxDebtCloseFactorPct, TARGET_MARKET.liquidationMaxDebtCloseFactorPct);
  assert.equal(m.insolvencyRiskUnhealthyLtvPct, TARGET_MARKET.insolvencyRiskUnhealthyLtvPct);
  assert.equal(
    String(m.permissioningAuthority) === '11111111111111111111111111111111',
    !TARGET_MARKET.isPermissioned,
    'the market became permissioned: liquidation would require an extra signer',
  );

  const usdy = Reserve.decode(await accountData(USDY_RESERVE.address));
  assert.equal(usdy.config.liquidationThresholdPct, USDY_RESERVE.liquidationThresholdPct);
  assert.equal(usdy.config.minLiquidationBonusBps, USDY_RESERVE.minLiquidationBonusBps);
  assert.equal(usdy.config.maxLiquidationBonusBps, USDY_RESERVE.maxLiquidationBonusBps);
  assert.equal(usdy.config.protocolLiquidationFeePct, USDY_RESERVE.protocolLiquidationFeePct);
  assert.equal(String(usdy.liquidity.supplyVault), USDY_RESERVE.supplyVault);
  assert.equal(String(usdy.collateral.mintPubkey), USDY_RESERVE.collateralMint);

  const usdc = Reserve.decode(await accountData(USDC_RESERVE.address));
  assert.equal(String(usdc.liquidity.supplyVault), USDC_RESERVE.supplyVault);

  const flash = Reserve.decode(await accountData(FLASH_SOURCE.reserve));
  const feeSf = BigInt(flash.config.fees.flashLoanFeeSf.toString());
  assert.notEqual(feeSf, 2n ** 64n - 1n, 'flash loans are DISABLED on the source reserve');
  const rate = Number(feeSf) / 2 ** 60;
  assert.ok(
    Math.abs(rate - FLASH_SOURCE.flashLoanFeeRate) < 1e-12,
    `flash loan fee changed: ${rate} vs ${FLASH_SOURCE.flashLoanFeeRate}`,
  );
  console.log(
    `    flash loan liquidity available: ${(Number(flash.liquidity.totalAvailableAmount) / 1e6).toFixed(0)} USDC`,
  );
});

test('live Orca quote and oracle divergence check', async () => {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const ctx = await loadOrcaContext(rpc, slot);
  const spot = spotPrice(ctx.pool);

  const q = quoteUsdyToUsdc(ctx, 10_000_000_000n, CFG.swapSlippageBps, BigInt(Math.floor(Date.now() / 1000)));
  const avg = Number(q.tokenEstOut) / Number(q.tokenIn);
  console.log(
    `    10.000 USDY → ${(Number(q.tokenEstOut) / 1e6).toFixed(2)} USDC  ` +
      `(spot ${spot.toFixed(6)}, avg ${avg.toFixed(6)}, impact ${(((avg / spot) - 1) * 100).toFixed(4)}%)`,
  );
  assert.ok(q.tokenEstOut > 0n);
  assert.ok(avg <= spot, 'the average price cannot exceed spot when selling A→B');

  // The price Kamino would use for USDY, and the ratio the bot guards on.
  // Its VALUE is a property of the market, not of this code, so it is reported
  // here and asserted in tests/market-ready.test.ts.
  // index 3 is the Scope entry the USDY reserve is configured to read
  const scopeUsdy = scopePrice(await accountData(TARGET_MARKET.scopePrices), 3).price;
  const rho = spot / scopeUsdy;
  const divergenceBps = Math.abs(rho - 1) * 10_000;
  console.log(
    `    Scope USDY ${scopeUsdy} → rho ${rho.toExponential(3)} ` +
      `(${divergenceBps.toFixed(0)} bps vs a ${CFG.maxOracleDivergenceBps} bps limit) → ` +
      `${divergenceBps > CFG.maxOracleDivergenceBps ? 'plan REJECTED' : 'plan accepted'}`,
  );
  assert.ok(Number.isFinite(rho) && rho > 0, 'the divergence ratio is not computable');
});

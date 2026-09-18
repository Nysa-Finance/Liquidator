import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import { LendingMarket, Reserve } from '@kamino-finance/klend-sdk';
import { CFG, TARGET_MARKET, USDC_RESERVE, USDY_RESERVE } from '../src/config.js';
import { createReadOnlyRpc } from '../src/readonly.js';
import { scanObligationHealth, scopePrice, sfToUsd } from '../src/scanner.js';
import { loadOrcaContext, spotPrice } from '../src/build/orca.js';

/**
 * The go-live gate for the target market.
 *
 * Every other suite asserts that OUR CODE is correct and stays green whatever
 * the market is doing. This one asserts that THE MARKET is open for business,
 * and it is red until the curator finishes configuring it. Keeping the two
 * apart is the point: a red run here never means a regression in the bot.
 *
 * It is the executable form of `npm run preflight`, so it is not part of
 * `npm test` or of the CI gate.
 *
 *   npm run test:ready
 *   RPC=https://... npm run test:ready
 */

const rpc = createReadOnlyRpc(process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com');

async function data(pk: Parameters<typeof rpc.getAccountInfo>[0]): Promise<Buffer> {
  const r = await rpc.getAccountInfo(pk, { encoding: 'base64' }).send();
  assert.ok(r.value, `account ${pk} does not exist`);
  return Buffer.from((r.value.data as [string, string])[0], 'base64');
}

const NONE = '11111111111111111111111111111111';

test('the market accepts price-triggered liquidations', async () => {
  const m = LendingMarket.decode(await data(TARGET_MARKET.address));
  assert.equal(m.emergencyMode, 0, 'emergency mode is on');
  assert.equal(m.priceTriggeredLiquidationDisabled, 0, 'price-triggered liquidations are disabled');
  assert.equal(String(m.permissioningAuthority), NONE, 'the market is permissioned: liquidation needs an extra signer');
});

test('the USDY oracle reports a real price', async () => {
  const usdy = Reserve.decode(await data(USDY_RESERVE.address));
  const cfg = usdy.config.tokenInfo.scopeConfiguration;
  const idx = cfg.priceChain[0] ?? 65535;
  assert.notEqual(idx, 65535, 'no Scope index configured for USDY');

  const { price, unixTimestamp } = scopePrice(await data(address(String(cfg.priceFeed))), idx);
  const age = Math.floor(Date.now() / 1000) - Number(unixTimestamp);

  assert.ok(
    price > 0.5 && price < 5,
    `Scope index ${idx} reads ${price} USD — not a USDY price (expected ~1.14). ` +
      `Kamino points retired reserves at index 3; the real USDY price is at index 79.`,
  );
  assert.ok(
    age < Number(usdy.config.tokenInfo.maxAgePriceSeconds),
    `the price is ${age}s old, past the reserve's ${usdy.config.tokenInfo.maxAgePriceSeconds}s limit`,
  );
});

test('the reserves hold enough liquidity to work', async () => {
  const usdy = Reserve.decode(await data(USDY_RESERVE.address));
  const usdc = Reserve.decode(await data(USDC_RESERVE.address));

  const usdyAvail = Number(usdy.liquidity.totalAvailableAmount) / 1e6;
  const usdcAvail = Number(usdc.liquidity.totalAvailableAmount) / 1e6;

  // Without USDY in the vault the liquidation hands over cUSDY instead of USDY,
  // and the swap leg reverts the whole transaction.
  assert.ok(usdyAvail >= 100, `only ${usdyAvail.toFixed(2)} USDY available to redeem against`);
  assert.ok(usdcAvail >= 100, `only ${usdcAvail.toFixed(2)} USDC available to borrow`);
});

test('the builder omits no farm account the program now requires', async () => {
  const usdy = Reserve.decode(await data(USDY_RESERVE.address));
  const usdc = Reserve.decode(await data(USDC_RESERVE.address));
  // liquidateV2 passes both farm pairs as none(); that holds only while the
  // withdraw reserve has no collateral farm and the repay reserve no debt farm.
  assert.equal(String(usdy.farmCollateral), NONE, 'USDY collateral farm set — liquidateV2 would revert');
  assert.equal(String(usdc.farmDebt), NONE, 'USDC debt farm set — liquidateV2 would revert');
});

test('the oracle price and the exit price agree', async () => {
  const usdy = Reserve.decode(await data(USDY_RESERVE.address));
  const cfg = usdy.config.tokenInfo.scopeConfiguration;
  const scopeUsdy = scopePrice(await data(address(String(cfg.priceFeed))), cfg.priceChain[0] ?? 3).price;

  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const spot = spotPrice((await loadOrcaContext(rpc, slot)).pool);

  const divergenceBps = Math.abs(spot / scopeUsdy - 1) * 10_000;
  assert.ok(
    divergenceBps <= CFG.maxOracleDivergenceBps,
    `Orca ${spot.toFixed(6)} vs Scope ${scopeUsdy}: ${divergenceBps.toFixed(0)} bps apart, ` +
      `over the ${CFG.maxOracleDivergenceBps} bps limit — every plan would be rejected`,
  );
});

test('there is something to liquidate', async () => {
  const { total, rows } = await scanObligationHealth(rpc, TARGET_MARKET.address, undefined, { minDebtUsd: 10 });
  assert.ok(total > 0, 'the market has no open positions');
  assert.ok(rows.length > 0, `${total} positions, none carrying at least $10 of debt`);

  const over = rows.filter((r) => r.healthRatio >= 1);
  console.log(
    `    ${total} positions, ${rows.length} with debt >= $10, ${over.length} above threshold` +
      (rows[0] ? ` (closest: ${(rows[0].healthRatio * 100).toFixed(1)}%, $${sfToUsd(rows[0].debtValueSf).toFixed(2)})` : ''),
  );
});

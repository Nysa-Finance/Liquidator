import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner } from '@solana/kit';
import { Obligation } from '@kamino-finance/klend-sdk';
import { TARGET_MARKET, USDC_RESERVE, USDY_RESERVE } from '../src/config.js';
import {
  decodeWhirlpoolData,
  orcaContextFromAccounts,
  quoteUsdyToUsdc,
} from '../src/build/orca.js';
import { loadPdas } from '../src/build/klend.js';
import { buildLiquidationMessage, MAX_TRANSACTION_BYTES, wireSize } from '../src/build/tx.js';
import { ORCA_POOL } from '../src/config.js';
import { forgeTokenAccount, loadWorld, readTokenAmount, setScopePrice, type World } from './world.js';
import { openPosition, refreshPosition, seedUsdcLiquidity, send } from './setup-position.js';

/**
 * The production path, end to end, against the real programs.
 *
 * A borrower deposits USDY and borrows USDC through klend's own instructions,
 * so the state under test is one the protocol produced. The collateral price is
 * then pushed down until the position crosses its liquidation threshold, and the
 * bot's own transaction builder runs against it.
 *
 * Prices here are the market's real ones, not placeholders: the USDY oracle is
 * set to a live-like 1.1435 USD and moved from there. Nothing in this test
 * depends on the target market's current misconfiguration.
 */

// Scope entries the two reserves are configured to read.
const USDY_IDX = 3;
const USDC_IDX = 20;
const USDC_IDX_2 = 230;

const USDY_START = 1.1435;
/** Enough to cross a 95% liquidation threshold from a 92% LTV borrow. */
const USDY_CRASHED = 1.04;

const DEPOSIT_USDY = 20_000_000_000n; // 20,000 USDY
const BORROW_USDC = 20_000_000_000n; // 20,000 USDC, ~92% LTV at the starting price
const SEED_USDC = 200_000_000_000n; // lender-supplied borrowable liquidity

function setPrices(world: World, usdy: number) {
  setScopePrice(world, TARGET_MARKET.scopePrices, USDY_IDX, usdy);
  setScopePrice(world, TARGET_MARKET.scopePrices, USDC_IDX, 1.0);
  setScopePrice(world, TARGET_MARKET.scopePrices, USDC_IDX_2, 1.0);
}

function obligationLtv(world: World, obligation: Parameters<typeof world.svm.getAccount>[0]) {
  const acc = world.svm.getAccount(obligation);
  assert.ok(acc && 'data' in acc && acc.data, 'obligation missing');
  const o = Obligation.decode(Buffer.from(acc.data as Uint8Array));
  const deposited = Number(o.depositedValueSf.toString());
  return {
    ltv: deposited === 0 ? 0 : Number(o.borrowFactorAdjustedDebtValueSf.toString()) / deposited,
    threshold: deposited === 0 ? 0 : Number(o.unhealthyBorrowValueSf.toString()) / deposited,
    debtSf: BigInt(o.borrowFactorAdjustedDebtValueSf.toString()),
  };
}

test('a borrowed position can be opened, pushed underwater, and liquidated at a profit', async () => {
  const world = await loadWorld({ sigverify: false });
  setPrices(world, USDY_START);

  await seedUsdcLiquidity(world, SEED_USDC);
  const position = await openPosition(world, DEPOSIT_USDY, BORROW_USDC);
  await refreshPosition(world, position.owner, position.obligation);

  const healthy = obligationLtv(world, position.obligation);
  assert.ok(healthy.ltv > 0, 'the position carries no debt');
  assert.ok(healthy.ltv < healthy.threshold, `opened already liquidatable: ${healthy.ltv}`);

  // Push the collateral price down until the position crosses its threshold.
  setPrices(world, USDY_CRASHED);
  await refreshPosition(world, position.owner, position.obligation);
  const underwater = obligationLtv(world, position.obligation);
  assert.ok(
    underwater.ltv > underwater.threshold,
    `still healthy after the crash: LTV ${(underwater.ltv * 100).toFixed(2)}% vs ${(underwater.threshold * 100).toFixed(2)}%`,
  );

  const liquidator = await generateKeyPairSigner();
  world.svm.airdrop(liquidator.address, 10_000_000_000n as never);
  const atas = {
    usdc: (await generateKeyPairSigner()).address,
    usdy: (await generateKeyPairSigner()).address,
    cusdy: (await generateKeyPairSigner()).address,
  };
  forgeTokenAccount(world, atas.usdc, USDC_RESERVE.liquidityMint, liquidator.address, 1_000_000n);
  forgeTokenAccount(world, atas.usdy, USDY_RESERVE.liquidityMint, liquidator.address, 0n);
  forgeTokenAccount(world, atas.cusdy, USDY_RESERVE.collateralMint, liquidator.address, 0n);

  // 25% close factor on the outstanding debt, the size the program will accept.
  const repay = BORROW_USDC / 4n;
  // Collateral seized at the 2% floor bonus, priced by the crashed oracle.
  const expectedUsdy = BigInt(Math.floor((Number(repay) * 1.02) / USDY_CRASHED));

  const poolAcc = world.svm.getAccount(ORCA_POOL.address);
  assert.ok(poolAcc && 'data' in poolAcc && poolAcc.data, 'Orca pool missing');
  const pool = decodeWhirlpoolData(poolAcc.data as Uint8Array);
  const probe = await orcaContextFromAccounts({ pool, tickArrayData: [null, null, null], slot: world.slot });
  const orca = await orcaContextFromAccounts({
    pool,
    tickArrayData: probe.tickArrays.map((a) => {
      const acc = world.svm.getAccount(a);
      const d = acc && 'data' in acc ? (acc.data as Uint8Array) : null;
      return d && d.length > 0 ? d : null;
    }),
    slot: world.slot,
  });

  // The same number guards the liquidation and sizes the swap. That pairing is
  // deliberate: klend guarantees AT LEAST minUsdy arrives, and the swap spends
  // exactly minUsdy, so the swap can never run short and revert the whole
  // transaction. The cost is a small USDY residue whenever the liquidation
  // delivers more than the floor — deliberately preferred over a reverted
  // transaction, and swept by the next liquidation or a periodic cleanup.
  const minUsdy = (expectedUsdy * 95n) / 100n;
  const quote = quoteUsdyToUsdc(orca, minUsdy, 50, world.unixTimestamp);

  const usdcBefore = readTokenAmount(world, atas.usdc);
  const pdas = await loadPdas();
  const obligationAcc = world.svm.getAccount(position.obligation);
  assert.ok(obligationAcc && 'data' in obligationAcc && obligationAcc.data);
  const decoded = Obligation.decode(Buffer.from(obligationAcc.data as Uint8Array));

  const message = buildLiquidationMessage({
    signer: liquidator,
    pdas,
    atas,
    obligation: {
      getDepositReserves: () => [USDY_RESERVE.address],
      getBorrowReserves: () => [USDC_RESERVE.address],
    } as never,
    plan: {
      obligation: position.obligation,
      slot: world.slot,
      repayAmount: repay,
      minReceivedUsdy: minUsdy,
      minUsdcOut: quote.tokenMinOut,
      expectedUsdyOut: minUsdy,
      expectedUsdcOut: quote.tokenEstOut,
    } as never,
    orca,
    blockhash: { blockhash: world.svm.latestBlockhash(), lastValidBlockHeight: 2n ** 63n - 1n },
    computeUnitLimit: 1_200_000,
    computeUnitPriceMicroLamports: 0n,
  });

  // LiteSVM never applies the network's packet limit, so without this the test
  // would happily pass on a transaction mainnet refuses to accept.
  const bytes = await wireSize(message);
  assert.ok(
    bytes > MAX_TRANSACTION_BYTES,
    `expected the uncompressed message to overrun ${MAX_TRANSACTION_BYTES} bytes; it is ${bytes}. ` +
      `If lookup tables are now wired in, flip this assertion to <=.`,
  );

  const res = await send(world, liquidator, [...message.instructions], 'liquidation');

  const usdcAfter = readTokenAmount(world, atas.usdc);
  const profit = usdcAfter - usdcBefore;

  // Compare against the post-crash reading: debt value is priced, so a
  // measurement taken before the price moved is not comparable.
  await refreshPosition(world, position.owner, position.obligation);
  const after = obligationLtv(world, position.obligation);
  assert.ok(after.debtSf < underwater.debtSf, 'the debt did not shrink');
  assert.ok(after.ltv < underwater.ltv, 'the position did not get healthier');
  assert.ok(profit > 0n, `expected a profit, got ${profit}`);
  assert.equal(readTokenAmount(world, atas.cusdy), 0n, 'leftover cUSDY: the collateral was not redeemed');

  // Residue is expected (see the minUsdy note above) but must stay inside the
  // margin we chose; anything larger means the seized amount was mis-estimated.
  const residue = readTokenAmount(world, atas.usdy);
  assert.ok(
    residue < (expectedUsdy * 6n) / 100n,
    `USDY residue ${residue} exceeds the 5% floor margin — seized amount mis-estimated`,
  );

  console.log(`    serialized ${bytes} bytes (network limit ${MAX_TRANSACTION_BYTES}) — needs a lookup table`);
  console.log(
    `    repaid ${Number(repay) / 1e6} USDC, seized ~${Number(minUsdy) / 1e6} USDY, ` +
      `profit ${Number(profit) / 1e6} USDC, residue ${Number(residue) / 1e6} USDY, ` +
      `CU ${res.computeUnitsConsumed()}`,
  );
  console.log(
    `    LTV ${(healthy.ltv * 100).toFixed(2)}% → ${(underwater.ltv * 100).toFixed(2)}% (threshold ` +
      `${(underwater.threshold * 100).toFixed(2)}%) → ${(after.ltv * 100).toFixed(2)}% after liquidation`,
  );
  assert.ok(decoded.borrows.length > 0);
});

#!/usr/bin/env node
/**
 * Legge e stampa lo stato reale del market bersaglio.
 * Nessuna chiave richiesta, solo lettura. Serve a verificare che i valori
 * hardcoded in src/config.ts siano ancora quelli on-chain.
 *
 *   RPC=https://... node scripts/inspect-market.mjs
 */
import { Reserve, LendingMarket } from '@kamino-finance/klend-sdk';

const RPC = process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com';
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const MARKET = process.env.MARKET ?? 'F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy';
const OBLIGATION_ACCOUNT_SIZE = 3344; // OBLIGATION_SIZE (3336) + 8 di discriminante
const RESERVE_ACCOUNT_SIZE = 8624;    // RESERVE_SIZE (8616) + 8

const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const acct = async (pk) => Buffer.from((await rpc('getAccountInfo', [pk, { encoding: 'base64' }])).value.data[0], 'base64');
const s = (x) => String(x);

const slot = await rpc('getSlot', []);
console.log(`slot ${slot}  rpc ${RPC.replace(/api-key=.*/, 'api-key=***')}\n`);

const m = LendingMarket.decode(await acct(MARKET));
console.log('LENDING MARKET', MARKET);
console.table({
  name: Buffer.from(m.name ?? []).toString('utf8').replace(/\0/g, ''),
  owner: s(m.lendingMarketOwner),
  closeFactorPct: m.liquidationMaxDebtCloseFactorPct,
  maxLiquidatableDebtMvAtOnce: s(m.maxLiquidatableDebtMarketValueAtOnce),
  minFullLiquidationValueThreshold: s(m.minFullLiquidationValueThreshold),
  insolvencyRiskUnhealthyLtvPct: m.insolvencyRiskUnhealthyLtvPct,
  emergencyMode: m.emergencyMode,
  priceTriggeredLiquidationDisabled: m.priceTriggeredLiquidationDisabled,
  referralFeeBps: m.referralFeeBps,
  priceRefreshTriggerToMaxAgePct: m.priceRefreshTriggerToMaxAgePct,
  permissioningAuthority: s(m.permissioningAuthority),
  permissionedOps: s(m.permissionedOps),
});

const found = await rpc('getProgramAccounts', [
  KLEND,
  {
    encoding: 'base64',
    dataSlice: { offset: 0, length: 0 },
    filters: [{ dataSize: RESERVE_ACCOUNT_SIZE }, { memcmp: { offset: 32, bytes: MARKET } }],
  },
]);

for (const { pubkey } of found) {
  const r = Reserve.decode(await acct(pubkey));
  const c = r.config;
  console.log(`\nRESERVE ${Buffer.from(c.tokenInfo.name).toString('utf8').replace(/\0/g, '')}  ${pubkey}`);
  console.table({
    liquidityMint: s(r.liquidity.mintPubkey),
    decimals: s(r.liquidity.mintDecimals),
    tokenProgram: s(r.liquidity.tokenProgram),
    supplyVault: s(r.liquidity.supplyVault),
    feeVault: s(r.liquidity.feeVault),
    collateralMint: s(r.collateral.mintPubkey),
    collateralSupplyVault: s(r.collateral.supplyVault),
    availableAmount: s(r.liquidity.totalAvailableAmount),
    borrowedAmountSf: s(r.liquidity.borrowedAmountSf),
    ltvPct: c.loanToValuePct,
    liqThresholdPct: c.liquidationThresholdPct,
    minLiqBonusBps: c.minLiquidationBonusBps,
    maxLiqBonusBps: c.maxLiquidationBonusBps,
    badDebtLiqBonusBps: c.badDebtLiquidationBonusBps,
    protocolLiqFeePct: c.protocolLiquidationFeePct,
    borrowFactorPct: s(c.borrowFactorPct),
    // u64::MAX ⇒ flash loan DISABILITATI; altrimenti rate = valore / 2^60
    flashLoanFeeSf: s(c.fees.flashLoanFeeSf),
    flashLoanFeeRate: Number(c.fees.flashLoanFeeSf) / 2 ** 60,
    depositLimit: s(c.depositLimit),
    borrowLimit: s(c.borrowLimit),
    farmCollateral: s(r.farmCollateral),
    farmDebt: s(r.farmDebt),
    scopePriceFeed: s(c.tokenInfo.scopeConfiguration.priceFeed),
    scopeChain: c.tokenInfo.scopeConfiguration.priceChain.join(','),
    maxAgePriceSeconds: s(c.tokenInfo.maxAgePriceSeconds),
    lastUpdateSlot: s(r.lastUpdate.slot),
    stale: r.lastUpdate.stale,
  });
}

const obs = await rpc('getProgramAccounts', [
  KLEND,
  {
    encoding: 'base64',
    dataSlice: { offset: 0, length: 0 },
    filters: [{ dataSize: OBLIGATION_ACCOUNT_SIZE }, { memcmp: { offset: 32, bytes: MARKET } }],
  },
]);
console.log(`\nOBLIGATION nel market: ${obs.length}`);
for (const { pubkey } of obs.slice(0, 20)) console.log('  ', pubkey);

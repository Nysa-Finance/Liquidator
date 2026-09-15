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
  sfToUsd,
  type HealthRow,
} from '../src/scanner.js';
import { loadOrcaContext, quoteUsdyToUsdc, spotPrice } from '../src/build/orca.js';
import { createReadOnlyRpc, LIVE_MARKET, LIVE_RPC, WriteAttemptError } from './readonly-rpc.js';

/**
 * Test di SOLA LETTURA contro mainnet reale.
 *
 * Nessuna chiave, nessuna firma, nessun invio: il client RPC rifiuta a monte
 * qualunque metodo che non sia una lettura (vedi tests/readonly-rpc.ts).
 * Girano contro un market ATTIVO (di default il Main Market di Kamino) perché
 * il market bersaglio del progetto è ancora vuoto.
 *
 *   npm run test:live
 *   RPC=https://... LIVE_MARKET=<pubkey> npm run test:live
 */

const rpc = createReadOnlyRpc(LIVE_RPC);
const market = address(LIVE_MARKET);

const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);

async function accountData(pk: Address): Promise<Buffer> {
  const r = await rpc.getAccountInfo(pk, { encoding: 'base64' }).send();
  assert.ok(r.value, `account ${pk} inesistente`);
  return Buffer.from((r.value.data as [string, string])[0], 'base64');
}

// ─────────────────────────────────────────────────────────────────────────────

test('il client è davvero in sola lettura: un invio viene bloccato prima di partire', async () => {
  await assert.rejects(
    () => rpc.sendTransaction('AA' as never, { encoding: 'base64' }).send(),
    (e: unknown) => e instanceof WriteAttemptError,
    'sendTransaction doveva essere rifiutato dal transport',
  );
});

test('gli offset del prefiltro coincidono con il decoder ufficiale', async () => {
  // Se Kamino cambia la struct Obligation, questo test fallisce invece di
  // lasciar passare numeri sbagliati nello scanner.
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
  assert.ok(all.length > 0, `nessuna obligation nel market ${market}`);

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
  assert.ok(checked >= 1, 'nessuna obligation con valore depositato: campione inutilizzabile');
  console.log(`    offset verificati su ${checked} obligation reali`);
});

test('prefiltro di salute su tutte le obligation del market attivo', async (t) => {
  const t0 = Date.now();
  const rows = await scanObligationHealth(rpc, market);
  const ms = Date.now() - t0;

  assert.ok(rows.length > 0, 'nessuna obligation con debito');

  const overThreshold = rows.filter((r) => r.healthRatio >= 1);
  const atRisk = rows.filter((r) => r.healthRatio >= 0.95 && r.healthRatio < 1);

  console.log(`    ${rows.length} obligation con debito in ${ms} ms (una sola chiamata RPC)`);
  console.log(`    sopra soglia: ${overThreshold.length}   a rischio (95-100 %): ${atRisk.length}`);

  const fmt = (r: HealthRow) =>
    `${r.obligation}  salute ${(r.healthRatio * 100).toFixed(1)}%  debito $${sfToUsd(r.debtValueSf).toFixed(2)}`;

  // Senza soglia di debito la classifica è dominata da posizioni chiuse o polvere,
  // i cui valori aggregati sono rimasti congelati all'ultimo refresh.
  console.log('    primi 5 SENZA filtro sul debito:');
  for (const r of rows.slice(0, 5)) console.log(`      ${fmt(r)}`);

  const real = rows.filter((r) => sfToUsd(r.debtValueSf) >= 100);
  const realOver = real.filter((r) => r.healthRatio >= 1);
  console.log(`    con debito >= $100: ${real.length}   di cui sopra soglia: ${realOver.length}`);
  console.log('    primi 5 candidati veri:');
  for (const r of real.slice(0, 5)) console.log(`      ${fmt(r)}`);

  // Il prefiltro legge l'ULTIMO stato salvato on-chain, non i prezzi di adesso:
  // è una lista di candidati, non di certezze. Qui verifichiamo solo la coerenza.
  for (const r of rows.slice(0, 50)) {
    assert.ok(r.debtValueSf > 0n && r.unhealthyBorrowValueSf > 0n);
    assert.ok(Number.isFinite(r.healthRatio) && r.healthRatio > 0);
  }
  t.diagnostic(`ordinamento decrescente: ${rows[0]!.healthRatio >= rows.at(-1)!.healthRatio}`);
});

test('i candidati migliori decodificano e i numeri tornano', async () => {
  const rows = (await scanObligationHealth(rpc, market, KLEND_PROGRAM, { minDebtUsd: 100 })).slice(0, 10);
  const accs = await rpc
    .getMultipleAccounts(rows.map((r) => r.obligation), { encoding: 'base64' })
    .send();

  let verified = 0;
  for (const [i, acc] of accs.value.entries()) {
    if (!acc) continue;
    const o = Obligation.decode(Buffer.from((acc.data as [string, string])[0], 'base64'));
    const row = rows[i]!;

    const dv = Number(o.depositedValueSf.toString());
    const bf = Number(o.borrowFactorAdjustedDebtValueSf.toString());
    const uh = Number(o.unhealthyBorrowValueSf.toString());
    if (dv === 0) continue;

    // il rapporto del prefiltro deve coincidere con LTV / soglia calcolati dal decode
    const expected = bf / dv / (uh / dv);
    assert.ok(
      Math.abs(expected - row.healthRatio) < 1e-9,
      `salute divergente su ${row.obligation}: ${expected} vs ${row.healthRatio}`,
    );

    const nDeposits = o.deposits.filter((d) => BigInt(d.depositedAmount.toString()) > 0n).length;
    const nBorrows = o.borrows.filter((b) => BigInt(b.borrowedAmountSf.toString()) > 0n).length;
    console.log(
      `    ${row.obligation}  LTV ${((bf / dv) * 100).toFixed(2)}%  soglia ${((uh / dv) * 100).toFixed(2)}%  ` +
        `depositi ${nDeposits}  prestiti ${nBorrows}`,
    );
    verified += 1;
  }
  assert.ok(verified > 0, 'nessun candidato decodificato');
});

test('le costanti in src/config.ts corrispondono ancora allo stato on-chain', async () => {
  const m = LendingMarket.decode(await accountData(TARGET_MARKET.address));
  assert.equal(m.liquidationMaxDebtCloseFactorPct, TARGET_MARKET.liquidationMaxDebtCloseFactorPct);
  assert.equal(m.insolvencyRiskUnhealthyLtvPct, TARGET_MARKET.insolvencyRiskUnhealthyLtvPct);
  assert.equal(
    String(m.permissioningAuthority) === '11111111111111111111111111111111',
    !TARGET_MARKET.isPermissioned,
    'il market è diventato permissionato: la liquidazione richiederebbe una firma aggiuntiva',
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
  assert.notEqual(feeSf, 2n ** 64n - 1n, 'flash loan DISABILITATI sulla reserve sorgente');
  const rate = Number(feeSf) / 2 ** 60;
  assert.ok(
    Math.abs(rate - FLASH_SOURCE.flashLoanFeeRate) < 1e-12,
    `fee flash loan cambiata: ${rate} vs ${FLASH_SOURCE.flashLoanFeeRate}`,
  );
  console.log(
    `    liquidità flash loan disponibile: ${(Number(flash.liquidity.totalAvailableAmount) / 1e6).toFixed(0)} USDC`,
  );
});

test('quote Orca live e controllo di divergenza oracolo', async () => {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const ctx = await loadOrcaContext(rpc, slot);
  const spot = spotPrice(ctx.pool);

  const q = quoteUsdyToUsdc(ctx, 10_000_000_000n, CFG.swapSlippageBps, BigInt(Math.floor(Date.now() / 1000)));
  const avg = Number(q.tokenEstOut) / Number(q.tokenIn);
  console.log(
    `    10.000 USDY → ${(Number(q.tokenEstOut) / 1e6).toFixed(2)} USDC  ` +
      `(spot ${spot.toFixed(6)}, medio ${avg.toFixed(6)}, impatto ${(((avg / spot) - 1) * 100).toFixed(4)}%)`,
  );
  assert.ok(q.tokenEstOut > 0n);
  assert.ok(avg <= spot, 'il prezzo medio non può superare lo spot vendendo A→B');

  // Prezzo che Kamino userebbe per USDY: indice Scope 3 sul feed del market.
  const scope = await accountData(TARGET_MARKET.scopePrices);
  const off = 8 + 32 + 3 * 56;
  const scopeUsdy = Number(scope.readBigUInt64LE(off)) / 10 ** Number(scope.readBigUInt64LE(off + 8));
  const rho = spot / scopeUsdy;
  console.log(`    prezzo Scope (indice 3) = ${scopeUsdy}  →  ρ = ${rho.toExponential(3)}`);

  // Con la configurazione attuale ρ è assurdo: la guardia deve rifiutare il piano.
  const divergenceBps = Math.abs(rho - 1) * 10_000;
  assert.ok(
    divergenceBps > CFG.maxOracleDivergenceBps,
    'atteso che la guardia di divergenza oracolo scartasse il piano',
  );
});

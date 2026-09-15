/**
 * Verifica di prontezza prima del passaggio in produzione.
 *
 * SOLA LETTURA: usa il client con whitelist, non può firmare né inviare nulla.
 * Controlla, una per una, tutte le condizioni che devono essere vere perché il
 * bot possa funzionare sul market bersaglio, e dice quali mancano.
 *
 *   npm run preflight
 *   RPC=https://... WALLET=<pubkey> npm run preflight
 */
import { readFile } from 'node:fs/promises';
import { address, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import {
  LendingMarket,
  Reserve,
  getAssociatedTokenAddress,
} from '@kamino-finance/klend-sdk';
import {
  FLASH_SOURCE,
  KLEND_PROGRAM,
  ORCA_POOL,
  TARGET_MARKET,
  USDC_RESERVE,
  USDY_RESERVE,
} from '../src/config.js';
import { createReadOnlyRpc } from '../src/readonly.js';
import { OBLIGATION_ACCOUNT_SIZE, OBLIGATION_OFFSETS, scanObligationHealth, sfToUsd } from '../src/scanner.js';
import { loadOrcaContext, spotPrice } from '../src/build/orca.js';

const RPC = process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com';
const rpc = createReadOnlyRpc(RPC);

type Check = { ok: boolean; blocking: boolean; label: string; detail: string };
const checks: Check[] = [];
const add = (ok: boolean, blocking: boolean, label: string, detail: string) =>
  checks.push({ ok, blocking, label, detail });

async function data(pk: Address): Promise<Buffer | null> {
  const r = await rpc.getAccountInfo(pk, { encoding: 'base64' }).send();
  return r.value ? Buffer.from((r.value.data as [string, string])[0], 'base64') : null;
}

async function walletAddress(): Promise<Address | null> {
  if (process.env.WALLET) return address(process.env.WALLET);
  const path = process.env.KEYPAIR_PATH;
  if (!path) return null;
  try {
    const bytes = Uint8Array.from(JSON.parse(await readFile(path, 'utf8')) as number[]);
    const signer = await createKeyPairSignerFromBytes(bytes);
    return signer.address; // solo la parte pubblica, la privata non lascia questa funzione
  } catch {
    return null;
  }
}

async function main() {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const now = Math.floor(Date.now() / 1000);
  console.log(`preflight — slot ${slot} — ${RPC.replace(/api-key=.*/, 'api-key=***')}\n`);

  // ── 1. il market è aperto e liquidabile ──────────────────────────────────
  const mBuf = await data(TARGET_MARKET.address);
  if (!mBuf) {
    add(false, true, 'market esistente', `${TARGET_MARKET.address} non trovato`);
  } else {
    const m = LendingMarket.decode(mBuf);
    add(m.emergencyMode === 0, true, 'emergency mode spento', `emergencyMode=${m.emergencyMode}`);
    add(
      m.priceTriggeredLiquidationDisabled === 0,
      true,
      'liquidazioni da prezzo abilitate',
      `priceTriggeredLiquidationDisabled=${m.priceTriggeredLiquidationDisabled}`,
    );
    add(
      String(m.permissioningAuthority) === '11111111111111111111111111111111',
      true,
      'market non permissionato',
      `permissioningAuthority=${m.permissioningAuthority}`,
    );
    add(
      m.liquidationMaxDebtCloseFactorPct === TARGET_MARKET.liquidationMaxDebtCloseFactorPct,
      false,
      'close factor invariato',
      `on-chain ${m.liquidationMaxDebtCloseFactorPct}%, in config ${TARGET_MARKET.liquidationMaxDebtCloseFactorPct}%`,
    );
  }

  // ── 2. le reserve hanno senso economico ──────────────────────────────────
  const usdyBuf = await data(USDY_RESERVE.address);
  const usdcBuf = await data(USDC_RESERVE.address);
  if (!usdyBuf || !usdcBuf) {
    add(false, true, 'reserve caricate', 'una delle due reserve non esiste');
  } else {
    const usdy = Reserve.decode(usdyBuf);
    const usdc = Reserve.decode(usdcBuf);

    const usdyAvail = Number(usdy.liquidity.totalAvailableAmount) / 1e6;
    const usdcAvail = Number(usdc.liquidity.totalAvailableAmount) / 1e6;
    add(usdyAvail >= 100, true, 'liquidità USDY sufficiente a redimere', `${usdyAvail.toFixed(2)} USDY in cassa`);
    add(usdcAvail >= 0, false, 'liquidità USDC nel market', `${usdcAvail.toFixed(2)} USDC in cassa`);

    add(
      usdy.config.status === 0,
      true,
      'reserve USDY attiva',
      `status=${usdy.config.status} (0 = attiva)`,
    );
    add(
      usdy.config.maxLiquidationBonusBps > 0,
      true,
      'bonus di liquidazione non azzerato',
      `${usdy.config.minLiquidationBonusBps}–${usdy.config.maxLiquidationBonusBps} bps`,
    );

    // ── 3. l'oracolo dice un prezzo credibile per USDY ─────────────────────
    const feed = String(usdy.config.tokenInfo.scopeConfiguration.priceFeed) as Address;
    const idx = usdy.config.tokenInfo.scopeConfiguration.priceChain[0] ?? 65535;
    const scopeBuf = await data(feed);
    if (!scopeBuf || idx === 65535) {
      add(false, true, 'oracolo USDY configurato', `feed=${feed} chain[0]=${idx}`);
    } else {
      const o = 8 + 32 + idx * 56;
      const px = Number(scopeBuf.readBigUInt64LE(o)) / 10 ** Number(scopeBuf.readBigUInt64LE(o + 8));
      const age = now - Number(scopeBuf.readBigUInt64LE(o + 24));
      add(
        px > 0.5 && px < 5,
        true,
        'prezzo USDY dall’oracolo credibile',
        `indice Scope ${idx} → ${px} USD (atteso ~1,14)`,
      );
      add(
        age < Number(usdy.config.tokenInfo.maxAgePriceSeconds),
        true,
        'prezzo oracolo fresco',
        `${age}s di età, limite ${usdy.config.tokenInfo.maxAgePriceSeconds}s`,
      );
    }
  }

  // ── 4. esistono posizioni da liquidare ───────────────────────────────────
  const obs = await rpc
    .getProgramAccounts(KLEND_PROGRAM, {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: BigInt(OBLIGATION_ACCOUNT_SIZE) },
        { memcmp: { offset: BigInt(OBLIGATION_OFFSETS.lendingMarket), bytes: TARGET_MARKET.address as never, encoding: 'base58' } },
      ],
    })
    .send();
  const nObs = (obs as unknown as unknown[]).length;
  add(nObs > 0, true, 'il market ha posizioni aperte', `${nObs} obligation`);

  if (nObs > 0) {
    const rows = await scanObligationHealth(rpc, TARGET_MARKET.address, KLEND_PROGRAM, { minDebtUsd: 10 });
    const over = rows.filter((r) => r.healthRatio >= 1);
    add(
      rows.length > 0,
      false,
      'posizioni con debito significativo',
      `${rows.length} con debito ≥ $10, ${over.length} sopra soglia` +
        (rows[0] ? ` (migliore: ${(rows[0].healthRatio * 100).toFixed(1)}% della soglia, $${sfToUsd(rows[0].debtValueSf).toFixed(0)})` : ''),
    );
  }

  // ── 5. la sorgente del flash loan è utilizzabile ─────────────────────────
  const flashBuf = await data(FLASH_SOURCE.reserve);
  if (!flashBuf) {
    add(false, true, 'reserve del flash loan', `${FLASH_SOURCE.reserve} non trovata`);
  } else {
    const f = Reserve.decode(flashBuf);
    const feeSf = BigInt(f.config.fees.flashLoanFeeSf.toString());
    const avail = Number(f.liquidity.totalAvailableAmount) / 1e6;
    add(feeSf !== 2n ** 64n - 1n, true, 'flash loan abilitati', `flashLoanFeeSf=${feeSf}`);
    add(
      Math.abs(Number(feeSf) / 2 ** 60 - FLASH_SOURCE.flashLoanFeeRate) < 1e-12,
      false,
      'fee flash loan invariata',
      `${((Number(feeSf) / 2 ** 60) * 100).toFixed(5)}%`,
    );
    add(avail > 10_000, true, 'liquidità per il flash loan', `${avail.toFixed(0)} USDC disponibili`);
  }

  // ── 6. la via d'uscita su Orca esiste ed è sana ──────────────────────────
  try {
    const ctx = await loadOrcaContext(rpc, slot);
    const spot = spotPrice(ctx.pool);
    add(ctx.pool.liquidity > 0n, true, 'pool Orca con liquidità in range', `L=${ctx.pool.liquidity}`);
    add(spot > 0.5 && spot < 5, true, 'prezzo Orca credibile', `${spot.toFixed(6)} USDC/USDY`);
    const vaultB = await rpc.getTokenAccountBalance(ORCA_POOL.tokenVaultB).send();
    add(
      Number(vaultB.value.uiAmountString) > 50_000,
      false,
      'cassa USDC del pool profonda',
      `${Number(vaultB.value.uiAmountString).toFixed(0)} USDC`,
    );
  } catch (e) {
    add(false, true, 'pool Orca leggibile', String(e));
  }

  // ── 7. il portafoglio è pronto ───────────────────────────────────────────
  const wallet = await walletAddress();
  if (!wallet) {
    add(false, true, 'portafoglio configurato', 'imposta KEYPAIR_PATH nel .env (o WALLET=<pubkey> per il solo controllo)');
  } else {
    const lamports = await rpc.getBalance(wallet, { commitment: 'confirmed' }).send();
    const sol = Number(lamports.value) / 1e9;
    add(sol >= 0.1, true, 'SOL per commissioni e rent', `${sol.toFixed(4)} SOL su ${wallet}`);

    const atas = {
      USDC: await getAssociatedTokenAddress(USDC_RESERVE.liquidityMint, wallet, USDC_RESERVE.tokenProgram),
      USDY: await getAssociatedTokenAddress(USDY_RESERVE.liquidityMint, wallet, USDY_RESERVE.tokenProgram),
      cUSDY: await getAssociatedTokenAddress(USDY_RESERVE.collateralMint, wallet, USDY_RESERVE.tokenProgram),
    };
    for (const [name, ata] of Object.entries(atas)) {
      const acc = await data(ata as Address);
      let frozen = false;
      if (acc && acc.length >= 165) frozen = acc.readUInt8(108) === 2;
      add(acc !== null && !frozen, true, `conto ${name} esistente e non congelato`, `${ata}${frozen ? ' — CONGELATO' : acc ? '' : ' — da creare'}`);
    }
  }

  // ── 8. modalità di esecuzione ────────────────────────────────────────────
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  add(true, false, 'modalità', dryRun ? 'DRY_RUN attivo (nessun invio)' : '⚠ DRY_RUN DISATTIVO: invii reali');

  // ── stampa ───────────────────────────────────────────────────────────────
  const pad = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    const mark = c.ok ? '✅' : c.blocking ? '❌' : '⚠️ ';
    console.log(`${mark} ${c.label.padEnd(pad)}  ${c.detail}`);
  }

  const blockers = checks.filter((c) => !c.ok && c.blocking);
  const warnings = checks.filter((c) => !c.ok && !c.blocking);
  console.log();
  if (blockers.length === 0) {
    console.log(`PRONTO — nessun blocco${warnings.length ? `, ${warnings.length} avviso/i` : ''}.`);
  } else {
    console.log(`NON PRONTO — ${blockers.length} blocco/hi:`);
    for (const b of blockers) console.log(`   • ${b.label}: ${b.detail}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * Scarica da mainnet tutto ciò che serve a ricostruire il mondo in locale:
 * i programmi (.so estratti dal programdata) e gli account di stato.
 *
 * Output:
 *   fixtures/programs/<name>.so          → LiteSVM addProgramFromFile / solana-test-validator --bpf-program
 *   fixtures/accounts/<pubkey>.json      → formato CLI di Solana, usabile anche con
 *                                          solana-test-validator --account <pk> <file>
 *   fixtures/manifest.json               → indice con slot e provenienza
 *
 *   RPC=https://... node scripts/dump-fixtures.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { Reserve, LendingMarket } from '@kamino-finance/klend-sdk';

const RPC = process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com';
const OUT = new URL('../fixtures/', import.meta.url).pathname;

const PROGRAMS = {
  klend: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
  farms: 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr',
  whirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
};

const TARGET_MARKET = process.env.MARKET ?? 'F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy';
const FLASH_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const FLASH_RESERVE = 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59';
const ORCA_POOL = 'AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD';
const RESERVE_ACCOUNT_SIZE = 8624;

let calls = 0;
async function rpc(method, params) {
  calls += 1;
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}(${JSON.stringify(params).slice(0, 80)}): ${JSON.stringify(j.error)}`);
  return j.result;
}

const getAccounts = async (keys) => {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64' }]);
    r.value.forEach((v, j) => out.push([chunk[j], v]));
  }
  return out;
};

/** Il .so vive nell'account programdata; l'header UpgradeableLoaderState è 45 byte. */
async function dumpProgram(name, programId) {
  const prog = await rpc('getAccountInfo', [programId, { encoding: 'base64' }]);
  const data = Buffer.from(prog.value.data[0], 'base64');
  // ProgramData address: enum(4) + Pubkey(32) a partire da offset 4
  const programDataAddress = await rpc('getAccountInfo', [programId, { encoding: 'jsonParsed' }])
    .then((r) => r.value.data?.parsed?.info?.programData)
    .catch(() => null);
  if (!programDataAddress) throw new Error(`${name}: programData non risolto (loader non upgradeable?)`);
  const pd = await rpc('getAccountInfo', [programDataAddress, { encoding: 'base64' }]);
  // Il programdata è allocato alla dimensione massima e riempito di zeri in coda.
  // Tagliare "fino all'ultimo byte non nullo" rompe l'ELF: la tabella delle section
  // header sta in fondo e può terminare con zeri legittimi. Si calcola la lunghezza
  // vera dall'header ELF64.
  const raw = Buffer.from(pd.value.data[0], 'base64').subarray(45);
  if (raw.subarray(0, 4).toString('hex') !== '7f454c46') {
    throw new Error(`${name}: i primi byte non sono un ELF (\\x7fELF)`);
  }
  const phoff = Number(raw.readBigUInt64LE(0x20));
  const shoff = Number(raw.readBigUInt64LE(0x28));
  const phentsize = raw.readUInt16LE(0x36), phnum = raw.readUInt16LE(0x38);
  const shentsize = raw.readUInt16LE(0x3a), shnum = raw.readUInt16LE(0x3c);
  let end = Math.max(phoff + phnum * phentsize, shoff + shnum * shentsize);
  const SHT_NOBITS = 8;
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (raw.readUInt32LE(o + 4) === SHT_NOBITS) continue; // .bss non occupa spazio su file
    end = Math.max(end, Number(raw.readBigUInt64LE(o + 0x18)) + Number(raw.readBigUInt64LE(o + 0x20)));
  }
  if (end > raw.length) throw new Error(`${name}: ELF troncato (${end} > ${raw.length})`);
  const so = raw.subarray(0, end);
  await writeFile(`${OUT}programs/${name}.so`, so);
  return { programId, programDataAddress, bytes: so.length, programAccountBytes: data.length };
}

async function main() {
  await mkdir(`${OUT}programs`, { recursive: true });
  await mkdir(`${OUT}accounts`, { recursive: true });

  const slot = await rpc('getSlot', []);
  const blockTime = await rpc('getBlockTime', [slot]).catch(() => Math.floor(Date.now() / 1000));

  const manifest = { rpc: RPC.replace(/api-key=.*/, 'api-key=***'), slot, blockTime, programs: {}, accounts: [] };

  for (const [name, id] of Object.entries(PROGRAMS)) {
    manifest.programs[name] = await dumpProgram(name, id);
    console.log(`programma ${name.padEnd(10)} ${manifest.programs[name].bytes} byte`);
  }

  // ── account di stato, derivati dalle reserve invece che cablati ───────────
  const keys = new Set([TARGET_MARKET, FLASH_MARKET, ORCA_POOL]);

  const found = await rpc('getProgramAccounts', [
    PROGRAMS.klend,
    {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [{ dataSize: RESERVE_ACCOUNT_SIZE }, { memcmp: { offset: 32, bytes: TARGET_MARKET } }],
    },
  ]);
  const reserveKeys = [...found.map((a) => a.pubkey), FLASH_RESERVE];

  for (const [pk, acc] of await getAccounts(reserveKeys)) {
    if (!acc) continue;
    const r = Reserve.decode(Buffer.from(acc.data[0], 'base64'));
    for (const k of [
      pk,
      r.liquidity.mintPubkey, r.liquidity.supplyVault, r.liquidity.feeVault,
      r.collateral.mintPubkey, r.collateral.supplyVault,
      r.config.tokenInfo.scopeConfiguration.priceFeed,
    ]) keys.add(String(k));
  }

  // market authority PDA non serve (è solo un signer PDA, nessun dato)
  for (const m of [TARGET_MARKET, FLASH_MARKET]) {
    const [, acc] = (await getAccounts([m]))[0];
    if (acc) LendingMarket.decode(Buffer.from(acc.data[0], 'base64')); // validazione
  }

  // ── pool Orca: vault + tick array + oracle ────────────────────────────────
  const { WHIRLPOOL_PROGRAM_ADDRESS, decodeWhirlpool, getTickArrayAddress, getOracleAddress } =
    await import('@orca-so/whirlpools-client');
  const [, poolAcc] = (await getAccounts([ORCA_POOL]))[0];
  const pool = decodeWhirlpool({
    address: ORCA_POOL,
    data: new Uint8Array(Buffer.from(poolAcc.data[0], 'base64')),
    executable: false,
    lamports: 0n,
    programAddress: WHIRLPOOL_PROGRAM_ADDRESS,
    space: 0n,
  }).data;
  keys.add(String(pool.tokenVaultA));
  keys.add(String(pool.tokenVaultB));
  keys.add(String(pool.tokenMintA));
  keys.add(String(pool.tokenMintB));
  const span = pool.tickSpacing * 88;
  const start = Math.floor(pool.tickCurrentIndex / span) * span;
  // prendiamo un intervallo ampio: lo swap può attraversare più array del previsto
  for (let i = -4; i <= 2; i++) {
    const [ta] = await getTickArrayAddress(ORCA_POOL, start + i * span);
    keys.add(String(ta));
  }
  const [oracle] = await getOracleAddress(ORCA_POOL);
  keys.add(String(oracle));

  // ── scrittura ─────────────────────────────────────────────────────────────
  let written = 0, missing = 0;
  for (const [pk, acc] of await getAccounts([...keys])) {
    if (!acc) { missing += 1; manifest.accounts.push({ pubkey: pk, exists: false }); continue; }
    const json = {
      pubkey: pk,
      account: {
        lamports: acc.lamports,
        data: [acc.data[0], 'base64'],
        owner: acc.owner,
        executable: acc.executable,
        rentEpoch: 0,
        space: acc.space,
      },
    };
    await writeFile(`${OUT}accounts/${pk}.json`, JSON.stringify(json, null, 1));
    manifest.accounts.push({ pubkey: pk, exists: true, owner: acc.owner, space: acc.space });
    written += 1;
  }

  await writeFile(`${OUT}manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`\nslot ${slot}  blockTime ${blockTime}`);
  console.log(`account scritti: ${written}, inesistenti (normale per oracle/tick array non init): ${missing}`);
  console.log(`chiamate RPC: ${calls}`);
  console.log(`fixtures in ${OUT}`);
}

await main();

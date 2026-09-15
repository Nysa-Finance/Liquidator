import { readFile, readdir } from 'node:fs/promises';
import { LiteSVM, Clock } from 'litesvm';
import {
  address,
  getAddressCodec,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

/**
 * Mondo locale: LiteSVM caricato con i programmi e lo stato reali di mainnet,
 * scaricati da `npm run fixtures`.
 *
 * È un fork *statico*: nessuna rete, nessuna chiave con fondi, nessun invio.
 * Si possono riscrivere gli account a piacere — in particolare il feed Scope,
 * che è il modo per rendere liquidabile una posizione senza aspettare il mercato.
 */

const FIX = new URL('../fixtures/', import.meta.url).pathname;

export type Manifest = {
  slot: number;
  blockTime: number;
  programs: Record<string, { programId: string; bytes: number }>;
  accounts: { pubkey: string; exists: boolean; owner?: string; space?: number }[];
};

export type World = {
  svm: LiteSVM;
  manifest: Manifest;
  /** slot e timestamp correnti del mondo simulato */
  slot: bigint;
  unixTimestamp: bigint;
};

export async function loadWorld(opts: { sigverify?: boolean } = {}): Promise<World> {
  const manifest: Manifest = JSON.parse(await readFile(`${FIX}manifest.json`, 'utf8'));

  let svm = new LiteSVM().withBuiltins().withSysvars().withPrecompiles().withDefaultPrograms();
  svm = opts.sigverify === false ? svm.withSigverify(false) : svm;

  for (const [name, p] of Object.entries(manifest.programs)) {
    svm.addProgram(address(p.programId), new Uint8Array(await readFile(`${FIX}programs/${name}.so`)));
  }

  for (const f of await readdir(`${FIX}accounts`)) {
    if (!f.endsWith('.json')) continue;
    const { pubkey, account } = JSON.parse(await readFile(`${FIX}accounts/${f}`, 'utf8'));
    svm.setAccount({
      address: address(pubkey),
      lamports: BigInt(account.lamports),
      data: new Uint8Array(Buffer.from(account.data[0], 'base64')),
      programAddress: address(account.owner),
      executable: account.executable,
      space: BigInt(account.space ?? 0),
    } as never);
  }

  const world: World = {
    svm,
    manifest,
    slot: BigInt(manifest.slot),
    unixTimestamp: BigInt(manifest.blockTime),
  };
  setClock(world, world.slot, world.unixTimestamp);
  return world;
}

/** Allinea Clock e slot: klend controlla sia lo slot (staleness) sia il timestamp (età prezzo). */
export function setClock(world: World, slot: bigint, unixTimestamp: bigint): void {
  world.svm.warpToSlot(slot);
  world.svm.setClock(new Clock(slot, 0n, slot / 432_000n, slot / 432_000n, unixTimestamp));
  world.slot = slot;
  world.unixTimestamp = unixTimestamp;
}

/** Avanza il mondo di `slots` slot (≈400 ms ciascuno). */
export function advance(world: World, slots: bigint): void {
  setClock(world, world.slot + slots, world.unixTimestamp + (slots * 4n) / 10n);
}

// ── Scope ───────────────────────────────────────────────────────────────────
// OraclePrices = discriminante(8) + oracle_mappings: Pubkey(32) + prices: [DatedPrice; 512]
// DatedPrice   = { value: u64, exp: u64, last_updated_slot: u64, unix_timestamp: u64,
//                  generic_data: [u8; 24] }   →  56 byte
// klend legge questo account DIRETTAMENTE (nessuna CPI a Scope): verifica solo che
// l'indirizzo coincida con reserve.config.tokenInfo.scopeConfiguration.priceFeed.
// Riscrivere questi byte è quindi il modo per muovere i prezzi nel mondo locale.
const SCOPE_PREFIX = 8 + 32;
const DATED_PRICE_SIZE = 56;

export function scopeEntryOffset(index: number): number {
  return SCOPE_PREFIX + index * DATED_PRICE_SIZE;
}

export function readScopePrice(world: World, feed: Address, index: number) {
  const acc = world.svm.getAccount(feed);
  if (!acc || !('data' in acc) || !acc.data) throw new Error(`feed Scope ${feed} assente`);
  const b = Buffer.from(acc.data as Uint8Array);
  const o = scopeEntryOffset(index);
  const value = b.readBigUInt64LE(o);
  const exp = b.readBigUInt64LE(o + 8);
  return {
    value,
    exp,
    lastUpdatedSlot: b.readBigUInt64LE(o + 16),
    unixTimestamp: b.readBigUInt64LE(o + 24),
    price: Number(value) / 10 ** Number(exp),
  };
}

/**
 * Riscrive un prezzo Scope e lo timbra allo slot/timestamp correnti del mondo,
 * così `max_age_price_seconds` è soddisfatto.
 */
export function setScopePrice(world: World, feed: Address, index: number, price: number, exp = 8): void {
  const acc = world.svm.getAccount(feed);
  if (!acc || !('data' in acc) || !acc.data) throw new Error(`feed Scope ${feed} assente`);
  const b = Buffer.from(acc.data as Uint8Array);
  const o = scopeEntryOffset(index);
  b.writeBigUInt64LE(BigInt(Math.round(price * 10 ** exp)), o);
  b.writeBigUInt64LE(BigInt(exp), o + 8);
  b.writeBigUInt64LE(world.slot, o + 16);
  b.writeBigUInt64LE(world.unixTimestamp, o + 24);
  world.svm.setAccount({
    address: feed,
    lamports: (acc as { lamports: bigint }).lamports,
    data: new Uint8Array(b),
    programAddress: (acc as { programAddress: Address }).programAddress,
    executable: false,
    space: BigInt(b.length),
  } as never);
}

/** Ritimbra un prezzo esistente senza cambiarne il valore (per far scadere / rinfrescare l'età). */
export function touchScopePrice(world: World, feed: Address, index: number): void {
  const cur = readScopePrice(world, feed, index);
  setScopePrice(world, feed, index, cur.price, Number(cur.exp));
}

// ── Token account forgiati ──────────────────────────────────────────────────
// Un SPL token account è 165 byte: mint(32) owner(32) amount(u64) delegate(36)
// state(1) isNative(12) delegatedAmount(u64) closeAuthority(36).
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export function forgeTokenAccount(
  world: World,
  ata: Address,
  mint: Address,
  owner: Address,
  amount: bigint,
): void {
  const enc = getAddressCodec();
  const b = Buffer.alloc(165);
  Buffer.from(enc.encode(mint)).copy(b, 0);
  Buffer.from(enc.encode(owner)).copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b.writeUInt32LE(0, 72);   // delegate: COption::None
  b.writeUInt8(1, 108);     // state: Initialized
  b.writeUInt32LE(0, 109);  // isNative: COption::None
  b.writeBigUInt64LE(0n, 121);
  b.writeUInt32LE(0, 129);  // closeAuthority: COption::None
  world.svm.setAccount({
    address: ata,
    lamports: 2_039_280n, // rent-exempt per 165 byte
    data: new Uint8Array(b),
    programAddress: TOKEN_PROGRAM,
    executable: false,
    space: 165n,
  } as never);
}

export function readTokenAmount(world: World, ata: Address): bigint {
  const acc = world.svm.getAccount(ata);
  if (!acc || !('data' in acc) || !acc.data) return 0n;
  return Buffer.from(acc.data as Uint8Array).readBigUInt64LE(64);
}

export async function fundSigner(world: World, signer: KeyPairSigner, sol = 10): Promise<void> {
  world.svm.airdrop(signer.address, BigInt(Math.round(sol * 1e9)) as never);
}

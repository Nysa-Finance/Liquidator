import { readFile, readdir } from 'node:fs/promises';
import { LiteSVM, Clock } from 'litesvm';
import { address, getAddressCodec, type Address } from '@solana/kit';
import { scopePrice } from '../src/scanner.js';

/**
 * Local world: LiteSVM loaded with the real mainnet programs and state pulled by
 * `npm run fixtures`.
 *
 * It is a *static* fork: no network, no funded key, nothing submitted. Accounts
 * can be rewritten at will — in particular the Scope feed, which is how a
 * position is made liquidatable without waiting for the market to move.
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
  /** current slot and timestamp of the simulated world */
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

/** Aligns Clock and slot: klend checks both the slot (staleness) and the timestamp (price age). */
export function setClock(world: World, slot: bigint, unixTimestamp: bigint): void {
  world.svm.warpToSlot(slot);
  world.svm.setClock(new Clock(slot, 0n, slot / 432_000n, slot / 432_000n, unixTimestamp));
  world.slot = slot;
  world.unixTimestamp = unixTimestamp;
}

// ── Scope ───────────────────────────────────────────────────────────────────
// klend reads the OraclePrices account DIRECTLY (no CPI into Scope): it only
// checks that the address matches the reserve's configured priceFeed. Rewriting
// these bytes is therefore how prices are moved in the local world.
// The entry layout lives in src/scanner.ts.

function feedBytes(world: World, feed: Address): Buffer {
  const acc = world.svm.getAccount(feed);
  if (!acc || !('data' in acc) || !acc.data) throw new Error(`Scope feed ${feed} missing`);
  return Buffer.from(acc.data as Uint8Array);
}

export function readScopePrice(world: World, feed: Address, index: number) {
  return scopePrice(feedBytes(world, feed), index);
}

/**
 * Rewrites a Scope price and stamps it with the world's current slot/timestamp,
 * so that `max_age_price_seconds` is satisfied.
 */
export function setScopePrice(world: World, feed: Address, index: number, price: number, exp = 8): void {
  const acc = world.svm.getAccount(feed)!;
  const b = feedBytes(world, feed);
  const o = scopePrice(b, index).offset;
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

// ── Forged token accounts ───────────────────────────────────────────────────
// An SPL token account is 165 bytes: mint(32) owner(32) amount(u64) delegate(36)
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
    lamports: 2_039_280n, // rent-exempt minimum for 165 bytes
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

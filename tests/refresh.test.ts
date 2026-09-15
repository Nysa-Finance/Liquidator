import { test } from 'node:test';
import { FailedTransactionMetadata } from 'litesvm';
import assert from 'node:assert/strict';
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { Reserve } from '@kamino-finance/klend-sdk';
import { TARGET_MARKET, USDC_RESERVE, USDY_RESERVE } from '../src/config.js';
import { refreshReserveIx } from '../src/build/klend.js';
import { loadWorld, setScopePrice, readScopePrice, type World } from './world.js';

/** Indici Scope usati dalle reserve del market (letti da config.tokenInfo.scopeConfiguration). */
const USDY_SCOPE_INDEX = 3;
const USDC_SCOPE_INDEX = 20;
const USDC_SCOPE_INDEX_2 = 230;

async function sendIxs(world: World, signer: Awaited<ReturnType<typeof generateKeyPairSigner>>, ixs: Parameters<typeof appendTransactionMessageInstructions>[0]) {
  const blockhash = world.svm.latestBlockhash();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 2n ** 63n - 1n }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  return world.svm.sendTransaction(signed as never);
}

function readReservePrice(world: World, reserve: Parameters<typeof world.svm.getAccount>[0]): number {
  const acc = world.svm.getAccount(reserve);
  assert.ok(acc && 'data' in acc && acc.data, 'reserve assente nel mondo');
  const r = Reserve.decode(Buffer.from(acc.data as Uint8Array));
  return Number(r.liquidity.marketPriceSf) / 2 ** 60;
}

test('il mondo locale carica programmi e stato di mainnet', async () => {
  const world = await loadWorld();
  assert.equal(Object.keys(world.manifest.programs).length, 3);
  const acc = world.svm.getAccount(USDY_RESERVE.address);
  assert.ok(acc && 'data' in acc, 'reserve USDY non caricata');
});

test('il feed Scope del market quota USDY a ~1e-6: la reserve è configurata su un indice segnaposto', async () => {
  const world = await loadWorld();
  const p = readScopePrice(world, TARGET_MARKET.scopePrices, USDY_SCOPE_INDEX);
  // Questo NON è un bug del bot: è lo stato reale di mainnet.
  // La scope chain della reserve USDY è [3], e l'indice 3 vale 1e-6 USD.
  assert.ok(p.price < 0.01, `atteso prezzo segnaposto, letto ${p.price}`);
});

test('refreshReserve applica i prezzi Scope che scriviamo noi', async () => {
  const world = await loadWorld({ sigverify: false });
  const signer = await generateKeyPairSigner();
  world.svm.airdrop(signer.address, 10_000_000_000n as never);

  // Prezzi realistici, timbrati allo slot/timestamp correnti del mondo.
  setScopePrice(world, TARGET_MARKET.scopePrices, USDY_SCOPE_INDEX, 1.1435);
  setScopePrice(world, TARGET_MARKET.scopePrices, USDC_SCOPE_INDEX, 1.0);
  setScopePrice(world, TARGET_MARKET.scopePrices, USDC_SCOPE_INDEX_2, 1.0);

  const res = await sendIxs(world, signer, [
    refreshReserveIx(USDY_RESERVE.address, TARGET_MARKET.address, TARGET_MARKET.scopePrices),
    refreshReserveIx(USDC_RESERVE.address, TARGET_MARKET.address, TARGET_MARKET.scopePrices),
  ]);

  if (res instanceof FailedTransactionMetadata) {
    assert.fail(`refreshReserve fallita: ${res.err().toString()}\n${res.meta().logs().slice(-10).join('\n')}`);
  }

  assert.ok(Math.abs(readReservePrice(world, USDY_RESERVE.address) - 1.1435) < 1e-4);
  assert.ok(Math.abs(readReservePrice(world, USDC_RESERVE.address) - 1.0) < 1e-4);
});

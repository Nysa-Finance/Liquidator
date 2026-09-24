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
import { loadWorld, setScopePrice, type World } from './world.js';

// The two reserves read different feeds since USDY was repointed, so each
// price is written where that reserve will actually look for it.
const [USDY_IDX] = USDY_RESERVE.scopeChain;
const [USDC_IDX, USDC_IDX_2] = USDC_RESERVE.scopeChain;

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
  assert.ok(acc && 'data' in acc && acc.data, 'reserve missing from the world');
  const r = Reserve.decode(Buffer.from(acc.data as Uint8Array));
  return Number(r.liquidity.marketPriceSf) / 2 ** 60;
}

test('the local world loads mainnet programs and state', async () => {
  const world = await loadWorld();
  assert.equal(Object.keys(world.manifest.programs).length, 3);
  const acc = world.svm.getAccount(USDY_RESERVE.address);
  assert.ok(acc && 'data' in acc, 'USDY reserve not loaded');
});

test('refreshReserve applies the Scope prices we write ourselves', async () => {
  const world = await loadWorld({ sigverify: false });
  const signer = await generateKeyPairSigner();
  world.svm.airdrop(signer.address, 10_000_000_000n as never);

  // Realistic prices, stamped with the world's current slot/timestamp.
  setScopePrice(world, USDY_RESERVE.scopeFeed, USDY_IDX!, 1.1435);
  setScopePrice(world, USDC_RESERVE.scopeFeed, USDC_IDX!, 1.0);
  setScopePrice(world, USDC_RESERVE.scopeFeed, USDC_IDX_2!, 1.0);

  const res = await sendIxs(world, signer, [
    refreshReserveIx(USDY_RESERVE.address, TARGET_MARKET.address, USDY_RESERVE.scopeFeed),
    refreshReserveIx(USDC_RESERVE.address, TARGET_MARKET.address, USDC_RESERVE.scopeFeed),
  ]);

  if (res instanceof FailedTransactionMetadata) {
    assert.fail(`refreshReserve failed: ${res.err().toString()}\n${res.meta().logs().slice(-10).join('\n')}`);
  }

  assert.ok(Math.abs(readReservePrice(world, USDY_RESERVE.address) - 1.1435) < 1e-4);
  assert.ok(Math.abs(readReservePrice(world, USDC_RESERVE.address) - 1.0) < 1e-4);
});

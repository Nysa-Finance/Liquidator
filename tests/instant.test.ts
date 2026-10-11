import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
} from '@solana/kit';
import { ledgerInstant } from '../src/rpc.js';

/** An RPC whose getBlockTime answers from a table, throwing where it holds an Error. */
function fakeRpc(slot: bigint, times: Record<string, bigint | Error>) {
  const asked: bigint[] = [];
  const rpc = {
    getSlot: () => ({ send: async () => slot }),
    getBlockTime: (s: bigint) => ({
      send: async () => {
        asked.push(s);
        const t = times[String(s)];
        if (t instanceof Error) throw t;
        return t ?? null;
      },
    }),
  };
  return { rpc: rpc as never, asked };
}

const notAvailable = () =>
  new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE, { __serverMessage: 'Block not available' });

test('a missing or skipped newest block falls back to the previous one, keeping the newest slot', async () => {
  const { rpc, asked } = fakeRpc(100n, {
    '100': notAvailable(),
    '99': new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED, { __serverMessage: 'skipped' }),
    '98': 1_700_000_000n,
  });
  assert.deepEqual(await ledgerInstant(rpc), { slot: 100n, blockTime: 1_700_000_000n });
  assert.deepEqual(asked, [100n, 99n, 98n]);
});

test('any other error is not swallowed (a 429 must reach the back-off)', async () => {
  const { rpc, asked } = fakeRpc(100n, { '100': new Error('HTTP error (429): Too Many Requests') });
  await assert.rejects(ledgerInstant(rpc), /429/);
  assert.deepEqual(asked, [100n]);
});

test('gives up after four blocks rather than walking back forever', async () => {
  const { rpc } = fakeRpc(100n, { '100': notAvailable(), '99': notAvailable(), '98': notAvailable(), '97': notAvailable() });
  await assert.rejects(ledgerInstant(rpc), /within 4 slots/);
});

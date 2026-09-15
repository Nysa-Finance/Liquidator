import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailedTransactionMetadata } from 'litesvm';
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
} from '@solana/kit';
import { FLASH_SOURCE } from '../src/config.js';
import { flashLoanPair, loadPdas } from '../src/build/klend.js';
import { computeUnitLimitIx } from '../src/build/computeBudget.js';
import { forgeTokenAccount, loadWorld, readTokenAmount, type World } from './world.js';

/**
 * The most fragile part of the transaction is the flash loan introspection
 * (lending_market/flash_ixs.rs): borrow and repay must carry identical account
 * lists, and `borrow_instruction_index` must point at the real index.
 *
 * That is exactly what these tests check, with no liquidatable position needed.
 */

async function send(world: World, signer: Awaited<ReturnType<typeof generateKeyPairSigner>>, ixs: Instruction[]) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: world.svm.latestBlockhash(), lastValidBlockHeight: 2n ** 63n - 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  return world.svm.sendTransaction(signed as never);
}

function failureLogs(res: unknown): string {
  if (res instanceof FailedTransactionMetadata) {
    return `${res.err().toString()}\n${res.meta().logs().slice(-12).join('\n')}`;
  }
  return '';
}

async function setup(seedUsdc: bigint) {
  const world = await loadWorld({ sigverify: false });
  const signer = await generateKeyPairSigner();
  const usdcAccount = (await generateKeyPairSigner()).address;
  world.svm.airdrop(signer.address, 10_000_000_000n as never);
  forgeTokenAccount(world, usdcAccount, FLASH_SOURCE.liquidityMint, signer.address, seedUsdc);
  const pdas = await loadPdas();
  return { world, signer, usdcAccount, pdas };
}

const BORROW = 1_000_000_000n; // 1,000 USDC

test('flash borrow + flash repay: the pair passes the introspection checks', async () => {
  // seed: only needed to cover the fee (0.001% of 1,000 USDC = 0.01 USDC)
  const { world, signer, usdcAccount, pdas } = await setup(1_000_000n);

  const head = [computeUnitLimitIx(400_000)];
  const { borrow, repay } = flashLoanPair({
    signer,
    flashMarketAuth: pdas.flashMarketAuth,
    usdcAta: usdcAccount,
    amount: BORROW,
    borrowInstructionIndex: head.length, // ← real index, not a constant
  });

  const before = readTokenAmount(world, usdcAccount);
  const res = await send(world, signer, [...head, borrow, repay]);
  assert.ok(!(res instanceof FailedTransactionMetadata), `flash loan failed:\n${failureLogs(res)}`);

  const after = readTokenAmount(world, usdcAccount);
  const cost = before - after;
  // fee = 1e-5 × 1,000 USDC = 0.01 USDC = 10,000 base units
  assert.equal(cost, 10_000n, `expected a 10000 base-unit fee, observed ${cost}`);
});

test('a wrong borrow_instruction_index makes the transaction revert', async () => {
  const { world, signer, usdcAccount, pdas } = await setup(1_000_000n);

  const head = [computeUnitLimitIx(400_000)];
  const { borrow, repay } = flashLoanPair({
    signer,
    flashMarketAuth: pdas.flashMarketAuth,
    usdcAta: usdcAccount,
    amount: BORROW,
    borrowInstructionIndex: head.length + 1, // off by one
  });

  const res = await send(world, signer, [...head, borrow, repay]);
  assert.ok(res instanceof FailedTransactionMetadata, 'expected a revert, the tx succeeded');
});

test('without a flash repay the borrow reverts (NoFlashRepayFound)', async () => {
  const { world, signer, usdcAccount, pdas } = await setup(1_000_000n);

  const head = [computeUnitLimitIx(400_000)];
  const { borrow } = flashLoanPair({
    signer,
    flashMarketAuth: pdas.flashMarketAuth,
    usdcAta: usdcAccount,
    amount: BORROW,
    borrowInstructionIndex: head.length,
  });

  const res = await send(world, signer, [...head, borrow]);
  assert.ok(res instanceof FailedTransactionMetadata, 'expected a revert, the tx succeeded');
});

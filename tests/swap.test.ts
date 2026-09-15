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
import { ORCA_POOL } from '../src/config.js';
import {
  buildSwapIx,
  decodeWhirlpoolData,
  orcaContextFromAccounts,
  quoteUsdyToUsdc,
} from '../src/build/orca.js';
import { computeUnitLimitIx } from '../src/build/computeBudget.js';
import { forgeTokenAccount, loadWorld, readTokenAmount, type World } from './world.js';

/**
 * Actually executes the USDY → USDC swap against the real mainnet pool, locally.
 * It also checks that the off-chain quote matches on-chain execution: if the two
 * diverged, every profit estimate would be wrong.
 */

function accountData(world: World, addr: Parameters<typeof world.svm.getAccount>[0]): Uint8Array | null {
  const acc = world.svm.getAccount(addr);
  if (!acc || !('data' in acc) || !acc.data) return null;
  const d = acc.data as Uint8Array;
  return d.length === 0 ? null : d;
}

test('swapV2 USDY→USDC: real execution, and the quote agrees', async () => {
  const world = await loadWorld({ sigverify: false });
  const signer = await generateKeyPairSigner();
  world.svm.airdrop(signer.address, 10_000_000_000n as never);

  const poolData = accountData(world, ORCA_POOL.address);
  assert.ok(poolData, 'Orca pool missing from the fixtures');
  const pool = decodeWhirlpoolData(poolData);

  // the context derives the tick array addresses itself from the swap direction
  const probe = await orcaContextFromAccounts({ pool, tickArrayData: [null, null, null], slot: world.slot });
  const ctx = await orcaContextFromAccounts({
    pool,
    tickArrayData: probe.tickArrays.map((a) => accountData(world, a)),
    slot: world.slot,
  });

  const usdyAcct = (await generateKeyPairSigner()).address;
  const usdcAcct = (await generateKeyPairSigner()).address;
  const amountIn = 1_000_000_000n; // 1,000 USDY
  forgeTokenAccount(world, usdyAcct, ORCA_POOL.tokenMintA, signer.address, amountIn);
  forgeTokenAccount(world, usdcAcct, ORCA_POOL.tokenMintB, signer.address, 0n);

  const quote = quoteUsdyToUsdc(ctx, amountIn, 30, world.unixTimestamp);

  const ixs: Instruction[] = [
    computeUnitLimitIx(300_000),
    buildSwapIx({
      ctx,
      signer,
      usdyAta: usdyAcct,
      usdcAta: usdcAcct,
      amountIn,
      minAmountOut: quote.tokenMinOut,
    }),
  ];

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
  const res = world.svm.sendTransaction((await signTransactionMessageWithSigners(msg)) as never);

  if (res instanceof FailedTransactionMetadata) {
    assert.fail(`swap failed: ${res.err().toString()}\n${res.meta().logs().slice(-12).join('\n')}`);
  }

  const got = readTokenAmount(world, usdcAcct);
  assert.equal(readTokenAmount(world, usdyAcct), 0n, 'all USDY should have been sold');
  assert.ok(got >= quote.tokenMinOut, `output ${got} below the minimum ${quote.tokenMinOut}`);

  // the off-chain quote must match execution: 1 bps tolerance
  const drift = Number(got - quote.tokenEstOut) / Number(quote.tokenEstOut);
  assert.ok(Math.abs(drift) < 1e-4, `quote and execution diverge by ${(drift * 1e4).toFixed(2)} bps`);

  console.log(
    `    swap executed: ${Number(amountIn) / 1e6} USDY → ${Number(got) / 1e6} USDC ` +
      `(quote ${Number(quote.tokenEstOut) / 1e6}, drift ${(drift * 1e4).toFixed(3)} bps, ` +
      `CU ${res.computeUnitsConsumed()})`,
  );
});

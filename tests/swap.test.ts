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
 * Esegue davvero lo swap USDY → USDC contro il pool reale di mainnet, in locale.
 * Verifica anche che il quote off-chain coincida con l'esecuzione on-chain:
 * se divergessero, tutte le stime di profitto sarebbero sbagliate.
 */

function accountData(world: World, addr: Parameters<typeof world.svm.getAccount>[0]): Uint8Array | null {
  const acc = world.svm.getAccount(addr);
  if (!acc || !('data' in acc) || !acc.data) return null;
  const d = acc.data as Uint8Array;
  return d.length === 0 ? null : d;
}

test('swapV2 USDY→USDC: esecuzione reale e quote coerente', async () => {
  const world = await loadWorld({ sigverify: false });
  const signer = await generateKeyPairSigner();
  world.svm.airdrop(signer.address, 10_000_000_000n as never);

  const poolData = accountData(world, ORCA_POOL.address);
  assert.ok(poolData, 'pool Orca assente nelle fixture');
  const pool = decodeWhirlpoolData(poolData);

  // il contesto ricostruisce da solo gli indirizzi dei tick array dalla direzione dello swap
  const probe = await orcaContextFromAccounts({ pool, tickArrayData: [null, null, null], slot: world.slot });
  const ctx = await orcaContextFromAccounts({
    pool,
    tickArrayData: probe.tickArrays.map((a) => accountData(world, a)),
    slot: world.slot,
  });

  const usdyAcct = (await generateKeyPairSigner()).address;
  const usdcAcct = (await generateKeyPairSigner()).address;
  const amountIn = 1_000_000_000n; // 1.000 USDY
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
    assert.fail(`swap fallito: ${res.err().toString()}\n${res.meta().logs().slice(-12).join('\n')}`);
  }

  const got = readTokenAmount(world, usdcAcct);
  assert.equal(readTokenAmount(world, usdyAcct), 0n, 'gli USDY dovevano essere tutti venduti');
  assert.ok(got >= quote.tokenMinOut, `output ${got} sotto il minimo ${quote.tokenMinOut}`);

  // il quote off-chain deve coincidere con l'esecuzione: tolleranza 1 bps
  const drift = Number(got - quote.tokenEstOut) / Number(quote.tokenEstOut);
  assert.ok(Math.abs(drift) < 1e-4, `quote e esecuzione divergono di ${(drift * 1e4).toFixed(2)} bps`);

  console.log(
    `    swap eseguito: ${Number(amountIn) / 1e6} USDY → ${Number(got) / 1e6} USDC ` +
      `(quote ${Number(quote.tokenEstOut) / 1e6}, scarto ${(drift * 1e4).toFixed(3)} bps, ` +
      `CU ${res.computeUnitsConsumed()})`,
  );
});

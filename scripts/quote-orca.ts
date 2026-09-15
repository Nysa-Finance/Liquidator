/**
 * Real USDY → USDC quote on the exit Whirlpool. No keys, nothing submitted.
 * Use it to calibrate SWAP_SLIPPAGE_BPS and to check the pool's depth.
 *
 *   RPC=https://... npx tsx scripts/quote-orca.ts [space-separated USDY amounts]
 */
import { createSolanaRpc } from '@solana/kit';
import { loadOrcaContext, quoteUsdyToUsdc, spotPrice } from '../src/build/orca.js';

const RPC = process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com';
const amounts = (process.argv.slice(2).length ? process.argv.slice(2) : ['1000', '10000', '50000'])
  .map((a) => BigInt(a));

async function main() {
  const rpc = createSolanaRpc(RPC);
  const slot = await rpc.getSlot().send();
  const ctx = await loadOrcaContext(rpc, slot);
  const spot = spotPrice(ctx.pool);

  console.log(`slot ${slot}`);
  console.log(`pool  tick=${ctx.pool.tickCurrentIndex} feeRate=${ctx.pool.feeRate} (${(ctx.pool.feeRate / 1e4).toFixed(2)}%)`);
  console.log(`in-range L = ${ctx.pool.liquidity}`);
  console.log(`spot USDY→USDC = ${spot.toFixed(6)}`);
  console.log(`tick arrays: ${ctx.tickArrays.join(' ')}\n`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const amt of amounts) {
    const q = quoteUsdyToUsdc(ctx, amt * 1_000_000n, 30, now);
    const out = Number(q.tokenEstOut) / 1e6;
    const inn = Number(q.tokenIn) / 1e6;
    const avg = out / inn;
    console.log(
      `${String(amt).padStart(8)} USDY → ${out.toFixed(2).padStart(12)} USDC   ` +
        `avg px ${avg.toFixed(6)}   impact ${(((avg / spot) - 1) * 100).toFixed(4)}%   ` +
        `fee ${(Number(q.tradeFee) / 1e6).toFixed(4)}   min ${(Number(q.tokenMinOut) / 1e6).toFixed(2)}`,
    );
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Address,
} from '@solana/kit';
import type { KaminoObligation } from '@kamino-finance/klend-sdk';
import { TARGET_MARKET, USDC_RESERVE, USDY_RESERVE } from '../config.js';
import { flashLoanPair, liquidateIx, refreshObligationIx, refreshReserveIx, type Pdas } from './klend.js';
import { buildSwapIx, type OrcaContext } from './orca.js';
import type { LiquidationPlan } from '../profit.js';
import { computeUnitLimitIx, computeUnitPriceIx } from './computeBudget.js';

export type Atas = { usdc: Address; usdy: Address; cusdy: Address };

/**
 * Costruisce la transazione atomica completa.
 *
 * Ordine (vedi docs/03-transazione-atomica.md):
 *   0 setComputeUnitLimit
 *   1 setComputeUnitPrice
 *   2 refreshReserve(USDC)
 *   3 refreshReserve(USDY)
 *   4 refreshObligation
 *   5 flashBorrow                ← borrowInstructionIndex
 *   6 liquidateV2
 *   7 swapV2
 *   8 flashRepay
 *
 * `borrowInstructionIndex` è calcolato dall'array, mai hardcoded: basta aggiungere
 * o togliere una ComputeBudget in testa perché un indice fisso diventi sbagliato e
 * il programma risponda `InvalidFlashRepay`.
 */
export function buildLiquidationMessage(args: {
  signer: KeyPairSigner;
  pdas: Pdas;
  atas: Atas;
  obligation: KaminoObligation;
  plan: LiquidationPlan;
  orca: OrcaContext;
  blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
}) {
  const head: Instruction[] = [
    computeUnitLimitIx(args.computeUnitLimit),
    computeUnitPriceIx(args.computeUnitPriceMicroLamports),
    refreshReserveIx(USDC_RESERVE.address, TARGET_MARKET.address, TARGET_MARKET.scopePrices),
    refreshReserveIx(USDY_RESERVE.address, TARGET_MARKET.address, TARGET_MARKET.scopePrices),
    refreshObligationIx({
      market: TARGET_MARKET.address,
      obligation: args.plan.obligation,
      depositReserves: args.obligation.getDepositReserves(),
      borrowReserves: args.obligation.getBorrowReserves(),
    }),
  ];

  const borrowInstructionIndex = head.length; // ← calcolato, non costante

  const { borrow, repay } = flashLoanPair({
    signer: args.signer,
    flashMarketAuth: args.pdas.flashMarketAuth,
    usdcAta: args.atas.usdc,
    amount: args.plan.repayAmount,
    borrowInstructionIndex,
  });

  const liquidate = liquidateIx({
    signer: args.signer,
    obligation: args.plan.obligation,
    targetMarketAuth: args.pdas.targetMarketAuth,
    usdcAta: args.atas.usdc,
    cusdyAta: args.atas.cusdy,
    usdyAta: args.atas.usdy,
    repayAmount: args.plan.repayAmount,
    minReceivedUsdy: args.plan.minReceivedUsdy,
  });

  const swap = buildSwapIx({
    ctx: args.orca,
    signer: args.signer,
    usdyAta: args.atas.usdy,
    usdcAta: args.atas.usdc,
    amountIn: args.plan.expectedUsdyOut,
    minAmountOut: args.plan.minUsdcOut,
  });

  const instructions = [...head, borrow, liquidate, swap, repay];

  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(args.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(args.blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

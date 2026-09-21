import {
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import type { KaminoObligation } from '@kamino-finance/klend-sdk';
import { TARGET_MARKET, USDC_RESERVE, USDY_RESERVE } from '../config.js';
import { flashLoanPair, liquidateIx, refreshObligationIx, refreshReserveIx, type Pdas } from './klend.js';
import { buildSwapIx, type OrcaContext } from './orca.js';
import type { LiquidationPlan } from '../profit.js';
import { computeUnitLimitIx, computeUnitPriceIx } from './computeBudget.js';

export type Atas = { usdc: Address; usdy: Address; cusdy: Address };

/** Addresses a lookup table holds, keyed by the table that holds them. */
export type LookupTables = Record<Address, Address[]>;

/** Hard limit on a serialized Solana transaction. */
export const MAX_TRANSACTION_BYTES = 1232;

/**
 * Serialized size of the signed transaction.
 *
 * Worth measuring rather than assuming: this transaction references around
 * three dozen accounts, and at 32 bytes each the addresses alone overrun the
 * 1232-byte limit. Without lookup tables it is refused by the network before it
 * is ever executed — and a local SVM will happily run it, because it never
 * applies the packet limit.
 */
export async function wireSize(
  message: Parameters<typeof signTransactionMessageWithSigners>[0],
): Promise<number> {
  const signed = await signTransactionMessageWithSigners(message);
  // base64 inflates by 4/3; measure the bytes that actually go on the wire
  return Buffer.from(getBase64EncodedWireTransaction(signed), 'base64').length;
}

/**
 * Builds the complete atomic transaction.
 *
 * Order (see docs/02-design.md):
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
 * `borrowInstructionIndex` is derived from the array, never hardcoded: adding or
 * removing a single ComputeBudget instruction at the head is enough to make a
 * fixed index wrong, and the program answers `InvalidFlashRepay`.
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
  /**
   * Lookup tables to compress the message with. Omitted only in local tests,
   * where the size limit is not enforced; a mainnet send without them is
   * rejected for size.
   */
  lookupTables?: LookupTables;
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

  const borrowInstructionIndex = head.length; // ← derived, not a constant

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
    (m) =>
      args.lookupTables
        ? compressTransactionMessageUsingAddressLookupTables(m, args.lookupTables)
        : m,
  );
}

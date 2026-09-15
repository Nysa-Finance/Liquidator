import {
  fetchWhirlpool,
  fetchAllMaybeTickArray,
  consolidateTickArray,
  getTickArrayAddress,
  getOracleAddress,
  getSwapV2Instruction,
  decodeTickArray,
  decodeWhirlpool,
  WHIRLPOOL_PROGRAM_ADDRESS,
  type Whirlpool,
} from '@orca-so/whirlpools-client';
import {
  swapQuoteByInputToken,
  getTickArrayStartTickIndex,
  _TICK_ARRAY_SIZE,
  type TickArrayFacade,
  type WhirlpoolFacade,
  type ExactInSwapQuote,
} from '@orca-so/whirlpools-core';
import type { Address, Instruction, KeyPairSigner } from '@solana/kit';
import type { RpcClient } from '../rpc.js';
import { MEMO_PROGRAM, ORCA_POOL, TOKEN_PROGRAM } from '../config.js';

/**
 * Uscita USDY → USDC sul Whirlpool AGXrsw… (mint A = USDY, mint B = USDC).
 * Vendere USDY significa quindi `aToB = true`.
 */

export type OrcaContext = {
  pool: Whirlpool;
  poolAddress: Address;
  oracle: Address;
  tickArrays: [Address, Address, Address];
  tickArrayFacades: TickArrayFacade[];
  slot: bigint;
};

const A_TO_B = true;

/** I 3 tick array che il programma richiede, nella direzione dello swap. */
export async function tickArrayAddresses(
  poolAddress: Address,
  tickCurrentIndex: number,
  tickSpacing: number,
): Promise<[Address, Address, Address]> {
  const span = tickSpacing * _TICK_ARRAY_SIZE();
  const start = getTickArrayStartTickIndex(tickCurrentIndex, tickSpacing);
  // aToB = true → il prezzo scende → si attraversano array a start decrescenti
  const starts = [start, start - span, start - 2 * span];
  const pdas = await Promise.all(starts.map((s) => getTickArrayAddress(poolAddress, s)));
  return [pdas[0]![0], pdas[1]![0], pdas[2]![0]];
}

/** Tick array assente = legittimo: lato programma SparseSwapTickSequenceBuilder lo tollera. */
function emptyTickArray(startTickIndex: number): TickArrayFacade {
  return {
    startTickIndex,
    ticks: Array.from({ length: _TICK_ARRAY_SIZE() }, () => ({
      initialized: false,
      liquidityNet: 0n,
      liquidityGross: 0n,
      feeGrowthOutsideA: 0n,
      feeGrowthOutsideB: 0n,
      rewardGrowthsOutside: [0n, 0n, 0n],
    })),
  };
}

/**
 * Costruisce il contesto a partire dagli account già letti.
 * Separato da `loadOrcaContext` così il contesto si può ricreare anche da uno
 * snapshot locale (LiteSVM) senza passare da un RPC.
 */
export async function orcaContextFromAccounts(args: {
  pool: Whirlpool;
  /** dati grezzi dei 3 tick array nell'ordine di swap; `null` se non inizializzato */
  tickArrayData: (Uint8Array | null)[];
  slot: bigint;
}): Promise<OrcaContext> {
  const { pool } = args;
  const addrs = await tickArrayAddresses(ORCA_POOL.address, pool.tickCurrentIndex, pool.tickSpacing);
  const span = pool.tickSpacing * _TICK_ARRAY_SIZE();
  const start = getTickArrayStartTickIndex(pool.tickCurrentIndex, pool.tickSpacing);

  const facades: TickArrayFacade[] = args.tickArrayData.map((data, i) => {
    if (!data) return emptyTickArray(start - i * span);
    const acc = consolidateTickArray({
      address: addrs[i]!,
      exists: true,
      data: decodeTickArrayData(data),
      programAddress: WHIRLPOOL_PROGRAM_ADDRESS,
      executable: false,
      lamports: 0n,
      space: BigInt(data.length),
    } as never);
    const fixed = (acc as { data: { startTickIndex: number; ticks: TickArrayFacade['ticks'] } }).data;
    return { startTickIndex: fixed.startTickIndex, ticks: fixed.ticks };
  });

  const [oracle] = await getOracleAddress(ORCA_POOL.address);
  return { pool, poolAddress: ORCA_POOL.address, oracle, tickArrays: addrs, tickArrayFacades: facades, slot: args.slot };
}

function decodeTickArrayData(data: Uint8Array) {
  const acc = decodeTickArray({
    address: ORCA_POOL.address,
    exists: true,
    data,
    programAddress: WHIRLPOOL_PROGRAM_ADDRESS,
    executable: false,
    lamports: 0n,
    space: BigInt(data.length),
  } as never);
  return (acc as { data: unknown }).data;
}

export async function loadOrcaContext(rpc: RpcClient, slot: bigint): Promise<OrcaContext> {
  const poolAcc = await fetchWhirlpool(rpc, ORCA_POOL.address);
  const pool = poolAcc.data;
  const addrs = await tickArrayAddresses(ORCA_POOL.address, pool.tickCurrentIndex, pool.tickSpacing);
  const maybe = await fetchAllMaybeTickArray(rpc, addrs);
  const span = pool.tickSpacing * _TICK_ARRAY_SIZE();
  const start = getTickArrayStartTickIndex(pool.tickCurrentIndex, pool.tickSpacing);

  const facades: TickArrayFacade[] = maybe.map((acc, i) => {
    if (!acc.exists) return emptyTickArray(start - i * span);
    const fixed = consolidateTickArray(acc).data;
    return { startTickIndex: fixed.startTickIndex, ticks: fixed.ticks as TickArrayFacade['ticks'] };
  });

  const [oracle] = await getOracleAddress(ORCA_POOL.address);
  return { pool, poolAddress: ORCA_POOL.address, oracle, tickArrays: addrs, tickArrayFacades: facades, slot };
}

function toFacade(pool: Whirlpool): WhirlpoolFacade {
  return {
    feeTierIndexSeed: pool.feeTierIndexSeed,
    tickSpacing: pool.tickSpacing,
    feeRate: pool.feeRate,
    protocolFeeRate: pool.protocolFeeRate,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    tickCurrentIndex: pool.tickCurrentIndex,
    feeGrowthGlobalA: pool.feeGrowthGlobalA,
    feeGrowthGlobalB: pool.feeGrowthGlobalB,
    rewardLastUpdatedTimestamp: pool.rewardLastUpdatedTimestamp,
    rewardInfos: pool.rewardInfos.map((r) => ({
      emissionsPerSecondX64: r.emissionsPerSecondX64,
      growthGlobalX64: r.growthGlobalX64,
    })),
  };
}

/** Quote esatta sull'input: quanti USDC escono vendendo `usdyIn` USDY. */
export function quoteUsdyToUsdc(
  ctx: OrcaContext,
  usdyIn: bigint,
  slippageBps: number,
  nowSeconds: bigint,
): ExactInSwapQuote {
  return swapQuoteByInputToken(
    usdyIn,
    /* specified_token_a */ true,
    slippageBps,
    toFacade(ctx.pool),
    /* oracle (adaptive fee) */ null,
    ctx.tickArrayFacades,
    nowSeconds,
    null,
    null,
  );
}

/**
 * `swap_v2`. Entrambe le mint del pool sono SPL Token legacy, quindi `swap` v1
 * basterebbe; usiamo la v2 perché è la variante che Orca mantiene e perché
 * regge reserve Token-2022 senza riscrivere il builder.
 *
 * `sqrtPriceLimit = 0n` delega il limite al programma (MIN/MAX secondo direzione).
 * La protezione vera è `otherAmountThreshold`.
 */
export function buildSwapIx(args: {
  ctx: OrcaContext;
  signer: KeyPairSigner;
  usdyAta: Address;
  usdcAta: Address;
  amountIn: bigint;
  minAmountOut: bigint;
}): Instruction {
  return getSwapV2Instruction({
    tokenProgramA: TOKEN_PROGRAM,
    tokenProgramB: TOKEN_PROGRAM,
    memoProgram: MEMO_PROGRAM,
    tokenAuthority: args.signer,
    whirlpool: args.ctx.poolAddress,
    tokenMintA: ORCA_POOL.tokenMintA,
    tokenMintB: ORCA_POOL.tokenMintB,
    tokenOwnerAccountA: args.usdyAta,
    tokenVaultA: ORCA_POOL.tokenVaultA,
    tokenOwnerAccountB: args.usdcAta,
    tokenVaultB: ORCA_POOL.tokenVaultB,
    tickArray0: args.ctx.tickArrays[0],
    tickArray1: args.ctx.tickArrays[1],
    tickArray2: args.ctx.tickArrays[2],
    oracle: args.ctx.oracle,
    amount: args.amountIn,
    otherAmountThreshold: args.minAmountOut,
    sqrtPriceLimit: 0n,
    amountSpecifiedIsInput: true,
    aToB: A_TO_B,
    remainingAccountsInfo: null,
  }) as unknown as Instruction;
}

/** Prezzo spot USDY→USDC implicito in sqrtPrice (entrambe le mint hanno 6 decimali). */
export function spotPrice(pool: Whirlpool): number {
  const sp = Number(pool.sqrtPrice) / 2 ** 64;
  return sp * sp;
}

/** Decodifica un account Whirlpool da byte grezzi (usato dai test sul mondo locale). */
export function decodeWhirlpoolData(data: Uint8Array): Whirlpool {
  const acc = decodeWhirlpool({
    address: ORCA_POOL.address,
    exists: true,
    data,
    programAddress: WHIRLPOOL_PROGRAM_ADDRESS,
    executable: false,
    lamports: 0n,
    space: BigInt(data.length),
  } as never);
  return (acc as { data: Whirlpool }).data;
}

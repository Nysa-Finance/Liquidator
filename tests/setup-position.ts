import BN from 'bn.js';
import {
  borrowObligationLiquidityV2,
  depositReserveLiquidity,
  depositReserveLiquidityAndObligationCollateralV2,
  initObligation,
  initUserMetadata,
  refreshObligation,
  refreshReserve,
  userMetadataPda,
  VanillaObligation,
} from '@kamino-finance/klend-sdk';
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import {
  FARMS_PROGRAM,
  KLEND_PROGRAM,
  SYSVAR_INSTRUCTIONS,
  TARGET_MARKET,
  TOKEN_PROGRAM,
  USDC_RESERVE,
  USDY_RESERVE,
} from '../src/config.js';
import { refreshReserveIx } from '../src/build/klend.js';
import { computeUnitLimitIx } from '../src/build/computeBudget.js';
import { forgeTokenAccount, type World } from './world.js';

/**
 * Builds a real, borrowed-against position in the local world.
 *
 * Everything here goes through klend's own instructions rather than forging
 * account bytes: the program then maintains its own invariants (reserve
 * accounting, cToken exchange rate, obligation aggregates), so the liquidation
 * under test runs against a state the protocol itself produced.
 */

const RENT = address('SysvarRent111111111111111111111111111111111');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

export async function send(world: World, payer: KeyPairSigner, ixs: Instruction[], label: string) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: world.svm.latestBlockhash(), lastValidBlockHeight: 2n ** 63n - 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const res = world.svm.sendTransaction((await signTransactionMessageWithSigners(msg)) as never);
  if (res instanceof FailedTransactionMetadata) {
    throw new Error(`${label} failed: ${res.err().toString()}\n${res.meta().logs().slice(-14).join('\n')}`);
  }
  world.svm.expireBlockhash();
  return res;
}

const refreshBoth = () => [
  refreshReserveIx(USDC_RESERVE.address, TARGET_MARKET.address, USDC_RESERVE.scopeFeed),
  refreshReserveIx(USDY_RESERVE.address, TARGET_MARKET.address, USDY_RESERVE.scopeFeed),
];

/** Supplies USDC to the market so there is something to borrow. */
export async function seedUsdcLiquidity(world: World, amount: bigint): Promise<void> {
  const lender = await generateKeyPairSigner();
  world.svm.airdrop(lender.address, 10_000_000_000n as never);
  const source = (await generateKeyPairSigner()).address;
  const collateral = (await generateKeyPairSigner()).address;
  forgeTokenAccount(world, source, USDC_RESERVE.liquidityMint, lender.address, amount);
  forgeTokenAccount(world, collateral, USDC_RESERVE.collateralMint, lender.address, 0n);

  await send(world, lender, [
    computeUnitLimitIx(400_000),
    ...refreshBoth(),
    depositReserveLiquidity(
      { liquidityAmount: new BN(amount.toString()) },
      {
        owner: lender,
        reserve: USDC_RESERVE.address,
        lendingMarket: TARGET_MARKET.address,
        lendingMarketAuthority: world.marketAuthority,
        reserveLiquidityMint: USDC_RESERVE.liquidityMint,
        reserveLiquiditySupply: USDC_RESERVE.supplyVault,
        reserveCollateralMint: USDC_RESERVE.collateralMint,
        userSourceLiquidity: source,
        userDestinationCollateral: collateral,
        collateralTokenProgram: TOKEN_PROGRAM,
        liquidityTokenProgram: TOKEN_PROGRAM,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS,
      },
      undefined,
      KLEND_PROGRAM,
    ) as unknown as Instruction,
  ], 'seed USDC liquidity');
}

export type Position = { owner: KeyPairSigner; obligation: Address };

/**
 * Recomputes the obligation's aggregate values at current prices.
 *
 * Those fields are only written by refresh_obligation, so a deposit or borrow on
 * its own leaves them stale — reading LTV without this returns the state before
 * the operation.
 */
export async function refreshPosition(world: World, payer: KeyPairSigner, obligation: Address) {
  await send(world, payer, [
    computeUnitLimitIx(400_000),
    ...refreshBoth(),
    refreshObligation(
      { lendingMarket: TARGET_MARKET.address, obligation },
      // deposit reserves first, then borrow reserves: the program checks the count
      [
        { address: USDY_RESERVE.address, role: 1 },
        { address: USDC_RESERVE.address, role: 1 },
      ],
      KLEND_PROGRAM,
    ) as unknown as Instruction,
  ], 'refresh obligation');
}

/** Deposits USDY as collateral and borrows USDC against it. */
export async function openPosition(
  world: World,
  depositUsdy: bigint,
  borrowUsdc: bigint,
): Promise<Position> {
  const owner = await generateKeyPairSigner();
  world.svm.airdrop(owner.address, 10_000_000_000n as never);

  const usdySource = (await generateKeyPairSigner()).address;
  const usdcDest = (await generateKeyPairSigner()).address;
  forgeTokenAccount(world, usdySource, USDY_RESERVE.liquidityMint, owner.address, depositUsdy);
  forgeTokenAccount(world, usdcDest, USDC_RESERVE.liquidityMint, owner.address, 0n);

  const [metadata] = await userMetadataPda(owner.address, KLEND_PROGRAM);
  const vanilla = new VanillaObligation(KLEND_PROGRAM);
  const obligation = await vanilla.toPda(TARGET_MARKET.address, owner.address);
  const args = vanilla.toArgs();

  await send(world, owner, [
    initUserMetadata(
      { userLookupTable: SYSTEM_PROGRAM },
      {
        owner,
        feePayer: owner,
        userMetadata: metadata,
        referrerUserMetadata: none<Address>(),
        rent: RENT,
        systemProgram: SYSTEM_PROGRAM,
      },
      undefined,
      KLEND_PROGRAM,
    ) as unknown as Instruction,
    initObligation(
      { args: { tag: args.tag, id: args.id } },
      {
        obligationOwner: owner,
        feePayer: owner,
        obligation,
        lendingMarket: TARGET_MARKET.address,
        seed1Account: args.seed1,
        seed2Account: args.seed2,
        ownerUserMetadata: metadata,
        rent: RENT,
        systemProgram: SYSTEM_PROGRAM,
      },
      undefined,
      KLEND_PROGRAM,
    ) as unknown as Instruction,
  ], 'init obligation');

  await send(world, owner, [
    computeUnitLimitIx(600_000),
    ...refreshBoth(),
    refreshObligation(
      { lendingMarket: TARGET_MARKET.address, obligation },
      [],
      KLEND_PROGRAM,
    ) as unknown as Instruction,
    depositReserveLiquidityAndObligationCollateralV2(
      { liquidityAmount: new BN(depositUsdy.toString()) },
      {
        depositAccounts: {
          owner,
          obligation,
          lendingMarket: TARGET_MARKET.address,
          lendingMarketAuthority: world.marketAuthority,
          reserve: USDY_RESERVE.address,
          reserveLiquidityMint: USDY_RESERVE.liquidityMint,
          reserveLiquiditySupply: USDY_RESERVE.supplyVault,
          reserveCollateralMint: USDY_RESERVE.collateralMint,
          reserveDestinationDepositCollateral: USDY_RESERVE.collateralSupplyVault,
          userSourceLiquidity: usdySource,
          placeholderUserDestinationCollateral: none<Address>(),
          collateralTokenProgram: TOKEN_PROGRAM,
          liquidityTokenProgram: TOKEN_PROGRAM,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS,
        },
        farmsAccounts: { obligationFarmUserState: none<Address>(), reserveFarmState: none<Address>() },
        farmsProgram: FARMS_PROGRAM,
      },
      undefined,
      KLEND_PROGRAM,
    ) as unknown as Instruction,
  ], 'deposit collateral');

  await send(world, owner, [
    computeUnitLimitIx(600_000),
    ...refreshBoth(),
    refreshObligation(
      { lendingMarket: TARGET_MARKET.address, obligation },
      [{ address: USDY_RESERVE.address, role: 1 }],
      KLEND_PROGRAM,
    ) as unknown as Instruction,
    borrowObligationLiquidityV2(
      { liquidityAmount: new BN(borrowUsdc.toString()) },
      {
        borrowAccounts: {
          owner,
          obligation,
          lendingMarket: TARGET_MARKET.address,
          lendingMarketAuthority: world.marketAuthority,
          borrowReserve: USDC_RESERVE.address,
          borrowReserveLiquidityMint: USDC_RESERVE.liquidityMint,
          reserveSourceLiquidity: USDC_RESERVE.supplyVault,
          borrowReserveLiquidityFeeReceiver: USDC_RESERVE.feeVault,
          userDestinationLiquidity: usdcDest,
          referrerTokenState: none<Address>(),
          tokenProgram: TOKEN_PROGRAM,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS,
        },
        farmsAccounts: { obligationFarmUserState: none<Address>(), reserveFarmState: none<Address>() },
        farmsProgram: FARMS_PROGRAM,
      },
      undefined,
      KLEND_PROGRAM,
    ) as unknown as Instruction,
  ], 'borrow');

  return { owner, obligation };
}

export { some };

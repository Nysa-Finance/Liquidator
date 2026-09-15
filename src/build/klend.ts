import BN from 'bn.js';
import {
  flashBorrowReserveLiquidity,
  flashRepayReserveLiquidity,
  liquidateObligationAndRedeemReserveCollateralV2,
  refreshObligation,
  refreshReserve,
  lendingMarketAuthPda,
} from '@kamino-finance/klend-sdk';
import type { Address, Instruction, KeyPairSigner, AccountMeta } from '@solana/kit';
import { AccountRole, none, some } from '@solana/kit';
import {
  FARMS_PROGRAM,
  FLASH_SOURCE,
  KLEND_PROGRAM,
  SYSVAR_INSTRUCTIONS,
  TARGET_MARKET,
  TOKEN_PROGRAM,
  USDC_RESERVE,
  USDY_RESERVE,
} from '../config.js';

/**
 * klend instruction builders.
 *
 * Critical constraint (lending_market/flash_ixs.rs): the flash loan's borrow and
 * repay must carry IDENTICAL account lists — same length, same order. That is
 * why both instructions come out of `flashLoanPair`, never built separately.
 */

export type Pdas = { targetMarketAuth: Address; flashMarketAuth: Address };

export async function loadPdas(): Promise<Pdas> {
  const [targetMarketAuth] = await lendingMarketAuthPda(TARGET_MARKET.address, KLEND_PROGRAM);
  const [flashMarketAuth] = await lendingMarketAuthPda(FLASH_SOURCE.market, KLEND_PROGRAM);
  return { targetMarketAuth, flashMarketAuth };
}

/** `refresh_reserve`. Only Scope is configured on this market: Pyth/Switchboard = None. */
export function refreshReserveIx(reserve: Address, market: Address, scopePrices: Address): Instruction {
  return refreshReserve(
    {
      reserve,
      lendingMarket: market,
      pythOracle: none<Address>(),
      switchboardPriceOracle: none<Address>(),
      switchboardTwapOracle: none<Address>(),
      scopePrices: some(scopePrices),
    },
    undefined,
    KLEND_PROGRAM,
  ) as unknown as Instruction;
}

/**
 * `refresh_obligation`.
 *
 * The remaining accounts are positional and the program checks their exact
 * count: first ALL deposit reserves, then ALL borrow reserves, and — only if the
 * obligation has a referrer — one `referrer_token_state` per borrow.
 */
export function refreshObligationIx(args: {
  market: Address;
  obligation: Address;
  depositReserves: Address[];
  borrowReserves: Address[];
  referrerTokenStates?: Address[];
}): Instruction {
  const remaining: AccountMeta[] = [
    ...args.depositReserves,
    ...args.borrowReserves,
    ...(args.referrerTokenStates ?? []),
  ].map((address) => ({ address, role: AccountRole.WRITABLE }));

  return refreshObligation(
    { lendingMarket: args.market, obligation: args.obligation },
    remaining,
    KLEND_PROGRAM,
  ) as unknown as Instruction;
}

/**
 * Flash borrow / flash repay pair on the Main Market's USDC reserve.
 *
 * `borrowInstructionIndex` is NOT a constant: pass the real index the borrow
 * instruction occupies in the transaction's final instruction array.
 */
export function flashLoanPair(args: {
  signer: KeyPairSigner;
  flashMarketAuth: Address;
  usdcAta: Address;
  amount: bigint;
  borrowInstructionIndex: number;
}): { borrow: Instruction; repay: Instruction } {
  const common = {
    userTransferAuthority: args.signer,
    lendingMarketAuthority: args.flashMarketAuth,
    lendingMarket: FLASH_SOURCE.market,
    reserve: FLASH_SOURCE.reserve,
    reserveLiquidityMint: FLASH_SOURCE.liquidityMint,
    reserveLiquidityFeeReceiver: FLASH_SOURCE.feeVault,
    // Same placeholders in both instructions, otherwise the lists diverge.
    referrerTokenState: none<Address>(),
    referrerAccount: none<Address>(),
    sysvarInfo: SYSVAR_INSTRUCTIONS,
    tokenProgram: FLASH_SOURCE.tokenProgram,
  } as const;

  const borrow = flashBorrowReserveLiquidity(
    { liquidityAmount: new BN(args.amount.toString()) },
    { ...common, reserveSourceLiquidity: FLASH_SOURCE.supplyVault, userDestinationLiquidity: args.usdcAta },
    undefined,
    KLEND_PROGRAM,
  ) as unknown as Instruction;

  const repay = flashRepayReserveLiquidity(
    {
      liquidityAmount: new BN(args.amount.toString()),
      borrowInstructionIndex: args.borrowInstructionIndex,
    },
    { ...common, reserveDestinationLiquidity: FLASH_SOURCE.supplyVault, userSourceLiquidity: args.usdcAta },
    undefined,
    KLEND_PROGRAM,
  ) as unknown as Instruction;

  return { borrow, repay };
}

/**
 * `liquidate_obligation_and_redeem_reserve_collateral_v2`.
 *
 * V2 rather than V1: V1 uses `check_refresh_ixs!` to require the
 * `refresh_obligation_farms_for_reserve` instructions in the immediately
 * adjacent positions, which is incompatible with wrapping the call in a flash
 * loan. V2 refreshes farms via CPI and accepts absent farm accounts.
 *
 * Both Nysa reserves have farm_collateral = farm_debt =
 * 11111111111111111111111111111111 → farm accounts = none.
 */
export function liquidateIx(args: {
  signer: KeyPairSigner;
  obligation: Address;
  targetMarketAuth: Address;
  usdcAta: Address;
  cusdyAta: Address;
  usdyAta: Address;
  repayAmount: bigint;
  minReceivedUsdy: bigint;
}): Instruction {
  return liquidateObligationAndRedeemReserveCollateralV2(
    {
      liquidityAmount: new BN(args.repayAmount.toString()),
      minAcceptableReceivedLiquidityAmount: new BN(args.minReceivedUsdy.toString()),
      // only effective when liquidator == obligation.owner AND on the staging program
      maxAllowedLtvOverridePercent: new BN(0),
    },
    {
      liquidationAccounts: {
        liquidator: args.signer,
        obligation: args.obligation,
        lendingMarket: TARGET_MARKET.address,
        lendingMarketAuthority: args.targetMarketAuth,
        repayReserve: USDC_RESERVE.address,
        repayReserveLiquidityMint: USDC_RESERVE.liquidityMint,
        repayReserveLiquiditySupply: USDC_RESERVE.supplyVault,
        withdrawReserve: USDY_RESERVE.address,
        withdrawReserveLiquidityMint: USDY_RESERVE.liquidityMint,
        withdrawReserveCollateralMint: USDY_RESERVE.collateralMint,
        withdrawReserveCollateralSupply: USDY_RESERVE.collateralSupplyVault,
        withdrawReserveLiquiditySupply: USDY_RESERVE.supplyVault,
        withdrawReserveLiquidityFeeReceiver: USDY_RESERVE.feeVault,
        userSourceLiquidity: args.usdcAta,
        userDestinationCollateral: args.cusdyAta,
        userDestinationLiquidity: args.usdyAta,
        // cTokens are ALWAYS legacy SPL Token: the program types them as Program<Token>
        collateralTokenProgram: TOKEN_PROGRAM,
        repayLiquidityTokenProgram: USDC_RESERVE.tokenProgram,
        withdrawLiquidityTokenProgram: USDY_RESERVE.tokenProgram,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS,
      },
      collateralFarmsAccounts: { obligationFarmUserState: none<Address>(), reserveFarmState: none<Address>() },
      debtFarmsAccounts: { obligationFarmUserState: none<Address>(), reserveFarmState: none<Address>() },
      farmsProgram: FARMS_PROGRAM,
    },
    undefined,
    KLEND_PROGRAM,
  ) as unknown as Instruction;
}

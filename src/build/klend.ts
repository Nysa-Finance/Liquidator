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
 * Builder delle istruzioni klend.
 *
 * Vincolo critico (lending_market/flash_ixs.rs): borrow e repay del flash loan
 * devono avere elenchi account IDENTICI, stessa lunghezza e stesso ordine.
 * Per questo entrambe le ix sono costruite da `flashLoanPair`, mai separatamente.
 */

export type Pdas = { targetMarketAuth: Address; flashMarketAuth: Address };

export async function loadPdas(): Promise<Pdas> {
  const [targetMarketAuth] = await lendingMarketAuthPda(TARGET_MARKET.address, KLEND_PROGRAM);
  const [flashMarketAuth] = await lendingMarketAuthPda(FLASH_SOURCE.market, KLEND_PROGRAM);
  return { targetMarketAuth, flashMarketAuth };
}

/** `refresh_reserve`. Su questo market solo Scope è configurato: Pyth/Switchboard = None. */
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
 * I remaining accounts sono posizionali e il programma ne verifica il numero esatto:
 * prima TUTTE le deposit reserve, poi TUTTE le borrow reserve, e — solo se
 * l'obligation ha un referrer — un `referrer_token_state` per ogni borrow.
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
 * Coppia flash borrow / flash repay sulla reserve USDC del Main Market.
 *
 * `borrowInstructionIndex` NON è una costante: va passato l'indice reale che la ix
 * di borrow occupa nell'array finale della transazione.
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
    // Stessi placeholder in entrambe le ix, altrimenti gli elenchi divergono.
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
 * Si usa la V2 e non la V1: la V1 impone via `check_refresh_ixs!` che le ix
 * `refresh_obligation_farms_for_reserve` stiano nelle posizioni immediatamente
 * adiacenti, incompatibile con l'incastro del flash loan. La V2 fa il refresh
 * farm via CPI e accetta account farm assenti.
 *
 * Entrambe le reserve del market Nysa hanno farm_collateral = farm_debt =
 * 11111111111111111111111111111111 → farm accounts = null.
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
      // funziona solo se liquidator == obligation.owner E solo su programma staging
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
        // i cToken sono SEMPRE SPL Token legacy: il programma li tipizza Program<Token>
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

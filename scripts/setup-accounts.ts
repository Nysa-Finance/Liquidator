/**
 * One-off on-chain setup for the liquidator wallet.
 *
 * Creates the three token accounts the transaction needs, and an Address Lookup
 * Table holding every fixed account it touches. Both are prerequisites for a
 * mainnet send: without the token accounts every simulation fails, and without
 * the table the serialized transaction is 1509 bytes against a 1232-byte limit.
 *
 * THIS SCRIPT SPENDS SOL. It pays rent for three token accounts (~0.002 SOL
 * each) and for the lookup table, and it signs with KEYPAIR_PATH. It prints the
 * plan and stops unless you pass --confirm.
 *
 *   npm run setup                     # show what it would do
 *   npm run setup -- --confirm        # actually create
 *
 * A lookup table is usable one slot after creation and cannot be closed for
 * ~512 slots after deactivation, so treat the address it prints as permanent:
 * put it in LOOKUP_TABLE in your .env.
 */
import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  getCreateLookupTableInstructionAsync,
  getExtendLookupTableInstruction,
} from '@solana-program/address-lookup-table';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { getAssociatedTokenAddress } from '@kamino-finance/klend-sdk';
import {
  CFG,
  FARMS_PROGRAM,
  FLASH_SOURCE,
  KLEND_PROGRAM,
  MEMO_PROGRAM,
  ORCA_POOL,
  SOL_PRICE_FEED,
  SYSVAR_INSTRUCTIONS,
  TARGET_MARKET,
  TOKEN_PROGRAM,
  USDC_RESERVE,
  USDY_RESERVE,
  WHIRLPOOL_PROGRAM_ID,
} from '../src/config.js';
import { loadSigner } from '../src/rpc.js';
import { loadPdas } from '../src/build/klend.js';
import { tickArrayAddresses } from '../src/build/orca.js';

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const rpc = createSolanaRpc(CFG.rpcPrimary);
  const signer = await loadSigner();

  const atas = {
    USDC: await getAssociatedTokenAddress(USDC_RESERVE.liquidityMint, signer.address, TOKEN_PROGRAM),
    USDY: await getAssociatedTokenAddress(USDY_RESERVE.liquidityMint, signer.address, TOKEN_PROGRAM),
    cUSDY: await getAssociatedTokenAddress(USDY_RESERVE.collateralMint, signer.address, TOKEN_PROGRAM),
  };
  const mints: Record<string, Address> = {
    USDC: USDC_RESERVE.liquidityMint,
    USDY: USDY_RESERVE.liquidityMint,
    cUSDY: USDY_RESERVE.collateralMint,
  };

  const pdas = await loadPdas();
  const pool = await rpc.getAccountInfo(ORCA_POOL.address, { encoding: 'base64' }).send();
  if (!pool.value) throw new Error('Orca pool not found');
  const poolData = Buffer.from((pool.value.data as [string, string])[0], 'base64');
  // tickCurrentIndex is an i32 at offset 80 of the Whirlpool account
  const tickArrays = await tickArrayAddresses(
    ORCA_POOL.address,
    poolData.readInt32LE(80),
    ORCA_POOL.tickSpacing,
  );

  // Every account that never changes between liquidations. The obligation and
  // the blockhash stay outside: those differ per transaction.
  const tableEntries: Address[] = [
    KLEND_PROGRAM, WHIRLPOOL_PROGRAM_ID, FARMS_PROGRAM, TOKEN_PROGRAM, MEMO_PROGRAM, SYSVAR_INSTRUCTIONS,
    TARGET_MARKET.address, pdas.targetMarketAuth,
    USDY_RESERVE.scopeFeed, USDC_RESERVE.scopeFeed, SOL_PRICE_FEED,
    USDC_RESERVE.address, USDC_RESERVE.liquidityMint, USDC_RESERVE.supplyVault, USDC_RESERVE.feeVault, USDC_RESERVE.collateralMint,
    USDY_RESERVE.address, USDY_RESERVE.liquidityMint, USDY_RESERVE.supplyVault, USDY_RESERVE.feeVault,
    USDY_RESERVE.collateralMint, USDY_RESERVE.collateralSupplyVault,
    FLASH_SOURCE.market, FLASH_SOURCE.reserve, FLASH_SOURCE.liquidityMint, FLASH_SOURCE.supplyVault,
    FLASH_SOURCE.feeVault, pdas.flashMarketAuth,
    ORCA_POOL.address, ORCA_POOL.tokenMintA, ORCA_POOL.tokenMintB, ORCA_POOL.tokenVaultA, ORCA_POOL.tokenVaultB,
    ...tickArrays,
    atas.USDC, atas.USDY, atas.cUSDY,
  ];
  const unique = [...new Set(tableEntries)];

  console.log(`wallet            ${signer.address}`);
  console.log(`token accounts    ${Object.entries(atas).map(([k, v]) => `${k}=${v}`).join('\n                  ')}`);
  console.log(`lookup table      ${unique.length} addresses`);

  const missing: string[] = [];
  for (const [name, ata] of Object.entries(atas)) {
    const acc = await rpc.getAccountInfo(ata, { encoding: 'base64' }).send();
    if (!acc.value) missing.push(name);
  }
  console.log(`to create         ${missing.length ? missing.join(', ') : 'none, all token accounts exist'}`);

  if (!CONFIRM) {
    console.log('\nnothing done. Re-run with --confirm to create these on-chain.');
    return;
  }

  const slot = await rpc.getSlot({ commitment: 'finalized' }).send();
  const createTable = await getCreateLookupTableInstructionAsync({ authority: signer, payer: signer, recentSlot: slot });
  const tableAddress = createTable.accounts[0].address as Address;

  const send = async (ixs: Instruction[], label: string) => {
    const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const wire = getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(msg));
    const sig = await rpc.sendTransaction(wire as never, { encoding: 'base64' }).send();
    console.log(`${label}: ${sig}`);
  };

  const ataIxs = Object.entries(atas)
    .filter(([name]) => missing.includes(name))
    .map(([name, ata]) =>
      getCreateAssociatedTokenIdempotentInstruction({
        payer: signer,
        ata,
        owner: signer.address,
        mint: mints[name]!,
        tokenProgram: TOKEN_PROGRAM,
      }) as unknown as Instruction,
    );
  if (ataIxs.length) await send(ataIxs, 'token accounts');

  await send([createTable as unknown as Instruction], 'lookup table created');

  // Extend in chunks: each address is 32 bytes and the extend instruction has
  // to fit in a transaction of its own.
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    await send(
      [
        getExtendLookupTableInstruction({
          address: tableAddress,
          authority: signer,
          payer: signer,
          addresses: chunk,
        }) as unknown as Instruction,
      ],
      `lookup table extended (+${chunk.length})`,
    );
  }

  console.log(`\nLOOKUP_TABLE=${tableAddress}`);
  console.log('Put that in your .env. It is usable from the next slot onward.');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

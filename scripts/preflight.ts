/**
 * Readiness check before going to production.
 *
 * READ-ONLY: it uses the allowlisted client, so it can neither sign nor submit.
 * It walks every condition that must hold for the bot to work on the target
 * market and reports which ones are missing.
 *
 *   npm run preflight
 *   RPC=https://... WALLET=<pubkey> npm run preflight
 */
import { readFile } from 'node:fs/promises';
import { address, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import {
  LendingMarket,
  Reserve,
  getAssociatedTokenAddress,
} from '@kamino-finance/klend-sdk';
import {
  FLASH_SOURCE,
  KLEND_PROGRAM,
  ORCA_POOL,
  TARGET_MARKET,
  USDC_RESERVE,
  USDY_RESERVE,
} from '../src/config.js';
import { createReadOnlyRpc } from '../src/readonly.js';
import { OBLIGATION_ACCOUNT_SIZE, OBLIGATION_OFFSETS, scanObligationHealth, sfToUsd } from '../src/scanner.js';
import { loadOrcaContext, spotPrice } from '../src/build/orca.js';

const RPC = process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com';
const rpc = createReadOnlyRpc(RPC);

type Check = { ok: boolean; blocking: boolean; label: string; detail: string };
const checks: Check[] = [];
const add = (ok: boolean, blocking: boolean, label: string, detail: string) =>
  checks.push({ ok, blocking, label, detail });

async function data(pk: Address): Promise<Buffer | null> {
  const r = await rpc.getAccountInfo(pk, { encoding: 'base64' }).send();
  return r.value ? Buffer.from((r.value.data as [string, string])[0], 'base64') : null;
}

async function walletAddress(): Promise<Address | null> {
  if (process.env.WALLET) return address(process.env.WALLET);
  const path = process.env.KEYPAIR_PATH;
  if (!path) return null;
  try {
    const bytes = Uint8Array.from(JSON.parse(await readFile(path, 'utf8')) as number[]);
    const signer = await createKeyPairSignerFromBytes(bytes);
    return signer.address; // public half only; the private key never leaves this function
  } catch {
    return null;
  }
}

async function main() {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const now = Math.floor(Date.now() / 1000);
  console.log(`preflight — slot ${slot} — ${RPC.replace(/api-key=.*/, 'api-key=***')}\n`);

  // ── 1. the market is open and liquidatable ───────────────────────────────
  const mBuf = await data(TARGET_MARKET.address);
  if (!mBuf) {
    add(false, true, 'market exists', `${TARGET_MARKET.address} not found`);
  } else {
    const m = LendingMarket.decode(mBuf);
    add(m.emergencyMode === 0, true, 'emergency mode off', `emergencyMode=${m.emergencyMode}`);
    add(
      m.priceTriggeredLiquidationDisabled === 0,
      true,
      'price-triggered liquidations enabled',
      `priceTriggeredLiquidationDisabled=${m.priceTriggeredLiquidationDisabled}`,
    );
    add(
      String(m.permissioningAuthority) === '11111111111111111111111111111111',
      true,
      'market is permissionless',
      `permissioningAuthority=${m.permissioningAuthority}`,
    );
    add(
      m.liquidationMaxDebtCloseFactorPct === TARGET_MARKET.liquidationMaxDebtCloseFactorPct,
      false,
      'close factor unchanged',
      `on-chain ${m.liquidationMaxDebtCloseFactorPct}%, in config ${TARGET_MARKET.liquidationMaxDebtCloseFactorPct}%`,
    );
  }

  // ── 2. the reserves make economic sense ──────────────────────────────────
  const usdyBuf = await data(USDY_RESERVE.address);
  const usdcBuf = await data(USDC_RESERVE.address);
  if (!usdyBuf || !usdcBuf) {
    add(false, true, 'reserves loaded', 'one of the two reserves does not exist');
  } else {
    const usdy = Reserve.decode(usdyBuf);
    const usdc = Reserve.decode(usdcBuf);

    const usdyAvail = Number(usdy.liquidity.totalAvailableAmount) / 1e6;
    const usdcAvail = Number(usdc.liquidity.totalAvailableAmount) / 1e6;
    add(usdyAvail >= 100, true, 'USDY liquidity enough to redeem', `${usdyAvail.toFixed(2)} USDY in the vault`);
    add(usdcAvail >= 0, false, 'USDC liquidity in the market', `${usdcAvail.toFixed(2)} USDC in the vault`);

    add(
      usdy.config.status === 0,
      true,
      'USDY reserve active',
      `status=${usdy.config.status} (0 = active)`,
    );
    add(
      usdy.config.maxLiquidationBonusBps > 0,
      true,
      'liquidation bonus not zeroed',
      `${usdy.config.minLiquidationBonusBps}–${usdy.config.maxLiquidationBonusBps} bps`,
    );

    // ── 3. the oracle reports a believable USDY price ──────────────────────
    const feed = String(usdy.config.tokenInfo.scopeConfiguration.priceFeed) as Address;
    const idx = usdy.config.tokenInfo.scopeConfiguration.priceChain[0] ?? 65535;
    const scopeBuf = await data(feed);
    if (!scopeBuf || idx === 65535) {
      add(false, true, 'USDY oracle configured', `feed=${feed} chain[0]=${idx}`);
    } else {
      const o = 8 + 32 + idx * 56;
      const px = Number(scopeBuf.readBigUInt64LE(o)) / 10 ** Number(scopeBuf.readBigUInt64LE(o + 8));
      const age = now - Number(scopeBuf.readBigUInt64LE(o + 24));
      add(
        px > 0.5 && px < 5,
        true,
        'USDY oracle price believable',
        `Scope index ${idx} → ${px} USD (expected ~1.14)`,
      );
      add(
        age < Number(usdy.config.tokenInfo.maxAgePriceSeconds),
        true,
        'oracle price is fresh',
        `${age}s old, limit ${usdy.config.tokenInfo.maxAgePriceSeconds}s`,
      );
    }
  }

  // ── 4. there are positions to liquidate ──────────────────────────────────
  const obs = await rpc
    .getProgramAccounts(KLEND_PROGRAM, {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: BigInt(OBLIGATION_ACCOUNT_SIZE) },
        { memcmp: { offset: BigInt(OBLIGATION_OFFSETS.lendingMarket), bytes: TARGET_MARKET.address as never, encoding: 'base58' } },
      ],
    })
    .send();
  const nObs = (obs as unknown as unknown[]).length;
  add(nObs > 0, true, 'the market has open positions', `${nObs} obligations`);

  if (nObs > 0) {
    const rows = await scanObligationHealth(rpc, TARGET_MARKET.address, KLEND_PROGRAM, { minDebtUsd: 10 });
    const over = rows.filter((r) => r.healthRatio >= 1);
    add(
      rows.length > 0,
      false,
      'positions with meaningful debt',
      `${rows.length} with debt >= $10, ${over.length} above threshold` +
        (rows[0] ? ` (best: ${(rows[0].healthRatio * 100).toFixed(1)}% of threshold, $${sfToUsd(rows[0].debtValueSf).toFixed(0)})` : ''),
    );
  }

  // ── 5. the flash loan source is usable ───────────────────────────────────
  const flashBuf = await data(FLASH_SOURCE.reserve);
  if (!flashBuf) {
    add(false, true, 'flash loan reserve', `${FLASH_SOURCE.reserve} not found`);
  } else {
    const f = Reserve.decode(flashBuf);
    const feeSf = BigInt(f.config.fees.flashLoanFeeSf.toString());
    const avail = Number(f.liquidity.totalAvailableAmount) / 1e6;
    add(feeSf !== 2n ** 64n - 1n, true, 'flash loans enabled', `flashLoanFeeSf=${feeSf}`);
    add(
      Math.abs(Number(feeSf) / 2 ** 60 - FLASH_SOURCE.flashLoanFeeRate) < 1e-12,
      false,
      'flash loan fee unchanged',
      `${((Number(feeSf) / 2 ** 60) * 100).toFixed(5)}%`,
    );
    add(avail > 10_000, true, 'flash loan liquidity', `${avail.toFixed(0)} USDC available`);
  }

  // ── 6. the Orca exit route exists and is healthy ─────────────────────────
  try {
    const ctx = await loadOrcaContext(rpc, slot);
    const spot = spotPrice(ctx.pool);
    add(ctx.pool.liquidity > 0n, true, 'Orca pool has in-range liquidity', `L=${ctx.pool.liquidity}`);
    add(spot > 0.5 && spot < 5, true, 'Orca price believable', `${spot.toFixed(6)} USDC/USDY`);
    const vaultB = await rpc.getTokenAccountBalance(ORCA_POOL.tokenVaultB).send();
    add(
      Number(vaultB.value.uiAmountString) > 50_000,
      false,
      'pool USDC side is deep',
      `${Number(vaultB.value.uiAmountString).toFixed(0)} USDC`,
    );
  } catch (e) {
    add(false, true, 'Orca pool readable', String(e));
  }

  // ── 7. the wallet is ready ───────────────────────────────────────────────
  const wallet = await walletAddress();
  if (!wallet) {
    add(false, true, 'wallet configured', 'set KEYPAIR_PATH in .env (or WALLET=<pubkey> for the check alone)');
  } else {
    const lamports = await rpc.getBalance(wallet, { commitment: 'confirmed' }).send();
    const sol = Number(lamports.value) / 1e9;
    add(sol >= 0.1, true, 'SOL for fees and rent', `${sol.toFixed(4)} SOL on ${wallet}`);

    const atas = {
      USDC: await getAssociatedTokenAddress(USDC_RESERVE.liquidityMint, wallet, USDC_RESERVE.tokenProgram),
      USDY: await getAssociatedTokenAddress(USDY_RESERVE.liquidityMint, wallet, USDY_RESERVE.tokenProgram),
      cUSDY: await getAssociatedTokenAddress(USDY_RESERVE.collateralMint, wallet, USDY_RESERVE.tokenProgram),
    };
    for (const [name, ata] of Object.entries(atas)) {
      const acc = await data(ata as Address);
      let frozen = false;
      if (acc && acc.length >= 165) frozen = acc.readUInt8(108) === 2;
      add(acc !== null && !frozen, true, `${name} account exists and is not frozen`, `${ata}${frozen ? ' — FROZEN' : acc ? '' : ' — needs creating'}`);
    }
  }

  // ── 8. execution mode ────────────────────────────────────────────────────
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  add(true, false, 'mode', dryRun ? 'DRY_RUN on (nothing submitted)' : '⚠ DRY_RUN OFF: real submissions');

  // ── report ───────────────────────────────────────────────────────────────
  const pad = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    const mark = c.ok ? '✅' : c.blocking ? '❌' : '⚠️ ';
    console.log(`${mark} ${c.label.padEnd(pad)}  ${c.detail}`);
  }

  const blockers = checks.filter((c) => !c.ok && c.blocking);
  const warnings = checks.filter((c) => !c.ok && !c.blocking);
  console.log();
  if (blockers.length === 0) {
    console.log(`READY — no blockers${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`);
  } else {
    console.log(`NOT READY — ${blockers.length} blocker(s):`);
    for (const b of blockers) console.log(`   • ${b.label}: ${b.detail}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});

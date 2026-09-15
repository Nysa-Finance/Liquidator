/**
 * Readiness check before going to production.
 *
 * READ-ONLY: it uses the allowlisted client, so it can neither sign nor submit.
 *
 * Two modes:
 *
 *   npm run preflight                  the configured target market, every check
 *                                      including the USDY/USDC pair and the Orca exit
 *   MARKET=<pubkey> npm run preflight  any other market: the checks that apply to
 *                                      any market, with a per-reserve breakdown
 *
 *   RPC=https://... WALLET=<pubkey> npm run preflight
 */
import { readFile } from 'node:fs/promises';
import { address, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { LendingMarket, Reserve, getAssociatedTokenAddress } from '@kamino-finance/klend-sdk';
import {
  FLASH_SOURCE,
  KLEND_PROGRAM,
  ORCA_POOL,
  TARGET_MARKET,
  USDC_RESERVE,
  USDY_RESERVE,
} from '../src/config.js';
import { createReadOnlyRpc } from '../src/readonly.js';
import {
  OBLIGATION_ACCOUNT_SIZE,
  OBLIGATION_OFFSETS,
  scanObligationHealth,
  sfToUsd,
} from '../src/scanner.js';
import { loadOrcaContext, spotPrice } from '../src/build/orca.js';

const RPC = process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com';
const rpc = createReadOnlyRpc(RPC);

const MARKET = address(process.env.MARKET ?? TARGET_MARKET.address);
/** The pair-specific and Orca checks only mean something on the configured market. */
const IS_TARGET = MARKET === TARGET_MARKET.address;

const RESERVE_ACCOUNT_SIZE = 8624;

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

type LoadedReserve = { pubkey: Address; state: ReturnType<typeof Reserve.decode> };

async function loadReserves(market: Address): Promise<LoadedReserve[]> {
  const list = (await rpc
    .getProgramAccounts(KLEND_PROGRAM, {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: BigInt(RESERVE_ACCOUNT_SIZE) },
        { memcmp: { offset: 32n, bytes: market as never, encoding: 'base58' } },
      ],
    })
    .send()) as unknown as { pubkey: Address }[];

  const out: LoadedReserve[] = [];
  const keys = list.map((a) => a.pubkey);
  for (let i = 0; i < keys.length; i += 100) {
    const batch = await rpc.getMultipleAccounts(keys.slice(i, i + 100), { encoding: 'base64' }).send();
    batch.value.forEach((acc, j) => {
      if (!acc) return;
      out.push({
        pubkey: keys[i + j]!,
        state: Reserve.decode(Buffer.from((acc.data as [string, string])[0], 'base64')),
      });
    });
  }
  return out;
}

/** Reads one Scope price entry. Layout: disc(8) + oracle_mappings(32) + [DatedPrice; 512], 56 bytes each. */
function scopePrice(feed: Buffer, index: number): { price: number; ageSeconds: number } {
  const o = 8 + 32 + index * 56;
  const price = Number(feed.readBigUInt64LE(o)) / 10 ** Number(feed.readBigUInt64LE(o + 8));
  return { price, ageSeconds: Math.floor(Date.now() / 1000) - Number(feed.readBigUInt64LE(o + 24)) };
}

const symbolOf = (r: LoadedReserve) =>
  Buffer.from(r.state.config.tokenInfo.name).toString('utf8').replace(/\0/g, '') || '?';

async function main() {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  console.log(`preflight — slot ${slot} — ${RPC.replace(/api-key=.*/, 'api-key=***')}`);
  console.log(`market ${MARKET}${IS_TARGET ? ` (${TARGET_MARKET.name})` : ' — generic mode'}\n`);

  // ── 1. the market is open and liquidatable ───────────────────────────────
  const mBuf = await data(MARKET);
  if (!mBuf) {
    add(false, true, 'market exists', `${MARKET} not found`);
  } else {
    const m = LendingMarket.decode(mBuf);
    const name = Buffer.from(m.name ?? []).toString('utf8').replace(/\0/g, '');
    add(true, false, 'market name', name || '(unnamed)');
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
      true,
      false,
      'close factor',
      `${m.liquidationMaxDebtCloseFactorPct}% (100% above ${m.insolvencyRiskUnhealthyLtvPct}% LTV)`,
    );
    if (IS_TARGET) {
      add(
        m.liquidationMaxDebtCloseFactorPct === TARGET_MARKET.liquidationMaxDebtCloseFactorPct,
        false,
        'close factor unchanged',
        `on-chain ${m.liquidationMaxDebtCloseFactorPct}%, in config ${TARGET_MARKET.liquidationMaxDebtCloseFactorPct}%`,
      );
    }
  }

  // ── 2. the reserves ──────────────────────────────────────────────────────
  const reserves = await loadReserves(MARKET);
  add(reserves.length > 0, true, 'market has reserves', `${reserves.length} reserves`);

  const inactive = reserves.filter((r) => r.state.config.status !== 0);
  add(inactive.length === 0, false, 'all reserves active', inactive.length === 0
    ? `${reserves.length} active`
    : `${inactive.length} not active: ${inactive.map(symbolOf).join(', ')}`);

  // Oracle sanity per reserve: a price of zero, or one far older than its own
  // max age, makes every position in that reserve unusable.
  //
  // Only reserves a liquidator could actually touch are checked. A retired
  // reserve legitimately has a dead oracle: on the Main Market, CHAI, STEP,
  // xSTEP and the old kSOL LP reserves all point at Scope index 3, which reads
  // exactly 0.000001 USD — Kamino's "this asset is retired" marker.
  //
  // Retired means either status != active, or usable as neither collateral
  // (liquidationThresholdPct = 0) nor debt (borrowLimit = 0). Note that a
  // debt-only reserve has liquidationThresholdPct = 0 with a real borrow limit,
  // and its oracle very much does matter — hence both conditions.
  const feedCache = new Map<string, Buffer | null>();
  const oracleProblems: string[] = [];
  for (const r of reserves) {
    const cf = r.state.config;
    if (cf.status !== 0) continue;
    if (cf.liquidationThresholdPct === 0 && BigInt(cf.borrowLimit.toString()) === 0n) continue;
    const cfg = cf.tokenInfo.scopeConfiguration;
    const feedKey = String(cfg.priceFeed);
    const idx = cfg.priceChain[0] ?? 65535;
    if (feedKey === '11111111111111111111111111111111' || idx === 65535) continue; // Pyth/Switchboard reserve
    if (!feedCache.has(feedKey)) feedCache.set(feedKey, await data(address(feedKey)));
    const feed = feedCache.get(feedKey);
    if (!feed) continue;
    const { price, ageSeconds } = scopePrice(feed, idx);
    const maxAge = Number(cf.tokenInfo.maxAgePriceSeconds);
    if (price <= 0 || price < 1e-4) oracleProblems.push(`${symbolOf(r)} idx ${idx} = ${price} USD`);
    else if (ageSeconds > maxAge) oracleProblems.push(`${symbolOf(r)} price ${ageSeconds}s old (limit ${maxAge}s)`);
  }
  add(
    oracleProblems.length === 0,
    true,
    'every usable reserve has a live oracle price',
    oracleProblems.length === 0
      ? `${reserves.length} reserves, retired ones skipped`
      : oracleProblems.join('; '),
  );

  // Compact per-reserve table, capped so a 58-reserve market stays readable.
  const shown = [...reserves]
    .sort((a, b) => Number(b.state.liquidity.totalAvailableAmount) - Number(a.state.liquidity.totalAvailableAmount))
    .slice(0, IS_TARGET ? reserves.length : 12);
  console.log('reserves (by available liquidity)');
  console.log('  symbol      ltv  liqThr  bonus bps   available        borrowed');
  for (const r of shown) {
    const c = r.state.config;
    const dec = 10 ** Number(r.state.liquidity.mintDecimals);
    const avail = Number(r.state.liquidity.totalAvailableAmount) / dec;
    const borrowed = Number(r.state.liquidity.borrowedAmountSf) / 2 ** 60 / dec;
    console.log(
      `  ${symbolOf(r).padEnd(10)} ${String(c.loanToValuePct).padStart(4)} ${String(c.liquidationThresholdPct).padStart(7)}` +
        `   ${String(c.minLiquidationBonusBps).padStart(4)}-${String(c.maxLiquidationBonusBps).padEnd(4)}` +
        ` ${avail.toFixed(2).padStart(15)} ${borrowed.toFixed(2).padStart(15)}`,
    );
  }
  if (shown.length < reserves.length) console.log(`  … and ${reserves.length - shown.length} more`);
  console.log();

  // ── 3. the configured pair (target market only) ──────────────────────────
  if (IS_TARGET) {
    const usdy = reserves.find((r) => r.pubkey === USDY_RESERVE.address);
    const usdc = reserves.find((r) => r.pubkey === USDC_RESERVE.address);
    if (!usdy || !usdc) {
      add(false, true, 'configured reserve pair present', 'USDY or USDC reserve not found in this market');
    } else {
      const usdyAvail = Number(usdy.state.liquidity.totalAvailableAmount) / 1e6;
      add(usdyAvail >= 100, true, 'USDY liquidity enough to redeem', `${usdyAvail.toFixed(2)} USDY in the vault`);
      add(
        usdy.state.config.maxLiquidationBonusBps > 0,
        true,
        'liquidation bonus not zeroed',
        `${usdy.state.config.minLiquidationBonusBps}-${usdy.state.config.maxLiquidationBonusBps} bps`,
      );
      add(
        String(usdy.state.liquidity.supplyVault) === USDY_RESERVE.supplyVault &&
          String(usdy.state.collateral.mintPubkey) === USDY_RESERVE.collateralMint,
        true,
        'USDY vault and cToken mint unchanged',
        'match src/config.ts',
      );
    }
  }

  // ── 4. positions to liquidate ────────────────────────────────────────────
  const obs = await rpc
    .getProgramAccounts(KLEND_PROGRAM, {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: BigInt(OBLIGATION_ACCOUNT_SIZE) },
        { memcmp: { offset: BigInt(OBLIGATION_OFFSETS.lendingMarket), bytes: MARKET as never, encoding: 'base58' } },
      ],
    })
    .send();
  const nObs = (obs as unknown as unknown[]).length;
  add(nObs > 0, true, 'the market has open positions', `${nObs} obligations`);

  if (nObs > 0) {
    const rows = await scanObligationHealth(rpc, MARKET, KLEND_PROGRAM, { minDebtUsd: 10 });
    const over = rows.filter((r) => r.healthRatio >= 1);
    add(
      rows.length > 0,
      false,
      'positions with meaningful debt',
      `${rows.length} with debt >= $10, ${over.length} above threshold`,
    );
    if (over.length > 0) {
      console.log('liquidation candidates (last saved state, not current prices)');
      for (const r of over.slice(0, 5)) {
        console.log(
          `  ${r.obligation}  ${(r.healthRatio * 100).toFixed(1)}% of threshold  $${sfToUsd(r.debtValueSf).toFixed(2)} debt`,
        );
      }
      console.log();
    }
  }

  // ── 5. the flash loan source ─────────────────────────────────────────────
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

  // ── 6. the Orca exit route (target market only) ──────────────────────────
  if (IS_TARGET) {
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
  }

  // ── 7. the wallet ────────────────────────────────────────────────────────
  const wallet = await walletAddress();
  if (!wallet) {
    add(false, true, 'wallet configured', 'set KEYPAIR_PATH in .env (or WALLET=<pubkey> for the check alone)');
  } else {
    const lamports = await rpc.getBalance(wallet, { commitment: 'confirmed' }).send();
    const sol = Number(lamports.value) / 1e9;
    add(sol >= 0.1, true, 'SOL for fees and rent', `${sol.toFixed(4)} SOL on ${wallet}`);

    if (IS_TARGET) {
      const atas = {
        USDC: await getAssociatedTokenAddress(USDC_RESERVE.liquidityMint, wallet, USDC_RESERVE.tokenProgram),
        USDY: await getAssociatedTokenAddress(USDY_RESERVE.liquidityMint, wallet, USDY_RESERVE.tokenProgram),
        cUSDY: await getAssociatedTokenAddress(USDY_RESERVE.collateralMint, wallet, USDY_RESERVE.tokenProgram),
      };
      for (const [name, ata] of Object.entries(atas)) {
        const acc = await data(ata as Address);
        const frozen = acc !== null && acc.length >= 165 && acc.readUInt8(108) === 2;
        add(
          acc !== null && !frozen,
          true,
          `${name} account exists and is not frozen`,
          `${ata}${frozen ? ' — FROZEN' : acc ? '' : ' — needs creating'}`,
        );
      }
    }
  }

  // ── 8. execution mode ────────────────────────────────────────────────────
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  add(true, false, 'mode', dryRun ? 'DRY_RUN on (nothing submitted)' : 'DRY_RUN OFF: real submissions');

  // ── report ───────────────────────────────────────────────────────────────
  const pad = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    const mark = c.ok ? 'OK ' : c.blocking ? 'X  ' : '!  ';
    console.log(`${mark} ${c.label.padEnd(pad)}  ${c.detail}`);
  }

  const blockers = checks.filter((c) => !c.ok && c.blocking);
  const warnings = checks.filter((c) => !c.ok && !c.blocking);
  console.log();
  if (!IS_TARGET) {
    console.log('generic mode: the USDY/USDC pair and the Orca exit were not checked.');
  }
  if (blockers.length === 0) {
    console.log(`READY — no blockers${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`);
  } else {
    console.log(`NOT READY — ${blockers.length} blocker(s):`);
    for (const b of blockers) console.log(`   - ${b.label}: ${b.detail}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});

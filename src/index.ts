import { Decimal } from 'decimal.js';
import { KaminoMarket, getCurrentLedgerInstant, type KaminoObligation } from '@kamino-finance/klend-sdk';
import { address, fetchAddressesForLookupTables, type Address } from '@solana/kit';
import {
  CFG,
  validateConfig,
  KLEND_PROGRAM,
  TARGET_MARKET,
  USDC_RESERVE,
  USDY_RESERVE,
  FLASH_SOURCE,
  ORCA_POOL,
} from './config.js';
import { log } from './logger.js';
import { loadSigner, makeRpcPool, type RpcPool } from './rpc.js';
import { evaluate } from './eligibility.js';
import { buildPlan } from './profit.js';
import { loadOrcaContext } from './build/orca.js';
import { loadPdas } from './build/klend.js';
import { buildLiquidationMessage, type Atas, type LookupTables } from './build/tx.js';
import {
  InFlightGuard,
  PriorityFeeOracle,
  Quarantine,
  readFlashLiquidity,
  sendAndConfirm,
  signToWire,
  simulate,
} from './execute.js';

const RECENT_SLOT_DURATION_MS = 450;
const DEFAULT_CU_LIMIT = 420_000;

async function findAtas(owner: Address): Promise<Atas> {
  const { getAssociatedTokenAddress } = await import('@kamino-finance/klend-sdk');
  const [usdc, usdy, cusdy] = await Promise.all([
    getAssociatedTokenAddress(USDC_RESERVE.liquidityMint, owner, USDC_RESERVE.tokenProgram),
    getAssociatedTokenAddress(USDY_RESERVE.liquidityMint, owner, USDY_RESERVE.tokenProgram),
    getAssociatedTokenAddress(USDY_RESERVE.collateralMint, owner, USDY_RESERVE.tokenProgram),
  ]);
  return { usdc, usdy, cusdy };
}

async function tick(ctx: {
  pool: RpcPool;
  market: KaminoMarket;
  signer: Awaited<ReturnType<typeof loadSigner>>;
  atas: Atas;
  pdas: Awaited<ReturnType<typeof loadPdas>>;
  fees: PriorityFeeOracle;
  guard: InFlightGuard;
  quarantine: Quarantine;
  lookupTables: LookupTables | undefined;
}): Promise<void> {
  const rpc = ctx.pool.active();
  // slot and blockTime read at the same commitment: one coherent snapshot,
  // not two disconnected reads
  const instant = await getCurrentLedgerInstant(rpc, 'processed');
  const slot = instant.slot;
  const nowSeconds = BigInt(instant.blockTime);

  await ctx.market.refreshAll();

  const debtReserve = ctx.market.getReserveByAddress(USDC_RESERVE.address);
  const collReserve = ctx.market.getReserveByAddress(USDY_RESERVE.address);
  if (!debtReserve || !collReserve) {
    log.error('reserves not found in the market — misconfiguration');
    return;
  }

  // The curator can attach a farm at any time. liquidateV2 passes both farm
  // pairs as none(), which is only correct while these two stay unset — so it
  // is checked every tick, not only in preflight.
  const NONE = '11111111111111111111111111111111';
  if (String(collReserve.state.farmCollateral) !== NONE || String(debtReserve.state.farmDebt) !== NONE) {
    log.error(
      { collateralFarm: collReserve.state.farmCollateral, debtFarm: debtReserve.state.farmDebt },
      'a farm was attached to the collateral or debt side — liquidateV2 would revert, refusing to plan',
    );
    return;
  }

  // The flash source sits in a different lending market, so it is not in this
  // market's reserve map and has to be read on its own.
  const flashAvailable = await readFlashLiquidity(rpc);

  const obligations: KaminoObligation[] = await ctx.market.getAllObligationsForMarket(instant);
  log.debug({ slot: slot.toString(), obligations: obligations.length }, 'scan');

  if (obligations.length === 0) return;

  const orca = await loadOrcaContext(rpc, slot);

  for (const ob of obligations) {
    const key = ob.obligationAddress as string;

    if (ctx.quarantine.isHeld(key, slot)) continue;

    const elig = evaluate(ctx.market, ob, debtReserve, collReserve);
    if (!elig.ok) {
      log.trace({ obligation: key, reason: elig.reason }, 'not liquidatable');
      continue;
    }

    const planRes = buildPlan({
      market: ctx.market,
      obligation: ob,
      debtReserve,
      collReserve,
      eligibility: elig,
      orca,
      slot,
      nowSeconds,
      fixedCostUsdc: new Decimal(0.01),
      flashAvailable,
    });
    if (!planRes.ok) {
      log.debug({ obligation: key, reason: planRes.reason }, 'plan rejected');
      continue;
    }
    const plan = planRes.plan;

    if (!ctx.guard.tryAcquire(key)) {
      log.debug({ obligation: key }, 'already in flight, skipping');
      continue;
    }

    try {
      const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();

      const message = buildLiquidationMessage({
        signer: ctx.signer,
        pdas: ctx.pdas,
        atas: ctx.atas,
        obligation: ob,
        plan,
        orca,
        blockhash: bh,
        computeUnitLimit: DEFAULT_CU_LIMIT,
        computeUnitPriceMicroLamports: 1_000n,
        lookupTables: ctx.lookupTables,
      });

      const wire = await signToWire(message);
      const balBefore = await rpc
        .getTokenAccountBalance(ctx.atas.usdc)
        .send()
        .then((r) => BigInt(r.value.amount))
        .catch(() => 0n);

      const sim = await simulate(rpc, wire, ctx.atas.usdc, balBefore);
      if (!sim.ok) {
        ctx.quarantine.record(key, slot, JSON.stringify(sim.err));
        log.warn(
          { obligation: key, err: sim.err, logs: sim.logs.slice(-8) },
          'simulation failed — not submitting',
        );
        continue;
      }

      const simProfitUsdc = sim.usdcDelta === null
        ? null
        : new Decimal(sim.usdcDelta.toString()).div(10 ** USDC_RESERVE.decimals);

      if (simProfitUsdc !== null && simProfitUsdc.lt(CFG.minProfitUsdc)) {
        log.warn(
          { obligation: key, simProfitUsdc: simProfitUsdc.toString() },
          'simulated profit below threshold — not submitting',
        );
        continue;
      }

      log.info(
        {
          obligation: key,
          repayUsdc: (Number(plan.repayAmount) / 1e6).toFixed(6),
          bonusBps: plan.bonusRate.mul(10_000).toFixed(0),
          rho: plan.oracleRatio.toFixed(6),
          expectedProfit: plan.expectedProfitUsdc.toFixed(6),
          simProfit: simProfitUsdc?.toFixed(6) ?? 'n/a',
          cu: sim.unitsConsumed,
        },
        'plan accepted',
      );

      if (CFG.dryRun) {
        log.info('DRY_RUN enabled: nothing submitted');
        continue;
      }

      // rebuild with measured CU and the chosen priority fee
      const cuLimit = Math.ceil(sim.unitsConsumed * 1.15);
      const priorityPrice = await ctx.fees.suggest(
        rpc,
        [plan.obligation, USDC_RESERVE.address, USDY_RESERVE.address, FLASH_SOURCE.reserve, ORCA_POOL.address],
        cuLimit,
        plan.expectedProfitUsdc,
        /* solPriceUsdc */ 150,
      );

      // Everything above was decided on `slot`. If the chain has moved on since,
      // the prices behind the plan are no longer the prices it will execute at.
      const nowSlot = await rpc.getSlot({ commitment: 'processed' }).send();
      if (nowSlot - slot > BigInt(CFG.maxSnapshotAgeSlots)) {
        log.warn(
          { obligation: key, snapshotSlot: slot.toString(), nowSlot: nowSlot.toString() },
          'snapshot aged out while planning — dropping instead of sending stale',
        );
        continue;
      }

      const { value: bh2 } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const finalMsg = buildLiquidationMessage({
        signer: ctx.signer,
        pdas: ctx.pdas,
        atas: ctx.atas,
        obligation: ob,
        plan,
        orca,
        blockhash: bh2,
        computeUnitLimit: cuLimit,
        computeUnitPriceMicroLamports: priorityPrice,
        lookupTables: ctx.lookupTables,
      });
      const finalWire = await signToWire(finalMsg);

      const res = await sendAndConfirm(ctx.pool, finalWire, bh2.lastValidBlockHeight);
      if (res.landed && res.err === null) {
        ctx.fees.onSuccess();
        log.info({ signature: res.signature }, 'liquidation confirmed');
      } else {
        ctx.fees.onRaceLost();
        log.warn({ signature: res.signature, err: res.err }, 'liquidation did not land');
      }
    } catch (e) {
      ctx.pool.reportFailure(e);
      ctx.quarantine.record(key, slot, String(e));
      log.error({ obligation: key, err: String(e) }, 'execution error');
    } finally {
      ctx.guard.release(key);
    }
  }
}

/**
 * Loads the lookup table's contents so the builder can compress against it.
 * Without one the transaction serializes to ~1509 bytes against a 1232-byte
 * limit and is refused by the network, so a live run without it is blocked.
 */
async function loadLookupTable(rpc: ReturnType<RpcPool['active']>): Promise<LookupTables | undefined> {
  if (!CFG.lookupTable) return undefined;
  const table = address(CFG.lookupTable);
  const addrs = await fetchAddressesForLookupTables([table], rpc);
  log.info({ table, addresses: Object.values(addrs)[0]?.length ?? 0 }, 'lookup table loaded');
  return addrs as LookupTables;
}

async function main(): Promise<void> {
  validateConfig();
  const pool = makeRpcPool();
  const signer = await loadSigner();
  const atas = await findAtas(signer.address);
  const pdas = await loadPdas();

  const market = await KaminoMarket.load(
    pool.active(),
    TARGET_MARKET.address,
    RECENT_SLOT_DURATION_MS,
    KLEND_PROGRAM,
    true,
  );
  if (!market) throw new Error(`Market ${TARGET_MARKET.address} failed to load`);

  log.info(
    {
      liquidator: signer.address,
      market: TARGET_MARKET.address,
      marketName: TARGET_MARKET.name,
      dryRun: CFG.dryRun,
      atas,
    },
    'bot starting',
  );
  if (!CFG.dryRun) {
    log.warn('DRY_RUN IS OFF: real transactions will be submitted');
    if (!CFG.lookupTable) {
      throw new Error(
        'LOOKUP_TABLE is not set. Without it the transaction serializes past the 1232-byte ' +
          'network limit and every send is refused. Run `npm run setup -- --confirm` first.',
      );
    }
  }
  const lookupTables = await loadLookupTable(pool.active());

  const ctx = {
    pool,
    market,
    signer,
    atas,
    pdas,
    fees: new PriorityFeeOracle(),
    guard: new InFlightGuard(),
    quarantine: new Quarantine(),
    lookupTables,
  };

  // systemd sends SIGTERM on stop and on restart; finish the tick in flight
  // rather than dying mid-transaction.
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (stopping) process.exit(1);
      stopping = true;
      log.warn({ signal: sig }, 'shutting down after the current tick');
    });
  }

  while (!stopping) {
    try {
      await tick(ctx);
      pool.reportSuccess();
    } catch (e) {
      pool.reportFailure(e);
      log.error({ err: String(e) }, 'loop error');
    }
    await new Promise((r) => setTimeout(r, CFG.scanIntervalMs));
  }
  log.info('stopped');
}

void main().catch((e) => {
  log.fatal({ err: String(e) }, 'exiting');
  process.exit(1);
});

export { address };

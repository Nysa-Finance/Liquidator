import { Decimal } from 'decimal.js';
import { KaminoMarket, type KaminoObligation } from '@kamino-finance/klend-sdk';
import { address, fetchAddressesForLookupTables, type Address } from '@solana/kit';
import {
  CFG,
  SOL_PRICE_FALLBACK_USD,
  SOL_PRICE_FEED,
  validateConfig,
  KLEND_PROGRAM,
  TARGET_MARKET,
  USDC_RESERVE,
  USDY_RESERVE,
  FLASH_SOURCE,
  ORCA_POOL,
} from './config.js';
import { log } from './logger.js';
import { alert } from './alert.js';
import { ledgerInstant, loadSigner, makeRpcPool, type RpcPool } from './rpc.js';
import { evaluate } from './eligibility.js';
import { buildPlan } from './profit.js';
import { loadOrcaContext } from './build/orca.js';
import { loadPdas } from './build/klend.js';
import { buildLiquidationMessage, type Atas, type LookupTables } from './build/tx.js';
import {
  InFlightGuard,
  Ledger,
  readSolPriceUsd,
  transactionCostUsdc,
  PriorityFeeOracle,
  Quarantine,
  readFlashLiquidity,
  reconcile,
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
  ledger: Ledger;
}): Promise<void> {
  const rpc = ctx.pool.active();
  // slot and blockTime read together: one coherent snapshot, not two
  // disconnected reads
  const instant = await ledgerInstant(rpc);
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

  // Both the fee ceiling and the per-transaction cost are denominated in SOL but
  // capped in USDC, so they need a price. Read once per tick from the same feed
  // the reserves are priced against.
  const solPrice = (await readSolPriceUsd(rpc, SOL_PRICE_FEED)) ?? SOL_PRICE_FALLBACK_USD;

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
      // Priced at the most this bot would ever pay, so the estimate errs on the
      // pessimistic side; the number is recomputed with the real fee below.
      fixedCostUsdc: transactionCostUsdc(
        DEFAULT_CU_LIMIT,
        (BigInt(CFG.maxPriorityLamports) * 1_000_000n) / BigInt(DEFAULT_CU_LIMIT),
        solPrice,
      ),
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
        solPrice,
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

      // The estimate above priced the worst fee allowed; with the real one the
      // cost may differ enough to change the answer.
      const realCost = transactionCostUsdc(cuLimit, priorityPrice, solPrice);
      const profitAtRealCost = plan.expectedProfitUsdc
        .plus(plan.fixedCostUsdc)
        .minus(realCost);
      if (profitAtRealCost.lt(CFG.minProfitUsdc)) {
        log.info(
          { obligation: key, profitAtRealCost: profitAtRealCost.toFixed(6), feeUsdc: realCost.toFixed(6) },
          'no longer clears the floor once the real fee is priced in',
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

        // What the chain recorded, not what the plan predicted. A model that is
        // systematically optimistic only shows up in this comparison.
        const settled = await reconcile(rpc, res.signature, ctx.signer.address, USDC_RESERVE.liquidityMint);
        if (settled) {
          ctx.ledger.win(settled);
          const actual = new Decimal(settled.usdcDelta.toString()).div(1e6);
          const estimated = plan.expectedProfitUsdc;
          const driftPct = estimated.isZero() ? new Decimal(0) : actual.minus(estimated).div(estimated).mul(100);
          void alert(
            `win:${res.signature}`,
            `LIQUIDATED — earned ${actual.toFixed(2)} USDC (estimated ${estimated.toFixed(2)}) — https://solscan.io/tx/${res.signature}`,
          );
          log.info(
            {
              signature: res.signature,
              estimatedUsdc: estimated.toFixed(6),
              actualUsdc: actual.toFixed(6),
              driftPct: driftPct.toFixed(2),
              feeSol: (Number(settled.feeLamports) / 1e9).toFixed(9),
              ledger: ctx.ledger.summary(),
            },
            'liquidation confirmed',
          );
        } else {
          log.info({ signature: res.signature }, 'liquidation confirmed, settlement unreadable');
        }
      } else {
        ctx.fees.onRaceLost();
        // A transaction that landed with an error still paid its fee; one that
        // never landed paid nothing.
        const settled = res.landed
          ? await reconcile(rpc, res.signature, ctx.signer.address, USDC_RESERVE.liquidityMint)
          : null;
        ctx.ledger.loss(settled?.feeLamports ?? 0n);
        void alert('loss', `a liquidation did not land: ${String(res.err).slice(0, 200)}`);
        log.warn(
          {
            signature: res.signature,
            err: res.err,
            feeSol: settled ? (Number(settled.feeLamports) / 1e9).toFixed(9) : '0',
            ledger: ctx.ledger.summary(),
          },
          'liquidation did not land',
        );
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

/**
 * Retries a network step with doubling waits (2 s up to 60 s per attempt,
 * about ten minutes in all) before giving up. A provider hiccup at boot used to
 * kill the process outright, and systemd stops restarting a unit that dies too
 * often — one bad minute at night could leave the bot off until morning.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 14): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      const waitMs = Math.min(2_000 * 2 ** (i - 1), 60_000);
      log.warn({ step: label, attempt: i, retryInMs: waitMs, err: String(e) }, 'boot step failed, retrying');
      if (i === 3) void alert(`boot:${label}`, `cannot ${label} — retrying. ${String(e).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function main(): Promise<void> {
  // Everything that can only be fixed by a human fails immediately: retrying a
  // bad setting, a missing key file or a missing lookup table changes nothing.
  validateConfig();
  const pool = makeRpcPool();
  const signer = await loadSigner();
  const atas = await findAtas(signer.address);
  const pdas = await loadPdas();
  if (!CFG.dryRun && !CFG.lookupTable) {
    throw new Error(
      'LOOKUP_TABLE is not set. Without it the transaction serializes past the 1232-byte ' +
        'network limit and every send is refused. Run `npm run setup -- --confirm` first.',
    );
  }

  // Everything below talks to the network and is retried.
  const market = await withRetry('load the market', async () => {
    const m = await KaminoMarket.load(pool.active(), TARGET_MARKET.address, RECENT_SLOT_DURATION_MS, KLEND_PROGRAM, true);
    if (!m) throw new Error(`Market ${TARGET_MARKET.address} failed to load`);
    return m;
  });

  log.info(
    {
      liquidator: signer.address,
      market: TARGET_MARKET.address,
      marketName: TARGET_MARKET.name,
      dryRun: CFG.dryRun,
      // off is silent otherwise: a missing token or chat id would look like
      // Telegram simply not delivering
      telegramAlerts: Boolean(CFG.telegramBotToken && CFG.telegramChatId),
      atas,
    },
    'bot starting',
  );
  if (!CFG.dryRun) log.warn('DRY_RUN IS OFF: real transactions will be submitted');
  const lookupTables = await withRetry('load the lookup table', () => loadLookupTable(pool.active()));
  void alert(
    'started',
    `started — ${CFG.dryRun ? 'DRY RUN, nothing is sent' : 'LIVE'} — wallet ${signer.address} — market ${TARGET_MARKET.name}`,
  );

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
    ledger: new Ledger(),
  };

  // systemd sends SIGTERM on stop and on restart; finish the tick in flight
  // rather than dying mid-transaction.
  let stopping = false;
  // The wait between rounds can stretch to a minute while the RPC is failing;
  // a stop signal cuts it short instead of making systemd wait it out.
  let wake: () => void = () => {};
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (stopping) process.exit(1);
      stopping = true;
      log.warn({ signal: sig }, 'shutting down after the current tick');
      wake();
    });
  }

  let failures = 0;
  let lastSummary = Date.now();
  let lastBalanceCheck = 0;
  while (!stopping) {
    try {
      await tick(ctx);
      pool.reportSuccess();
      if (failures >= 5) void alert('rpc-recovered', `scanning again after ${failures} failed rounds`);
      failures = 0;
    } catch (e) {
      pool.reportFailure(e);
      failures += 1;
      log.error({ err: String(e), consecutiveFailures: failures }, 'loop error');
      if (failures === 5) void alert('rpc-down', `5 scan rounds failed in a row — ${String(e).slice(0, 200)}`);
    }

    // A wallet that runs out of SOL cannot pay fees, and every send fails.
    if (Date.now() - lastBalanceCheck > 5 * 60_000) {
      lastBalanceCheck = Date.now();
      try {
        const bal = await pool.active().getBalance(signer.address, { commitment: 'confirmed' }).send();
        const sol = Number(bal.value) / 1e9;
        if (sol < CFG.minSolBalance) {
          log.warn({ sol }, 'wallet SOL balance low');
          void alert('low-sol', `wallet ${signer.address} has ${sol.toFixed(4)} SOL — top it up`);
        }
      } catch (e) {
        log.debug({ err: String(e) }, 'balance check failed');
      }
    }

    if (Date.now() - lastSummary > 24 * 3_600_000) {
      lastSummary = Date.now();
      void alert('daily', `alive — ${JSON.stringify(ctx.ledger.summary())}`);
    }

    // Back off while the RPC keeps failing, so a dead provider is not hammered.
    const waitMs = failures === 0 ? CFG.scanIntervalMs : Math.min(CFG.scanIntervalMs * 2 ** failures, 60_000);
    await pause(waitMs);
  }
  log.info({ ledger: ctx.ledger.summary() }, 'stopped');
  await alert('stopped', `stopped — ${JSON.stringify(ctx.ledger.summary())}`);
}

void main().catch(async (e) => {
  log.fatal({ err: String(e) }, 'exiting');
  await alert('fatal', `exited: ${String(e).slice(0, 300)}`);
  process.exit(1);
});

export { address };

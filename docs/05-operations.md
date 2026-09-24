# Operations: reliability, security, going to production

> Reference command, before every start-up:
> ```bash
> npm run preflight                  # the configured target market, every check
> MARKET=<pubkey> npm run preflight  # any other market, generic checks only
> ```
> Read-only (the client rejects any write up front) and it reports exactly which
> conditions are missing. On the target market it answers **NOT READY**, on the
> blockers listed below.
>
> Generic mode skips the USDY/USDC pair and the Orca exit route, which only mean
> something on the configured market, and prints a per-reserve breakdown instead.
> Useful for sizing up any Kamino market before pointing the bot at it.

---

## 1. Three blockers that are not yours to fix

They belong to the market curator (`66pW72Fchnr34FGgXrxheGs3BbUsDSwJmGcK7m8Bz1Yv`).

### 1.1 ~~The USDY oracle~~ — DONE, ~24 Sep 2026

Fixed by the curator, who moved the reserve to feed `3t4JZcue…` index 406
(1.14685 USD) rather than repointing the index on the old feed. The two reserves
therefore read different feeds now; `src/config.ts` carries one per reserve and
the drift test asserts both.

Kept below because it explains what index 3 is, and because the same failure can
recur on any reserve.

### 1.1.1 What it was

The USDY reserve's scope chain is `[3]`, and index 3 of the feed holds
**0.000001 USD**. The real USDY price (~1.145) sits at indices 79/97 of the same
feed.

Index 3 is not an arbitrary bad value: it is what Kamino points a **retired**
reserve at. Running `MARKET=7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF npm run
preflight` finds five more reserves on the Main Market reading index 3 — CHAI,
STEP, xSTEP, kSOLJITOSOLOrca, kSOLJITOSOLRaydium — and every one of them is
decommissioned: either `status != active`, or usable as neither collateral
(`liquidationThresholdPct = 0`) nor debt (`borrowLimit = 0`). Index 191 serves
the same purpose for another group.

Which makes the Nysa configuration internally inconsistent: the USDY reserve is
`status = active` with `loanToValuePct = 70` and `liquidationThresholdPct = 75`
— configured as live collateral — while pointing at the marker Kamino uses for
dead assets. While this stands, `refresh_reserve` writes a near-zero USDY price: every
deposit is valued at nothing, nobody can borrow, and the liquidation bonus is
meaningless. The bot would refuse the plan anyway thanks to the oracle divergence
guard (rho ~ 1.1 million) — correct behaviour, but it means it would never work.

Verify with `npm run preflight`: the *"USDY oracle price believable"* line should
turn green with a value around 1.14.

### 1.2 The USDY reserve needs liquidity

The vault holds **0.1 USDY**. Liquidation needs it to *redeem* collateral into
real USDY; below that, you receive cUSDY, which Orca will not trade, and the
transaction reverts at the swap. Available USDY liquidity must exceed the
collateral you expect to seize in your largest liquidation.

### 1.3 There must be positions carrying debt

Today: **0 obligations**, no debt. A liquidator with nothing to liquidate has no job.

> In the meantime the bot can run against an **active** Kamino market by changing
> `TARGET_MARKET` and the reserve pair in `src/config.ts`. The code is
> parametric; the Main Market has 106,000 positions, ~12,400 with debt over $100.

## 2. Five things you have to finish

| # | Item | Why it blocks | Where |
|---|---|---|---|
| B1 | **Run `npm run setup -- --confirm`** | creates the three token accounts and the lookup table, then prints `LOOKUP_TABLE=` for the `.env`. Measured: the uncompressed transaction is **1509 bytes** against a **1232-byte** limit, so without the table every send is refused | one-off, on-chain, spends rent |
| B2 | **Wire `scanner.ts` into the loop** | `index.ts` still uses the SDK method that downloads whole positions: fine on an empty market, unusable on an active one | `src/index.ts` |
| B3 | **Alerting** | there is no health endpoint and no metrics; a stopped bot is silent | new |

B1 is enforced rather than remembered: with `DRY_RUN=false` and no
`LOOKUP_TABLE`, the bot refuses to start.

Two items that used to sit here are done. The SOL price is read from Scope
(index 0) on every tick, and the per-transaction cost is computed from the CU
limit and the priority price rather than assumed — note that planning now prices
the **worst fee the bot would pay** (about $0.30 at the default
`MAX_PRIORITY_LAMPORTS`, against the $0.01 that was hardcoded), then rechecks
the plan against the real fee once it is known, which is nearer $0.002. Expect
a few more plans declined at the estimate stage; that is the estimate being
honest rather than optimistic. And every confirmed liquidation is now read back
from the chain, with the drift against the estimate and a running ledger of
proceeds, burned fees and landed rate.

Recommended before raising volume: a WebSocket listener on the Scope feed
(currently 2 s polling), the expected-value rule from
[03-profitability.md](03-profitability.md) §6 rule (2), and an external lock if
more than one instance runs.

## 3. Operational setup

### RPC

The public endpoint is not usable in production — slow and rate-limited. Use a
provider (Helius, Triton, QuickNode) and ideally a second one for failover.

```
RPC_PRIMARY=https://mainnet.<provider>/?api-key=...
RPC_SECONDARY=https://...
WS_PRIMARY=wss://mainnet.<provider>/?api-key=...
```

### Key management

This is a **hot key**: it signs flash loan, liquidation and swap on a running
machine.

- dedicated to this bot alone: no other funds, no delegations, no SPL `approve`;
- keep only SOL for fees and token-account rent on it (0.2-0.5 SOL);
- the `.json` file with `600` permissions, outside the repository, never in git;
- sweep USDC profits to a cold wallet periodically, in a separate transaction;
- rate-limit the signer: at most N signatures per minute, so a bug in a loop
  cannot sign 10,000 transactions;
- in production prefer KMS/HSM or a separate signer over a local socket.

The flash loan is what makes this tenable: **no capital is required**, so do not
leave USDC sitting on the hot key.

### Machine

A VPS close to the validators (Frankfurt or Amsterdam for Europe) cuts tens of
milliseconds. Nothing powerful is needed: 2 vCPU and 2 GB.

A ready systemd unit lives at [`deploy/liquidator.service`](../deploy/liquidator.service):

```bash
sudo cp deploy/liquidator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now liquidator
journalctl -u liquidator -f
```

It runs the compiled output rather than `tsx`, so a transpile error cannot take
the process down mid-flight; it restarts on failure with a back-off that stops a
crash loop from hammering the RPC; and it is confined with `ProtectSystem=strict`
plus a 2 GB memory ceiling.

### Monitoring

Minimum viable: alert if the process dies, if five transactions fail in a row, if
the landing rate drops below 30%. Logs to file, rotated.

## 4. Go-live sequence

No step is skipped, and each has a verifiable exit condition.

**0 — One-off on-chain setup**

```bash
npm run setup                  # show what it would create
npm run setup -- --confirm     # create it
```

Spends SOL: rent for three token accounts and for the lookup table. Put the
`LOOKUP_TABLE=` it prints into `.env`.

**1 — Preflight green**

```bash
npm run preflight
```

Must print `READY`. If it prints `NOT READY`, the listed blockers are exactly
what is missing.

**2 — Regression checks**

```bash
npm test          # local, LiteSVM, no network
npm run test:live # mainnet, read-only
```

The test *"the constants in src/config.ts still match on-chain state"* is the one
that matters: if the curator changed a parameter, it fails here instead of in a
lost transaction.

**3 — Extended dry run**

```
DRY_RUN=true
```

Leave it running for **at least 24 hours**. What you need to see: at least one
plan passing every filter **and** a simulation with a positive USDC delta. Until
that happens there is nothing to put into production.

**4 — First submission, tight thresholds**

```
DRY_RUN=false
MIN_PROFIT_USDC=20           # large opportunities only
MIN_MARGIN_BPS=100           # wide margins only
MAX_PRIORITY_LAMPORTS=50000  # losing the race is fine
```

One liquidation. Then stop and reconcile: `pre/postTokenBalances` of the
confirmed transaction against the bot's estimate. If they diverge, change
nothing — understand why first.

**5 — Gradual loosening**

One threshold at a time, with at least a day of observation between changes.
Suggested order: `MIN_PROFIT_USDC`, then `MAX_PRIORITY_LAMPORTS`, and
`MIN_MARGIN_BPS` last.

## 5. Reliability in the loop

### Detecting fast

The signal that makes a position liquidatable is **not** an update to the
obligation account: it is an update to the **Scope feed**. So `accountSubscribe`
on `3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C` and, on every notification,
re-evaluate the **whole watchlist** — not only obligations whose account changed.
Keep the watchlist in memory (`ltv > threshold - 300 bps`), ordered by distance
from the threshold. If you genuinely need sub-100 ms, move to **Geyser gRPC**;
public WebSocket RPC lands in the 400-1500 ms range.

### Stale RPC data

Every evaluation carries its snapshot slot; refuse to build a transaction when
`current_slot - snapshot_slot > MAX_SNAPSHOT_AGE_SLOTS`. Never mix data from
different RPCs in one snapshot. Use `commitment: 'processed'` for detection and
`'confirmed'` for confirmation; `'finalized'` is unusable at 12+ seconds.

The `marketPriceSf` stored in a reserve reflects its **last on-chain refresh**.
On the Nysa market the reserves have not been refreshed in days, so that field is
garbage: compute LTV by reading **Scope directly**, exactly as `refresh_reserve`
will inside your transaction.

### Simulation

Always, before every submission. Three distinct checks: `err == null`;
`unitsConsumed` (rewrite `setComputeUnitLimit`); and the USDC token-account delta
from the returned `accounts` — **real simulated profit above the threshold**.

Map klend's custom error codes (`@codegen/klend/errors/custom` in the SDK) to
decisions: `ObligationHealthy` -> drop from the hot watchlist for N slots;
`ReserveStale` -> a bug in your instruction ordering;
`LiquidationRewardTooSmall` -> raise sizing or lower `minAcceptableReceived`;
`InsufficientLiquidity` -> the flash source reserve is dry.

### Blockhash

Keep one refreshed in the background every ~2 s so the hot path does not wait on
a round trip. A blockhash lives ~150 slots (~60 s); track `lastValidBlockHeight`
and stop rebroadcasting past it. A **durable nonce** removes expiry entirely at
the cost of one account and one instruction — but `advanceNonceAccount` must be
the **first** instruction, which shifts `borrowInstructionIndex`.

### No double execution

An in-process lock per obligation, with `inFlight: Map<obligation, {signature,
sentAtSlot, blockhash}>` released only on confirmation or blockhash expiry. Across
multiple instances you need an external lock (Redis `SET NX PX`, key
`liq:{obligation}`, TTL equal to blockhash lifetime). On-chain atomicity saves you
anyway — a second liquidation of an already-healthy obligation fails with
`ObligationHealthy` and costs only the fee — but the lock avoids paying it.

### Recovering from failures

| Situation | Action |
|---|---|
| Transaction never lands before `lastValidBlockHeight` | rebuild from a fresh snapshot; do not re-sign the old one |
| Transaction lands with an error | read the logs, classify the code, update the cache, back off on that obligation |
| Lands but profit below expectation | log the divergence; raise `MIN_MARGIN_BPS` if it recurs |
| RPC timeout on send | retry the **same** signed transaction on the other RPCs (idempotent by signature) |
| Simulation fails 3x on the same obligation | quarantine it for 300 slots |

**Never retry** a transaction that failed with `ObligationHealthy` (final) or
`InvalidFlashRepay` (a construction bug).

## 6. Risks and safeguards

### Protocol

| Risk | Why | Mitigation |
|---|---|---|
| The curator changes parameters | `update_reserve_config` can zero `max_liquidation_bonus_bps` or set `flash_loan_fee_sf = u64::MAX` (flash loans disabled) between your simulation and your submission | re-read config in every cycle's snapshot; the on-chain guards keep the transaction safe regardless |
| `emergency_mode` / `price_triggered_liquidation_disabled` | the market can block price-driven liquidations | check the flags before building |
| You receive cUSDY instead of USDY | `withdraw_collateral_amount = min(withdraw_amount, freely_redeemable)` | explicit pre-transaction check; the transaction reverts at the swap anyway |
| `RepayTooSmallForFullLiquidation` | below `min_full_liquidation_value_threshold` ($2) you **must** repay the entire debt | handle the forced-full-liquidation case in sizing |
| Market becomes permissioned | `permissioning_authority != default` requires the permissioner's signature as the last remaining account | default today, but **check at runtime** |

### Transaction

- Never `skipPreflight: true` without having simulated yourself. Your simulation
  *is* the preflight.
- A hardcoded `borrowInstructionIndex` gives `InvalidFlashRepay`. Compute it.
- Divergent borrow/repay account lists (even just optional ordering) give
  `InvalidFlashRepay`. Build them from **one** shared function.
- A CU limit set too low gives `ComputeBudgetExceeded` halfway through and you
  lose the fee. Measure, do not estimate.
- An ALT deactivated by a third party makes the transaction undeserializable. Use
  your own ALT for critical accounts.

### RPC

A compromised RPC can serve false state to make you build a losing liquidation.
The mitigation is **the on-chain guards**: with correct
`minAcceptableReceivedLiquidityAmount` and `other_amount_threshold`, the worst a
hostile RPC achieves is making you pay a fee for a reverting transaction. Never
rely on the off-chain profit estimate as the only defence. For large sizes,
evaluate liquidatability on two RPCs before submitting.

### Slippage

Three independent on-chain guards:

```
min_acceptable_received_liquidity_amount = W_expected * (1 - tol_liq)   // e.g. 0.5%
other_amount_threshold                   = O_expected * (1 - tol_swap)  // e.g. 0.3%
sqrt_price_limit                         = current_sqrt_price * (1 - tol_px)
```

Calibrate on the **worst case**, not the expected one. Too loose, and a sandwich
on a pool doing $11k of daily volume takes the whole bonus.

### Oracle

Kamino values USDY with **Scope**; you sell on **Orca**. Two different prices.
The ratio `rho` (see [03-profitability.md](03-profitability.md)) is the principal
risk, not gas. `max_age_price_seconds = 180` on both reserves, so prices up to 3
minutes old are accepted by the program: in a fast move, the Scope price you
compute the bonus from can differ materially from the Orca price you sell at.

Safeguard: reject the plan when
`|P_orca_spot / P_scope_USDY - 1| > MAX_ORACLE_DIVERGENCE`.

USDY is yield-bearing, so its price rises over time: a stalled feed **understates**
it, which makes the computed bonus optimistic. Check feed freshness, not just the
value.

### Accounting

Do not infer profit from simulation: read it from `pre/postTokenBalances` of the
confirmed transaction. Track gross bonus, Orca fee, flash fee, priority fee, base
fee, and **the cost of failed transactions** separately — that last one is pure
cost with no revenue. Real daily P&L = sum(confirmed profits) - sum(fees on failed
transactions). A bot with an 80% failure rate can be losing money while every
individual liquidation looks profitable.

### USDY-specific

- **Active freeze authority** (`51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK`):
  the issuer can freeze a token account. If your USDY account is frozen, every
  liquidation reverts at the swap. Detect `state == Frozen` at start-up and after
  each failure — `npm run preflight` checks this.
- Secondary liquidity is concentrated in **one pool** doing ~$11k/day. If it dries
  up, the strategy has no exit.

### Anti-loss checklist

```
[ ] Pi_worst > MIN_PROFIT_USDC                      (off-chain)
[ ] Pi_expected / R > MIN_MARGIN_BPS                (off-chain)
[ ] |rho - 1| < MAX_ORACLE_DIVERGENCE               (off-chain)
[ ] snapshot_age_slots <= MAX_SNAPSHOT_AGE_SLOTS    (off-chain)
[ ] W_gross <= freely_redeemable_collateral         (off-chain)
[ ] R <= flash_reserve.total_available_liquidity    (off-chain)
[ ] simulate.err == null                            (simulation)
[ ] simulated USDC delta >= MIN_PROFIT_USDC         (simulation)
[ ] minAcceptableReceivedLiquidityAmount > 0        (on-chain)
[ ] other_amount_threshold > 0                      (on-chain)
[ ] priority_fee <= 0.25 * Pi_expected              (off-chain)
[ ] kill switch: DRY_RUN=true by default            (config)
```

## 7. Day-2 operations

| When | What |
|---|---|
| every start-up | `npm run preflight` |
| daily | net profit = confirmed proceeds **minus** fees on failed transactions |
| daily | SOL balance of the wallet; top up below 0.1 |
| weekly | `npm run fixtures && npm test` — catches program or state changes |
| weekly | sweep profits to the cold wallet |
| on any unusual failure | read the transaction logs, classify the error code |

### Warning signs

- **Recurring `ObligationHealthy`** -> you are always late: raise the priority fee,
  cut latency, or accept that this market's competition is too strong.
- **Falling landing rate** -> the RPC is degrading, or the priority fee is too low.
- **Real profit systematically below the estimate** -> the slippage model is
  optimistic: raise `MIN_MARGIN_BPS` until the two numbers agree again.
- **`LiquidationRewardTooSmall`** -> `minAcceptableReceived` is too tight, or the
  price moved between simulation and submission.

### Shutting down

Set `DRY_RUN=true` and restart: the bot keeps observing and logging without
submitting. Nothing else is needed — there are no open positions to close,
because the bot never holds inventory. Every operation is born and dies inside a
single transaction.

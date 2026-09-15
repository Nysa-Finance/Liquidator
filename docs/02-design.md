# Design: architecture and the atomic transaction

## 1. The atomic transaction

```
idx  program      instruction                                        note
-------------------------------------------------------------------------------
 0   ComputeBudget setComputeUnitLimit(measured * 1.15)
 1   ComputeBudget setComputeUnitPrice(micro_lamports)
 2   klend         refreshReserve(USDC reserve, Nysa)   + scope_prices
 3   klend         refreshReserve(USDY reserve, Nysa)   + scope_prices
 4   klend         refreshObligation                    + remaining[deposits..., borrows...]
 5   klend         flashBorrowReserveLiquidity(amount = repay_usdc)   <- MAIN MARKET
 6   klend         liquidateObligationAndRedeemReserveCollateralV2(
                       liquidity_amount = repay_usdc,
                       min_acceptable_received_liquidity_amount = usdy_min,
                       max_allowed_ltv_override_percent = 0)
 7   whirlpool     swapV2(amount = usdy_received, a_to_b = true,
                       amount_specified_is_input = true,
                       other_amount_threshold = usdc_min)
 8   klend         flashRepayReserveLiquidity(amount = repay_usdc,
                       borrow_instruction_index = 5)
```

### Why it is atomic

Solana executes a transaction's instructions in order and commits **all or
nothing**. If the swap returns less than required, instruction 8 fails on the
transfer out of `user_source_liquidity` for insufficient funds and the whole
transaction reverts: the flash loan never happened, the liquidation never
happened. You pay base fee plus priority fee.

On top of that there are **three** explicit guards that trip before the generic
revert:

| Guard | Where | Effect |
|---|---|---|
| `min_acceptable_received_liquidity_amount` | ix 6 | `LiquidationRewardTooSmall` if net collateral is below the floor |
| `other_amount_threshold` | ix 7 | Orca `AmountOutBelowMinimum` |
| `sqrt_price_limit` | ix 7 | stops the swap if price leaves the range |

### Ordering constraints (verified against source)

- ix 2/3/4 must be in the **same slot** as ix 6 — always true within one transaction.
- ix 5 and ix 8 must carry **identical account lists**, and
  `borrow_instruction_index = 5`. Adding or removing a ComputeBudget instruction
  at the head shifts that index: compute it, never hardcode it.
- One flash borrow and one flash repay per transaction; neither may be a CPI.
- ix 4 `refreshObligation` must come **after** the reserve refreshes, because it
  reads the prices they just wrote.

## 2. Accounts, token accounts, signatures

**One key signs.** The liquidator is simultaneously `user_transfer_authority`
(flash), `liquidator` (klend) and `token_authority` (Orca). No SPL `approve` is
needed: every outbound transfer uses the direct authority-signer.

Token accounts required (owner = liquidator), created **once**, outside the hot path:

| Account | Mint | Role |
|---|---|---|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | receives the flash loan, pays the debt, receives the swap output, pays the flash repay |
| USDY | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` | receives the redeemed collateral, feeds the swap |
| cUSDY | `C7dKsFYaM2DcVJSDjouPTfLc9292Lkd5ti9VQCdx2UDg` | cToken transit inside ix 6 |

The **cUSDY** account is mandatory even though its balance always returns to
zero: ix 6 uses it as `user_destination_collateral`. Forgetting it is the most
common mistake.

Do not put `createAssociatedTokenAccountIdempotent` in the hot transaction: it
adds ~20k CU and another writable account, and the rent is a one-off anyway.

## 3. USDC flow through one token account

```
starting balance          S
+ flash borrow            S + F
- debt repayment          S + F - R          (R = actual repay_amount <= F)
+ swap output             S + F - R + O
- flash repay (principal) S     - R + O
- flash fee (Exclusive)   S     - R + O - f
--------------------------------------------
profit = O - R - f
```

The flash repay moves `flash_loan_amount + referrer_fee` from
`user_source_liquidity` into the supply vault, **plus** a second transfer of
`reserve_origination_fee` to the fee vault when it is non-zero. With
`referral_fee_bps = 0` and no referrer, `referrer_fee = 0` [V].

Keep a small buffer in the USDC account: `to_ceil()` rounding on `repay_amount`
can leave you one lamport short.

## 4. Address Lookup Table

The transaction touches ~45-50 unique accounts, which is over the practical limit
for a legacy transaction. Use a **v0 transaction** with two ALTs:

1. your own, created once, holding: the Nysa reserves (USDC/USDY) and their
   vaults, mints, cToken mint, market, market authority, Scope feed, your token
   accounts, the Main Market USDC reserve and its vaults, the program ids;
2. the existing pool ALT `9iiRsm2M5jaFnDbgAjBbbasTwo6m3AV6N22k1ANt47Bm`.

`terminator/src/lookup_tables.rs` is a direct reference for creating and
persisting one.

Deactivating or closing an ALT breaks in-flight transactions, so do not rely on
third-party ALTs for critical accounts.

## 5. Compute budget

Tune with `simulateTransaction` and read `unitsConsumed` from the response rather
than guessing.

| ix | CU |
|---|---|
| refreshReserve x2 (Scope) | ~40k-70k [A] |
| refreshObligation (2 reserves) | ~30k [A] |
| flashBorrow | ~25k [A] |
| liquidateV2 (no farms) | ~90k-140k [A] |
| swapV2 | **37,318 measured** on 1,000 USDY (LiteSVM) [V] |
| flashRepay | ~30k [A] |
| **total** | **~280k-400k** |

Well under the 1.4M CU per-transaction ceiling. Set the limit to the measured
value x1.15: an inflated limit scales the priority fee cost linearly.

---

## 6. Bot architecture

```
                     +----------------------------------------------+
                     |  L0  RPC / DATA LAYER                        |
                     |  - primary RPC (staked provider)             |
                     |  - secondary RPC (failover, slot quorum)     |
                     |  - WS accountSubscribe / programSubscribe    |
                     |  - (opt.) Geyser gRPC for sub-100 ms         |
                     +---------------+------------------------------+
                                     | AccountUpdate{pubkey, slot, data}
          +--------------------------+------------------------------+
          v                          v                              v
  +---------------+        +------------------+         +--------------------+
  | L1 STATE CACHE|        | L1 PRICE FEED    |         | L1 POOL CACHE      |
  | reserves      |        | Scope OraclePrices|        | whirlpool + tick   |
  | obligations   |        | per chain index  |         | arrays + fee + ALT |
  | lending mkts  |        +------------------+         +--------------------+
  +-------+-------+
          | coherent per-slot snapshot
          v
  +----------------------+   +----------------------+   +--------------------+
  | L2 SCANNER           |-->| L3 ELIGIBILITY       |-->| L4 PROFIT ENGINE   |
  | dataSlice prefilter  |   | off-chain replica of |   | Orca quote, fees,  |
  | + priority watchlist |   | calculate_liquidation|   | thresholds, sizing |
  +----------------------+   +----------------------+   +---------+----------+
                                                                  | LiquidationPlan
                                                                  v
  +----------------------------------------------------------------------------+
  | L5 TX BUILDER                                                              |
  |  refresh x2 -> refreshObligation -> flashBorrow -> liquidateV2 -> swap ->   |
  |  flashRepay  + ComputeBudget + ALT + blockhash                             |
  +-------------------------------+--------------------------------------------+
                                  v
  +------------------+   +------------------+   +------------------------------+
  | L6 SIMULATOR     |-->| L7 FEE ORACLE    |-->| L8 SENDER                    |
  | replaceRecent    |   | getRecentPrio    |   | sendTransaction skipPreflight|
  | Blockhash, CU,   |   | Fees p75/p90 +   |   | retry across RPCs,           |
  | post-state accts |   | adaptive bandit  |   | maxRetries=0 + own rebroadcast|
  +------------------+   +------------------+   +----------+-------------------+
                                                            v
  +----------------------------------------------------------------------------+
  | L9 CONFIRMER -> L10 RECONCILER (real P&L from balance deltas) -> L11 OBS.   |
  +----------------------------------------------------------------------------+
```

### L0 — RPC

Two providers minimum. The free public endpoint handles neither
`getProgramAccounts` on klend nor the polling rate. Every update carries its
`slot`: **discard updates whose slot is lower** than what the cache already holds
for that pubkey, because RPCs reorder. Health check: if the primary trails the
secondary by more than 8 slots on three consecutive reads, promote the secondary.

### L1 — State cache

Three append-only maps versioned by slot. Everything downstream reads **only**
from here, never straight from the RPC, so every evaluation happens on a snapshot
with a known slot.

### L2 — Position scanner

Two modes that coexist:

1. **Prefilter** — `getProgramAccounts` with `dataSlice` over every obligation of
   the market: 64 bytes each instead of 3,344. See `src/scanner.ts` and
   [04-testing.md](04-testing.md).
2. **Hot loop** — `programSubscribe` plus a **watchlist** of obligations with
   `ltv > threshold - margin` (say 300 bps), re-evaluated on every Scope price
   tick even when the obligation account has not changed. **Price moves without
   the obligation account moving** — this is the point that loses races.

### L3 — Eligibility engine

Reproduces `get_liquidation_params` off-chain. It must also reproduce the two
priority rules, or you will build transactions that fail:

- `LiquidationBorrowFactorPriority`: the repay reserve must have
  `borrow_factor_pct >= obligation.highest_borrow_factor_pct` [V]
- `LiquidationLowestLiquidationLtvPriority`: the withdraw reserve must have
  `liquidation_threshold_pct <= obligation.lowest_reserve_deposit_liquidation_ltv` [V]

With only two reserves these hold trivially, but write it generically: the moment
the curator adds a third reserve, they bind.

Also check `market.price_triggered_liquidation_disabled`, `market.emergency_mode`,
`reserve.status`, and the autodeleverage/order conditions (which carry different
bonuses).

### L5 — Tx builder

Stateless and pure: `(plan, blockhash, priorityFee) -> VersionedTransaction`.
Testable without a network. `borrowInstructionIndex` is derived from the array.

### L6 — Simulation

`simulateTransaction` with `replaceRecentBlockhash: true`, `sigVerify: false` and
`accounts: { encoding: 'base64', addresses: [usdcTokenAccount] }` so the
post-execution balance can be read and the **real** profit verified — not merely
that no error occurred. Read `unitsConsumed` and rewrite the CU limit.

### L7 — Priority fee

`getRecentPrioritizationFees(lockedWritableAccounts)` over the writable accounts
of your transaction. Start at p75, climb to p90/p99 after a lost race, decay
after consecutive successes. Hard caps: `maxPrioritySol` and
`maxPriorityAsFractionOfProfit` (25% of expected profit).

### L8-L9 — Submission and confirmation

`sendTransaction` with `skipPreflight: true` (preflight adds ~200 ms and you have
already simulated), `maxRetries: 0`, and your own rebroadcast every ~400 ms
across all configured RPCs until the blockhash expires. Confirm by polling
`getSignatureStatuses`, with WS `signatureSubscribe` as a backup.

### L10 — Reconciliation

The profit reported by simulation is not the real profit. After confirmation read
`meta.preTokenBalances` / `postTokenBalances` from the transaction and record the
actual USDC delta. If it diverges beyond a threshold, raise `MIN_MARGIN_BPS`.

### L11 — Observability

Structured JSON logs (`pino`), one event per phase with `slot`, `obligation`,
`signature`. Minimum Prometheus metrics: `scan_latency_ms`, `candidates_total`,
`plans_rejected{reason}`, `tx_sent`, `tx_landed`, `tx_failed{code}`,
`profit_usdc_total`, `priority_fee_lamports`. Alert on more than 5 consecutive
`tx_failed` and on `landed_rate < 30%`.

---

## 7. Language choice: TypeScript now, Rust for the hot path later

Not a cop-out — it depends on where the bottleneck is, and here it is **not
latency**.

**Why TypeScript today.** `@kamino-finance/klend-sdk@12` does the hard part:
decoders for `Reserve`/`Obligation`/`LendingMarket`, `KaminoObligation` methods
that reproduce the program's math exactly, codegen builders for every
instruction. Rewriting the 2^60-scaled `Fraction` math in Rust without depending
on the `kamino_lending` crate means reimplementing — and getting wrong —
`calculate_liquidation`. The target market has zero obligations and zero volume,
so there is no MEV race to win. And `@orca-so/whirlpools-core` is WASM built from
the same Rust quote implementation, so the quote matches execution exactly.

**When to move to Rust.** When the market has real positions *and* other
liquidators show up; or when you want Geyser gRPC with zero-copy decoding. With
`kamino_lending` as a crate you read `Reserve` through `bytemuck` without
allocating and call the program's **real** functions instead of replicating them.
That — eliminating implementation drift — is the actual win, not the milliseconds.

**You cannot move the strategy into your own on-chain program**:
`is_flash_forbidden_cpi_call` rejects flash borrow/repay invoked through CPI.
Everything has to live at the transaction level.

### Dependency compatibility trap (verified)

`@kamino-finance/klend-sdk@12` requires `@solana/kit@^2.3.0`.
`@orca-so/whirlpools@8` and `@orca-so/whirlpools-client@6+` require
`@solana/kit@^5`. **They cannot coexist in one npm tree.**

Resolution used here: `@orca-so/whirlpools-client@^5.0.0` (the last release on
kit ^2.1.0) plus `@orca-so/whirlpools-core` (WASM, no kit dependency). The
high-level `@orca-so/whirlpools` package is not used; the quote facades are built
by hand in `src/build/orca.ts`.

# Testing safely

Five tiers, from safest to most exposed. The first three are implemented.

| # | Environment | Risk | What it validates | Status |
|---|---|---|---|---|
| 0 | Read-only scripts | none | on-chain config, Orca quotes | `npm run inspect`, `npm run quote`, `npm run preflight` |
| 1 | **Live read-only tests** | none | scanner and constants against real active markets | `npm run test:live` |
| 2 | **Local mainnet fork (LiteSVM)** | none | real programs, real state, instructions, CU | `npm test` |
| 3 | `solana-test-validator --clone` | none | tier 2 plus the bot's RPC code path | not built |
| 4 | Mainnet in `DRY_RUN` | none | `simulateTransaction` on real state | default of the bot |
| 5 | Mainnet for real, minimum size | real | everything | last step |

---

## Tier 1 — Live read-only tests

```bash
npm run test:live
RPC=https://... LIVE_MARKET=<pubkey> npm run test:live
```

They run against **real mainnet**, on an **active** market — Kamino's Main Market
(`7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`) by default — because the
project's target market is still empty. No key, no signature, nothing submitted.

### Read-only is a gate, not a promise

`src/readonly.ts` builds the RPC client on a transport that **inspects the
JSON-RPC method before sending it** and throws when it is not on the allowlist.
Even a careless refactor calling `sendTransaction` could not get it on the wire,
and one test asserts exactly that.

### The health prefilter: 106,000 positions in 3 seconds

`src/scanner.ts` solves the scale problem. The Main Market holds **106,217
obligations**; downloading them all would be ~355 MB. But `getProgramAccounts`
accepts a `dataSlice`, returning **only a window of bytes** per account. 64 bytes
are enough:

```
offset 2208  borrow_factor_adjusted_debt_value_sf   (u128)
offset 2224  borrowed_assets_market_value_sf        (u128)
offset 2240  allowed_borrow_value_sf                (u128)
offset 2256  unhealthy_borrow_value_sf              (u128)
```

A position is above threshold when `debt_value_sf >= unhealthy_borrow_value_sf`:
both share the same LTV denominator, so their ratio **is** the ratio of LTV to
threshold. The deposited value is not even needed.

Result: **7 MB instead of 355, one call, ~3 seconds on the free public RPC.**

The offsets are not assumed: a test **re-verifies** them by comparing raw bytes
against the official SDK decoder on real obligations. If Kamino changes the
struct, the test fails instead of letting wrong numbers through.

### What the prefilter revealed

```
57,360 obligations with debt   (2.9 s, one call)
above threshold: 10,533        at risk (95-100%): 1,041
```

But the top of that ranking holds **$0.00 of debt and zero active borrows**: they
are closed or dust positions whose aggregate values stayed **frozen at their last
`refresh_obligation`**. The prefilter reads *saved* state, not current prices.

With `minDebtUsd: 100` the picture becomes useful:

```
with debt >= $100: 12,456      of which above threshold: 1,300
CZxi8PNEx3yjFA5BVttwNtegnLaCmh3yoLUic7RNFjzQ  LTV 90.84%  threshold 90.00%  1 deposit, 1 borrow
AoMuGciBwsFdiKxnhyQ84nSjVSea6XteqCwZzmKm5gK6  LTV 90.75%  threshold 90.00%  1 deposit, 1 borrow
```

**Takeaway**: the prefilter yields *candidates*, not certainties. Always apply a
minimum-debt filter, then the on-chain refresh inside the transaction, then
simulation.

### The six live tests

| Test | What it checks |
|---|---|
| read-only client | `sendTransaction` is blocked by the transport |
| prefilter offsets | raw bytes match the official decoder, on real positions |
| health prefilter | full market scan, distribution, ordering |
| decoded candidates | the prefilter ratio matches LTV/threshold from the decode |
| `config.ts` constants | close factor, bonuses, vaults, flash fee **still identical on-chain** |
| Orca quote + divergence | live quote, and the oracle divergence guard actually trips |

The fifth is the one to run in CI: if the curator changes a market parameter, or
flash loans get disabled on the source reserve, you find out immediately instead
of through a failed transaction.

---

## Tier 2 — Local fork with LiteSVM

```bash
npm run fixtures   # pull programs and accounts from mainnet into fixtures/
npm test
```

LiteSVM is the Solana virtual machine without a validator: no network, no slots,
no consensus — just the runtime executing the **real programs** pulled from
mainnet against the **real state** pulled from mainnet.

### What gets downloaded

`scripts/dump-fixtures.mjs` extracts:

- the `.so` binaries of **klend**, **kfarms** and **whirlpool** from their
  `programdata` accounts (45-byte `UpgradeableLoaderState` header, then the real
  ELF length computed from the section headers — trimming "to the last non-zero
  byte" produces a corrupt ELF that LiteSVM rejects with
  `Offset or value is out of bounds`);
- market, reserves, vaults, mints, cToken mints, Scope feed — **derived from the
  reserves**, not hardcoded, so it also works on another market;
- the Orca pool with its vaults and 7 tick arrays around the current price.

27 accounts plus 3 programs, ~4.8 MB, 17 RPC calls. Fixtures stay out of git.

### The lever that makes everything testable: the Scope feed

Verified in `utils/prices/scope.rs`: klend does **not** CPI into Scope. It reads
the `OraclePrices` account directly, and the only check is that the address
matches `reserve.config.tokenInfo.scopeConfiguration.priceFeed`.

So locally, **rewriting those bytes moves the price**. Layout:

```
OraclePrices = discriminator(8) + oracle_mappings: Pubkey(32) + prices: [DatedPrice; 512]
DatedPrice   = value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 | [u8;24]
offset(i)    = 40 + i*56        price = value / 10^exp
```

`tests/world.ts` exposes `setScopePrice(world, feed, index, price)`, which also
writes the current slot and timestamp so `max_age_price_seconds` (180 s) is
satisfied. **This is how a position is made liquidatable without waiting for the
market**: push the collateral price down until LTV crosses the threshold.

### What the local tests cover

```
the local world loads mainnet programs and state
the market Scope feed prices USDY at ~1e-6
refreshReserve applies the Scope prices we write ourselves
flash borrow + flash repay: the pair passes the introspection checks
a wrong borrow_instruction_index makes the transaction revert
without a flash repay the borrow reverts
swapV2 USDY->USDC: real execution, and the quote agrees
```

Measured, not estimated:

- **flash loan fee**: borrowing 1,000 USDC from the Main Market costs exactly
  **10,000 base units = 0.01 USDC**, i.e. 1e-5. Empirical confirmation of
  `flash_loan_fee_sf = 11529215046068` read from the reserve.
- **Orca swap**: 1,000 USDY -> **1,141.68236 USDC**, against an off-chain quote of
  1,141.68236 -> **0.000 bps** of drift. Quote engine and execution agree.
- **swap CU**: **37,318**, far under the initial 60-110k estimate.

The two negative flash-loan tests are worth as much as the positive one: they
prove that a `borrowInstructionIndex` off by **one** fails the whole transaction.
That is the easiest mistake to introduce when reordering instructions.

### The missing piece: building a liquidatable position

The tests cover both ends of the transaction (flash loan, swap) but not yet the
liquidation, which needs an obligation carrying debt. In the local world:

1. forge the victim's token accounts with USDY (`forgeTokenAccount`);
2. `initUserMetadata` + `initObligation` +
   `depositReserveLiquidityAndObligationCollateralV2` (USDY) +
   `borrowObligationLiquidityV2` (USDC) — all builders exist in the SDK;
3. the Nysa USDC reserve holds only 0.1 USDC: either raise liquidity by forging
   the supply vault **and** rewriting `liquidity.total_available_amount` in the
   reserve, or point the fixtures at another market;
4. `setScopePrice(feed, USDY_index, crashed_price)` until LTV > 75%;
5. run the bot's own transaction (`buildLiquidationMessage`) and check the USDC delta.

Step 3 is the annoying one: editing a field of a `zero_copy` struct requires the
exact offset. The cleaner alternative is to point the fixtures at an active
Kamino market (`MARKET=... npm run fixtures`), where the liquidity already exists.

---

## Tier 3 — `solana-test-validator --clone`

LiteSVM exposes no RPC: it validates instructions, **not** the bot code that
talks to the network (`simulateTransaction`, `getRecentPrioritizationFees`,
`sendTransaction`, `getSignatureStatuses`, blockhash expiry, rebroadcast). For
that you need a local validator with cloned state:

```bash
solana-test-validator --reset \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD \
  --clone-upgradeable-program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr \
  --clone-upgradeable-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc \
  $(for f in fixtures/accounts/*.json; do echo -n "--account $(basename $f .json) $f "; done)
```

The JSON files produced by `npm run fixtures` are already in the format
`--account` expects. Point the bot at `RPC_PRIMARY=http://127.0.0.1:8899` and set
`DRY_RUN=false`: the transactions are real, on a local chain.

**surfpool** (a Rust binary, not on npm) forks mainnet on demand without
enumerating accounts — more convenient, one more dependency.

---

## Tier 4 — Devnet is not useful here

klend, kfarms and whirlpool are deployed on devnet, and **159 lending markets**
exist there under the production program id. The staging program
`SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh` is deployed on both networks but
has **no markets on devnet**.

The blocker: the **USDY/USDC Orca pool does not exist on devnet**, so the exit leg
would have to be simulated or replaced. The local fork is strictly better.

> On the staging program, `max_allowed_ltv_override_percent` works — but only
> when `liquidator == obligation.owner`. It would allow self-liquidation without
> actually being underwater; with no devnet markets, the route is closed today.

---

## Tier 5 — Mainnet, simulation only, then real

`DRY_RUN=true` is the bot's default: the loop runs on real mainnet state, builds
and **signs** the transaction, hands it to `simulateTransaction` and throws it
away. Nothing is submitted, so it costs nothing and can lose nothing.

For going live, see [05-operations.md](05-operations.md).

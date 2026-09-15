# Kamino liquidation bot — USDY collateral / USDC debt

Atomic liquidation on **Kamino Lend** funded by a **USDC flash loan**, with the
seized **USDY** collateral sold on an **Orca Whirlpool** — all in a single
transaction.

Target market: [`F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy`](https://kamino.com/curators/markets/F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy)
— on-chain name **"Nysa First Trial"**.

---

## Read this first

At slot ~446,815,000 (2026-09-13/15) the target market is **not operational**:

- **0 obligations**, no debt, 0.1 USDC and 0.1 USDY of liquidity;
- the **USDY reserve's oracle points at a placeholder Scope index** that reads
  `0.000001 USD` instead of ~1.145, so any deposit is valued at essentially zero
  and nobody can borrow against it.

The bot is built for when the curator opens the market. The flash loan is taken
from Kamino's **Main Market** (~23M USDC available), which is legal because
nothing ties the borrowed reserve to the market of the liquidated obligation.

Full evidence in **[docs/01-protocol.md](docs/01-protocol.md)**.

```bash
npm run preflight                  # read-only; reports exactly what is missing
MARKET=<pubkey> npm run preflight  # size up any other Kamino market
```

---

## The transaction

```
0  ComputeBudget  setComputeUnitLimit
1  ComputeBudget  setComputeUnitPrice
2  klend          refreshReserve(USDC)              + Scope
3  klend          refreshReserve(USDY)              + Scope
4  klend          refreshObligation                 + reserves in remaining accounts
5  klend          flashBorrowReserveLiquidity       <- Main Market, ~23M USDC
6  klend          liquidateObligationAndRedeemReserveCollateralV2
7  whirlpool      swapV2  USDY -> USDC  (aToB = true)
8  klend          flashRepayReserveLiquidity        borrowInstructionIndex = 5
```

If the swap returns less than the repayment needs, instruction 8 fails and **the
entire transaction reverts**: the flash loan never happened. A failed attempt
costs base fee plus priority fee — fractions of a cent. No capital is ever at
risk, because the capital is the flash loan.

## Verified numbers

| | |
|---|---|
| USDY liquidation bonus | **200-500 bps** |
| Close factor | **20%** (100% above 95% LTV) |
| Protocol liquidation fee | **0%** (1 lamport floor) |
| Flash loan fee (Main Market USDC) | **0.001%** (`flash_loan_fee_sf = 11529215046068`, 2^60 scale) |
| Orca USDY/USDC pool fee | **0.16%** |
| Measured price impact, 50,000 USDY (fee excluded) | **0.015%** |
| Expected net margin at minimum bonus | **~181 bps** |
| Market permissioned? | **No** — liquidation is permissionless |

## Quick start

```bash
npm install
cp .env.example .env    # fill in RPC_PRIMARY and KEYPAIR_PATH
```

Check that on-chain parameters still match what is hardcoded in `src/config.ts`
(read-only, no key needed):

```bash
npm run inspect
```

Real USDY -> USDC quote on the exit pool, to calibrate slippage:

```bash
npm run quote 1000 10000 50000
```

Run in dry-run mode (the default: **nothing is ever submitted**):

```bash
npm start
```

## Tests

Read-only against real mainnet and an active market — no key, no submission:

```bash
npm run test:live
```

Against the real mainnet programs, executed **locally** with no network:

```bash
npm run fixtures   # pull programs and accounts from mainnet into fixtures/
npm test
```

13 tests pass today. The captured output — with versions, commit and mainnet slot
— is committed at **[docs/TEST-REPORT.md](docs/TEST-REPORT.md)** and regenerated with:

```bash
npm run report -- --live
```

CI runs typecheck and the local suites on every push; a daily
[canary workflow](.github/workflows/canary.yml) re-runs the read-only mainnet
checks and republishes the report.

**Read-only live** — the scanner reads all **106,217 positions** of the Main
Market in **one ~3-second call** using `dataSlice` (7 MB instead of 355), field
offsets are re-verified against the official decoder, and the constants in
`src/config.ts` are compared with on-chain state.

**Local (LiteSVM)** on the real programs:

- `flashBorrow` + `flashRepay` pass introspection — and fail, as they must, when
  `borrowInstructionIndex` is off by one;
- `refreshReserve` consumes Scope prices rewritten in the local world;
- `swapV2` USDY->USDC actually executes: **1,000 USDY -> 1,141.68236 USDC**,
  identical to the off-chain quote (**0.000 bps** of drift), **37,318 CU**.

The **liquidation** itself is not covered yet: it needs an obligation carrying
debt, and the target market has none. The recipe for building one in the local
world is in [docs/04-testing.md](docs/04-testing.md).

## Documentation

| File | Contents |
|---|---|
| [01-protocol.md](docs/01-protocol.md) | Verified protocol reference: instructions, accounts, constraints, and the target-market findings |
| [02-design.md](docs/02-design.md) | The atomic transaction, bot architecture, language choice |
| [03-profitability.md](docs/03-profitability.md) | Profit equation and execution thresholds |
| [04-testing.md](docs/04-testing.md) | Testing tiers: local fork, live read-only, cloned validator |
| [05-operations.md](docs/05-operations.md) | Reliability, security, go-live sequence, day-2 operations |
| [TEST-REPORT.md](docs/TEST-REPORT.md) | Generated: captured output of every suite, with commit and slot |

Every claim is marked **[V]** (verified against source or on-chain state) or
**[A]** (assumption or estimate).

## Project layout

```
src/
  config.ts             verified constants + .env
  rpc.ts                RPC pool with failover, key loading
  readonly.ts           RPC client that refuses every write
  scanner.ts            health prefilter over all positions (dataSlice)
  eligibility.ts        "is it liquidatable?" — off-chain replica of the rules
  profit.ts             "is it worth it?" — profit equation and thresholds
  execute.ts            simulation, priority fee, submission, confirmation, lock
  index.ts              the main loop
  build/
    klend.ts            refresh, flash loan pair, liquidate V2
    orca.ts             quote + swapV2 + tick arrays
    computeBudget.ts    the two budget instructions, written by hand
    tx.ts               assembles the 9 instructions into the atomic transaction
tests/
  world.ts              loads the local fork into LiteSVM + helpers
  readonly-rpc.ts       live-test endpoints and the read-only client
  *.test.ts             refresh / flash loan / swap / live read-only
scripts/
  preflight.ts          production readiness check
  inspect-market.mjs    prints the real state of a market
  quote-orca.ts         real quote on the exit pool
  dump-fixtures.mjs     downloads programs and accounts for the local world
```

## Status

`DRY_RUN=true` is the default. The transaction build-and-submit path has never
run against a live liquidatable position, because none exists on the target
market. Five items remain before production (ALT, token accounts, wiring the
scanner into the loop, real SOL price, reconciliation) — see
[docs/05-operations.md](docs/05-operations.md).

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

Real USDY -> USDC quote on the exit pool, to calibrate slippage:

```bash
npm run quote 1000 10000 50000
```

Run in dry-run mode (the default: **nothing is ever submitted**):

```bash
npm start
```

## Tests

Against the real mainnet programs, executed **locally** with no network:

```bash
npm run fixtures   # pull programs and accounts from mainnet into fixtures/
npm test
```

Read-only against real mainnet and an active market — no key, no submission:

```bash
npm run test:live
```

Is the target market open for business yet? (red until the curator finishes):

```bash
npm run test:ready
```

### What is covered

**Local (LiteSVM)** — 7 tests on the real programs, including **the full
production path**: a lender supplies USDC, a borrower deposits USDY and borrows
against it through klend's own instructions, the oracle drops from 1.1435 to
1.04, the position crosses its 95% threshold, and the bot's own transaction
builder liquidates it.

```
repaid 5000 USDC, seized ~4658.65 USDY, profit 318.62 USDC, residue 245.19 USDY, CU 238125
LTV 87.45% -> 96.15% (threshold 95.00%) -> 95.54% after liquidation
```

Also: `flashBorrow` + `flashRepay` pass introspection — and fail, as they must,
when `borrowInstructionIndex` is off by one; `refreshReserve` consumes Scope
prices rewritten in the local world; `swapV2` USDY->USDC executes for real,
**1,000 USDY -> 1,141.69 USDC**, identical to the off-chain quote (**0.000 bps**
of drift).

**Live read-only** — 6 tests. The scanner reads all **106,000+ positions** of the
Main Market in **one ~3-second call** using `dataSlice` (7 MB instead of 355),
field offsets are re-verified against the official decoder, and the constants in
`src/config.ts` are compared with on-chain state.

**Readiness gate** — 6 tests, red until the market is live. It never goes red
because of a code change: that separation is deliberate.

The captured output of every suite — with versions, commit and slot — is
committed at **[docs/TEST-REPORT.md](docs/TEST-REPORT.md)** and regenerated with:

```bash
npm run report -- --live
```

CI runs typecheck and the local suites on every push; a daily
[canary workflow](.github/workflows/canary.yml) re-runs the read-only mainnet
checks plus the readiness gate, and republishes the report.

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
  setup-position.ts     builds a real borrowed position via klend instructions
  liquidation.test.ts   the production path end to end
  refresh / flashloan / swap .test.ts
  live.readonly.test.ts read-only checks against real mainnet
  market-ready.test.ts  the go-live gate for the target market
scripts/
  preflight.ts          production readiness check
  quote-orca.ts         real quote on the exit pool
  dump-fixtures.mjs     downloads programs and accounts for the local world
```

## Status

`DRY_RUN=true` is the default. The transaction path is now covered end to end in
the local fork, so what remains untested is submission against mainnet itself.

Five items remain before production — ALT, token accounts, wiring the scanner
into the loop, a real SOL price, reconciliation — plus the three the curator owns
(the USDY oracle index, reserve liquidity, actual borrowers). `npm run test:ready`
tracks the latter three. See [docs/05-operations.md](docs/05-operations.md).

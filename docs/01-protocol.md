# Protocol reference and target-market findings

> Verification basis: `Kamino-Finance/klend` sources (branch `main`),
> IDL from `@kamino-finance/klend-sdk@12.0.0`, `orca-so/whirlpools` sources,
> on-chain state read over mainnet RPC at **slot ~446,813,000 (2026-09-13)**.
>
> **[V]** = verified against source or on-chain state. **[A]** = assumption or estimate.

---

## 1. Programs and PDAs

| Program | Address |
|---|---|
| Kamino Lending (klend) | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` [V] |
| klend staging | `SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh` [V] |
| Kamino Farms | `FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr` [V] |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` [V] |
| Scope (oracle) | `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ` [V] |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` [V] |

```
lending_market_authority = PDA(["lma", lending_market],                   klend)
whirlpool_oracle         = PDA(["oracle", whirlpool],                 whirlpool)
tick_array               = PDA(["tick_array", whirlpool,
                                start_tick_index.toString()],         whirlpool)
obligation_farm_user     = PDA(["user", reserve_farm_state, obligation],  farms)
```

## 2. Flash loan introspection rules — `lending_market/flash_ixs.rs` [V]

1. **No CPI.** `is_flash_forbidden_cpi_call()` requires the instruction to be
   top-level and its program id to be klend. You cannot wrap the flash loan in
   your own program.
2. **One** flash borrow and **one** flash repay per transaction.
3. `repay.liquidity_amount == borrow.liquidity_amount` (principal, not principal + fee).
4. `repay.borrow_instruction_index` must point at the borrow's exact index.
5. `borrow_instruction_index < current_index`.
6. `repay_ix.accounts[3] == reserve` passed to the repay.
7. **Borrow and repay account lists must be identical** — same length, same
   pubkey at every position. Optional referrer accounts must be passed the same
   way in both.

> There is **no** prohibition on placing other klend instructions between borrow
> and repay. The loop in `flash_borrow_checks_internal` skips anything that is
> not a borrow/repay. Independent confirmation: the official SDK
> (`dist/leverage/instructions.js`) builds flash-borrow -> deposit -> borrow ->
> flash-repay. **A liquidation in the middle is legal.**

## 3. Instruction account layouts (from the IDL) [V]

### `flash_borrow_reserve_liquidity`

```
0  user_transfer_authority          signer
1  lending_market_authority
2  lending_market
3  reserve                          mut   <- checked by flash_repay: accounts[3]
4  reserve_liquidity_mint
5  reserve_source_liquidity         mut   (= reserve.liquidity.supply_vault)
6  user_destination_liquidity       mut   (your USDC token account)
7  reserve_liquidity_fee_receiver   mut   (= reserve.liquidity.fee_vault)
8  referrer_token_state             mut  optional
9  referrer_account                 mut  optional
10 sysvar_info                            (Sysvar1nstructions1111...)
11 token_program
args: liquidity_amount: u64
```

`flash_repay_reserve_liquidity` has the same shape with
`reserve_destination_liquidity` / `user_source_liquidity` in place of their
counterparts. Args: `liquidity_amount: u64`, `borrow_instruction_index: u8`.

### `liquidate_obligation_and_redeem_reserve_collateral_v2`

```
liquidation_accounts:
  0  liquidator                              signer
  1  obligation                              mut
  2  lending_market
  3  lending_market_authority
  4  repay_reserve                           mut   <- USDC (debt)
  5  repay_reserve_liquidity_mint
  6  repay_reserve_liquidity_supply          mut
  7  withdraw_reserve                        mut   <- USDY (collateral)
  8  withdraw_reserve_liquidity_mint
  9  withdraw_reserve_collateral_mint        mut   (cUSDY)
 10  withdraw_reserve_collateral_supply      mut
 11  withdraw_reserve_liquidity_supply       mut
 12  withdraw_reserve_liquidity_fee_receiver mut
 13  user_source_liquidity                   mut   <- your USDC (repayment leaves here)
 14  user_destination_collateral             mut   <- your cUSDY (transit)
 15  user_destination_liquidity              mut   <- your USDY (collateral arrives)
 16  collateral_token_program                      (always legacy SPL Token)
 17  repay_liquidity_token_program
 18  withdraw_liquidity_token_program
 19  instruction_sysvar_account
collateral_farms_accounts: obligation_farm_user_state opt, reserve_farm_state opt
debt_farms_accounts:       obligation_farm_user_state opt, reserve_farm_state opt
farms_program
args: liquidity_amount u64, min_acceptable_received_liquidity_amount u64,
      max_allowed_ltv_override_percent u64
```

Notes from the source:
- `collateral_token_program` is typed `Program<'info, Token>` -> **always** legacy
  SPL Token, even if the liquidity mint were Token-2022. cTokens are always legacy [V].
- `max_allowed_ltv_override_percent` only applies when
  `liquidator == obligation.owner` **and** only on the staging program. On
  mainnet it is ignored with a warning [V].
- `min_acceptable_received_liquidity_amount` is your on-chain slippage guard: if
  `net_withdraw_liquidity_amount < min` the instruction fails with
  `LiquidationRewardTooSmall` [V]. **Always set it.**

**Use V2, not V1.** V1 carries `check_refresh_ixs!`, which requires
`refresh_obligation_farms_for_reserve` in the immediately adjacent positions —
incompatible with wrapping the call in a flash loan. V2 refreshes farms by CPI
and accepts absent farm accounts (both Nysa reserves have
`farm_collateral = farm_debt = 11111111111111111111111111111111`) [V].

## 4. Freshness preconditions [V]

`utils::assert_obligation_liquidatable` requires, **in the current slot**, that
`repay_reserve`, `withdraw_reserve` and `obligation` are all non-stale under
`PriceStatusFlags::LIQUIDATION_CHECKS`. So the same transaction must first run
`refresh_reserve(USDC)`, `refresh_reserve(USDY)` and `refresh_obligation`.

`refresh_reserve` accounts: `reserve` (mut), `lending_market`, `pyth_oracle` opt,
`switchboard_price_oracle` opt, `switchboard_twap_oracle` opt, `scope_prices`
opt. On this market **only `scope_prices`** is set (`3NJYftD5...`); Pyth reads
`nu1111...` and Switchboard is empty [V].

`refresh_obligation` accounts: `lending_market`, `obligation` (mut) plus
**remaining accounts** in order: all deposit reserves, then all borrow reserves,
then — only if `obligation.has_referrer()` — one `referrer_token_state` per
borrow. The count is checked exactly; a wrong length yields `InvalidAccountInput`.

`price_refresh_trigger_to_max_age_pct = 0` on the Nysa market means
`is_price_refresh_needed` is **always true**, so `refresh_reserve` re-reads Scope
on every call. It cannot be skipped [V].

## 5. Orca swap [V]

`swap` (v1) accounts, in order: `token_program`, `token_authority` (signer),
`whirlpool` (mut), `token_owner_account_a` (mut), `token_vault_a` (mut),
`token_owner_account_b` (mut), `token_vault_b` (mut), `tick_array_0/1/2` (mut),
`oracle`.

`swap_v2` prepends `token_program_a`, `token_program_b`, `memo_program`, adds
`token_mint_a` / `token_mint_b` after `whirlpool`, makes `oracle` writable, and
accepts `remaining_accounts_info` for transfer hooks and supplemental tick arrays.

Args (identical in both): `amount u64`, `other_amount_threshold u64`,
`sqrt_price_limit u128`, `amount_specified_is_input bool`, `a_to_b bool`.

For this route: USDY is mint A, USDC is mint B -> **`a_to_b = true`**,
`amount_specified_is_input = true`, `other_amount_threshold` = minimum USDC
accepted.

---

## 6. Target market: findings

Market `F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy` — on-chain name
**"USDY Ondo Market"** (renamed from "Nysa First Trial" between 13 and 18 Sep
2026), owner `66pW72Fchnr34FGgXrxheGs3BbUsDSwJmGcK7m8Bz1Yv`.

### 6.1 The market is empty [V]

| Measure | On-chain value |
|---|---|
| Obligations in the market | **0** |
| `borrowedAmountSf`, USDC reserve | **0** |
| `totalAvailableAmount`, USDC reserve | **100000** = 0.1 USDC |
| `totalAvailableAmount`, USDY reserve | **100000** = 0.1 USDY |
| Last USDC reserve refresh | slot 445,316,393 (~7 days earlier) |

Only the 0.1-token seed deposits created by `init_reserve` are present.

### 6.2 The USDY oracle points at a placeholder index [V] — most severe

The USDY reserve's scope chain is `[3]` on feed `3NJYftD5...`. Decoding that
account (layout `disc(8) + oracle_mappings(32) + [DatedPrice; 512]`, 56 bytes per
entry, `price = value / 10^exp`):

```
index  0 ->    101.36        (SOL)
index  1 ->  2,514.37        (ETH)
index  2 -> 77,689.33        (BTC)
index  3 ->      0.000001    <- what the USDY reserve reads
index  5 ->      0.000001
index 79 ->      1.145563    <- the real USDY price
index 97 ->      1.145563
```

Verified in `utils/prices/scope.rs`: `get_base_price` indexes the array directly
and `price_to_fraction` computes `value / 10^exp`. With this configuration
`refresh_reserve` would write a USDY price of **0.000001 USD**.

Consequence: a 10,000 USDY deposit (~$11,455) is credited as **$0.01** of
collateral, so nobody can borrow, so there is never debt to liquidate.
Consistent with the rest — never-refreshed reserves, 0.1-token seeds, the name
"First Trial": **the market is not finished being configured.**

Fix belongs to the curator: `update_reserve_config`, scope chain `[3]` -> `[79]`.

### 6.3 The flash loan cannot come from this market [V]

`flash_borrow_reserve_liquidity` draws from `reserve.liquidity.supply_vault`,
which holds 0.1 USDC here. But nothing ties the flash loan's reserve to the
market of the liquidated obligation, so the bot borrows from the **Main Market**
`7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`, USDC reserve
`D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59` (~23M USDC available).

Fee there: `flash_loan_fee_sf = 11529215046068`, 2^60 scale -> **1e-5 = 0.001%**,
charged *Exclusive* (on top of principal). Measured in LiteSVM: a 1,000 USDC
flash loan costs exactly 10,000 base units = 0.01 USDC [V].

> `flash_loan_fee_sf == u64::MAX` means flash loans are disabled; `0` means a
> zero fee. Both Nysa reserves read `0` — free, but unusable for lack of liquidity.

### 6.4 You may receive cTokens instead of the underlying [V]

In `lending_operations::liquidate_obligation`:

```rust
let withdraw_collateral_amount = min(withdraw_amount, max_redeemable_collateral);
```

and in `post_liquidate_redeem`, when `withdraw_collateral_amount == 0` nothing is
redeemed and you are left holding **cUSDY** (mint
`C7dKsFYaM2DcVJSDjouPTfLc9292Lkd5ti9VQCdx2UDg`), which does not trade on Orca.
The swap then fails and the whole transaction reverts — cost: base fee plus
priority fee. The profit engine must check
`estimated_withdraw <= freely_redeemable_collateral_amount` up front.

### 6.5 Risk parameters [V]

USDY reserve `rpTGWR3JDjjPfXLCg5Fx1GpSdUxPt1pxW7fwXGUT6js`:

| Parameter | Value |
|---|---|
| `loan_to_value_pct` | 92 |
| `liquidation_threshold_pct` | **95** |
| `min_liquidation_bonus_bps` | **200** |
| `max_liquidation_bonus_bps` | **500** |
| `bad_debt_liquidation_bonus_bps` | 10 |
| `protocol_liquidation_fee_pct` | **0** |
| `borrow_factor_pct` | 100 |
| `borrow_limit` | 0 (collateral-only) |
| `deposit_limit` | 250,000 USDY |

Market: `liquidation_max_debt_close_factor_pct = 25`,
`max_liquidatable_debt_market_value_at_once = 30000` USD,
`min_full_liquidation_value_threshold = 100` USD,
`insolvency_risk_unhealthy_ltv_pct = 97`,
`permissioning_authority = 11111111111111111111111111111111` -> **permissionless
liquidation**.

Two of those bite in ways the earlier configuration did not:

- **$30,000 cap per liquidation** (was $500,000) is now a real ceiling on size.
- **Below $100 of debt the program demands a FULL repayment**: `calculate_liquidation`
  returns `RepayTooSmallForFullLiquidation` if you offer a partial amount, and
  neither the close factor nor the market cap applies. `src/profit.ts` sizes for
  this case explicitly.

The USDC reserve has also acquired a **collateral farm**
(`farm_collateral = EfsknvSqpqkbSVMmKosmeT5Hn32P5mmC4BEz36ybgVbP`). It does not
affect this route — `liquidateV2` reads the *withdraw* reserve's collateral farm
and the *repay* reserve's debt farm, both still unset — but it means the curator
is attaching farms, and the moment one lands on either of those two fields the
builder's `none()` farm accounts would make the instruction revert.
`npm run preflight` now asserts both are still unset.

### 6.6 The Orca exit route [V]

Pool `AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD` — `tickSpacing = 16`,
`feeRate = 1600` -> **0.16%**, `protocolFeeRate = 1300` (13% *of the fee*).

- `tokenMintA = USDY`, `tokenMintB = USDC` -> selling USDY is **A->B**
- Balances: **49,739 USDY / 2,857,245 USDC** — the side we need is deep
- In-range `liquidity = 352,599,358,162,720`, `sqrtPrice = 19726079875541305854`, tick 1341
- 24h volume ~$11,000 — thin as flow, not as depth
- Pool ALT: `9iiRsm2M5jaFnDbgAjBbbasTwo6m3AV6N22k1ANt47Bm`

Real quotes against live tick arrays (`npm run quote`, slot 446,815,345) [V]:

| USDY sold | USDC out | Average price | Deviation from spot (0.16% fee included) |
|---|---|---|---|
| 1,000 | 1,141.68 | 1.141682 | -0.160% |
| 10,000 | 11,416.51 | 1.141651 | -0.163% |
| 50,000 | 57,075.66 | 1.141513 | -0.175% |

So **pure price impact** runs from ~0% to **0.015%** on 50,000 USDY. Recompute per
quote: `L` only holds inside the current tick range.

Tick arrays (PDA `["tick_array", pool, start.toString()]`, span = 88x16 = 1408):
start `0` -> `4buLqbry...` (484 bytes -> **dynamic tick array**), start `-1408` ->
`5iGQLNDV...` (148 bytes), start `-2816` -> `J9DGsBtR...` (**uninitialized**).
Oracle PDA `4PsbTRYT...` is also uninitialized, which is normal for a pool
without adaptive fees.

### 6.7 USDY token [V]

Mint `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6`: **legacy** SPL Token (not
Token-2022), 6 decimals, supply 157.2M, and it has a **freeze authority**
(`51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK`) — token accounts can be frozen.

### 6.8 The official terminator does not use flash loans [V]

`Kamino-Finance/terminator` liquidates from **its own inventory** and rebalances
afterwards, in separate transactions, through **Jupiter**
(`terminator/src/jupiter.rs`). The only occurrence of "flash" in the repository
is a comment in `math.rs`. Use it as a reference for the scanner, lookup tables,
token-account handling and the `crank` loop — not for the atomic part.

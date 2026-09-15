# Profitability model and execution thresholds

## 1. Symbols

| Symbol | Meaning | Source |
|---|---|---|
| `D` | total USDC debt of the obligation (base units) | `ObligationLiquidity.borrowed_amount()` |
| `R` | USDC actually repaid (`repay_amount`) | output of `calculate_liquidation` |
| `CF` | close factor | `market.liquidation_max_debt_close_factor_pct` = **20%** [V] |
| `b` | liquidation bonus rate | see §2, **in [0.02, 0.05]** [V] |
| `P_scope_USDY` | USDY price from Scope, as used by klend | reserve refresh |
| `W` | gross USDY received | see §3 |
| `pi` | protocol liquidation fee | `protocol_liquidation_fee_pct` = **0%** [V] (floor of 1 lamport) |
| `f_orca` | Orca pool fee | `feeRate / 1e6` = **0.0016** [V] |
| `s` | Orca slippage (price impact) | live quote |
| `O` | USDC obtained from the swap | see §4 |
| `phi` | flash loan fee | `flash_loan_fee_sf / 2^60` = **1e-5** on Main Market USDC [V] |
| `c_base` | base fee | 5000 lamports x signatures = **5000** |
| `c_prio` | priority fee | `CU_limit x micro_lamports / 1e6` lamports |
| `p_fail` | probability the transaction fails | rolling estimate |

## 2. The bonus, from `calculate_liquidation_bonus` [V]

```
ltv        = obligation.loan_to_value()              // borrow-factor adjusted
ltv_nobf   = obligation.no_bf_loan_to_value()
ltv_max    = obligation.unhealthy_loan_to_value()    // weighted liquidation threshold

if ltv_nobf >= 0.99:
    b = max( min(bad_debt_bps_coll, bad_debt_bps_debt), 1 - ltv_nobf )   // bad-debt zone
else:
    unhealthy = ltv - ltv_max
    max_bonus = min( max(max_bps_coll, max_bps_debt), emode_max_bps )
    min_bonus = max( max(min_bps_coll, min_bps_debt), unhealthy )
    b         = min( min_bonus, max_bonus, 1 - ltv_nobf )
```

For the USDY/USDC pair on the Nysa market: `min_bps = 200`, `max_bps = 500`, so
**b starts at 2% and grows toward 5%** as LTV exceeds the threshold. The
`1 - ltv_nobf` cap binds above 95% LTV.

## 3. How much collateral you receive

```
liquidatable_mv = min( D_mv * CF_effective , max_liquidatable_debt_mv_at_once )
CF_effective    = 1.00  if ltv > insolvency_risk_unhealthy_ltv (95%)   [V]
                = 0.20  otherwise

R_max           = D * (liquidatable_mv / D_mv)
R               = min(R_requested, R_max)

seized_value    = R_mv * (1 + b)
W_gross         = seized_value / P_scope_USDY                     (in USDY)
protocol_fee    = max( ceil( (W_gross - W_gross/(1+b)) * pi ), 1 ) [V]
W               = W_gross - protocol_fee
```

With `pi = 0` the protocol fee is 1 lamport. Negligible but **not zero**: the
code does `max(protocol_fee, 1)`.

Hard constraint to check **before signing**:

```
W_gross (in cTokens) <= withdraw_reserve.freely_redeemable_collateral_amount()
```

otherwise you receive cUSDY instead of USDY and the transaction reverts at the
swap. See [01-protocol.md §6.4](01-protocol.md).

## 4. Swap output

```
O = W * P_orca(W) * (1 - f_orca)
```

where `P_orca(W)` is the **average executed** price, not spot: take it from a
real quote against the tick arrays, not from `sqrtPrice`. Write
`P_orca(W) = P_orca_spot * (1 - s(W))`.

## 5. Net profit

```
Pi = O - R - phi*R - c_base - c_prio

   = W * P_orca_spot * (1 - s(W)) * (1 - f_orca) - R * (1 + phi) - c_base - c_prio
```

Substituting `W ~= R * (P_scope_USDC / P_scope_USDY) * (1 + b)`:

```
Pi ~= R * [ (1 + b) * rho * (1 - s) * (1 - f_orca) - (1 + phi) ] - c_base - c_prio
```

where **`rho = P_orca_USDY->USDC / P_scope_USDY`** — the ratio between what the
market actually pays for USDY and what Kamino says it is worth. `rho` is the real
risk factor: if Scope overstates USDY by 1%, half the minimum bonus is gone.

### Worked numbers [A]

`b = 0.02`, `rho = 1.000`, `f_orca = 0.0016`, `phi = 0.00001`, and
`s = 0.00015` (price impact measured on 50,000 USDY with `npm run quote`, net of
the fee):

```
relative margin = 1.02 * 1 * 0.99985 * 0.9984 - 1.00001 = 0.01812 -> 1.81%
```

| `R` repaid | Gross | Fixed costs (c_base + c_prio @ 350k CU, 20k uLamports ~ 0.000012 SOL) | Net |
|---|---|---|---|
| 500 USDC | 9.06 | ~0.004 USD | **~9.06 USDC** |
| 2,000 USDC | 36.2 | ~0.004 USD | **~36.2 USDC** |
| 10,000 USDC | 181.2 | ~0.004 USD | **~181.2 USDC** |

Break-even against fixed costs sits around $0.25 of debt — irrelevant. **The real
break-even is `rho` and `s`.** The margin vanishes when

```
(1 + b)(1 - s)(1 - f_orca) * rho = 1 + phi
```

which, at b = 2%, means `rho*(1-s)` dropping below **0.98216** — an oracle/market
mismatch of 1.8%.

## 6. Execution thresholds

```
Pi_expected  = as above, on a live Orca quote
Pi_worst     = recomputed with s = s_p95 and rho = rho_p05 (historical percentiles)
failure_cost = c_base + c_prio

Execute if and only if:
  (1) Pi_worst                                 >  MIN_PROFIT_USDC        (e.g. 2.0 USDC)
  (2) Pi_expected*(1 - p_fail) - p_fail*failure_cost > MIN_EV_USDC       (e.g. 1.0 USDC)
  (3) Pi_expected / R                          >  MIN_MARGIN_BPS         (e.g. 50 bps)
  (4) W_gross                                  <= freely_redeemable_collateral
  (5) R                                        <= flash_reserve.total_available_liquidity
  (6) simulateTransaction                      -> err == null
```

Rule (3) stops you burning attention and fees on huge liquidations with razor
margins. Rule (2) is what matters under competition: with a high `p_fail` (races
lost) the expected value collapses even when `Pi_expected` looks great.

### Parameters to re-read every cycle, never cache

`liquidation_max_debt_close_factor_pct`, `min/max_liquidation_bonus_bps`,
`protocol_liquidation_fee_pct`, `flash_loan_fee_sf`, the pool `feeRate`,
`total_available_liquidity_amount`. A curator can change any of them with
`update_reserve_config` / `update_lending_market` at any moment.

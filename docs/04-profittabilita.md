# Step 4 — Equazione di profitto e soglia minima

## 4.1 Simboli

| Simbolo | Significato | Fonte del valore |
|---|---|---|
| `D` | debito USDC totale dell'obligation (base units) | `ObligationLiquidity.borrowed_amount()` |
| `R` | USDC effettivamente ripagati (`repay_amount`) | output di `calculate_liquidation` |
| `CF` | close factor | `market.liquidation_max_debt_close_factor_pct` = **20 %** [V] |
| `b` | liquidation bonus rate | vedi §4.2, **∈ [0,02 ; 0,05]** [V] |
| `P_scope_USDY` | prezzo USDY da Scope, usato da klend | reserve refresh |
| `P_scope_USDC` | prezzo USDC da Scope | reserve refresh |
| `W` | USDY lordi ricevuti | vedi §4.3 |
| `π` | protocol liquidation fee | `protocol_liquidation_fee_pct` = **0 %** [V] (ma min 1 lamport) |
| `f_orca` | fee pool Orca | `feeRate / 1e6` = **0,0016** [V] |
| `s` | slippage Orca (impatto prezzo + spread oracle) | quote live |
| `O` | USDC ottenuti dallo swap | vedi §4.4 |
| `φ` | flash loan fee | `flash_loan_fee_sf / 2^60` = **1e-5** su Main Market USDC [V] |
| `c_base` | base fee | 5000 lamport × n_firme = **5000** |
| `c_prio` | priority fee | `CU_limit × micro_lamports / 1e6` lamport |
| `p_fail` | probabilità di fallimento della tx | stima rolling |

## 4.2 Il bonus (ricostruito da `calculate_liquidation_bonus`) [V]

```
ltv        = obligation.loan_to_value()              // borrow-factor adjusted
ltv_nobf   = obligation.no_bf_loan_to_value()
ltv_max    = obligation.unhealthy_loan_to_value()    // ≈ liquidation_threshold pesata

se ltv_nobf >= 0,99:
    b = max( min(bad_debt_bps_coll, bad_debt_bps_debt), 1 - ltv_nobf )   // zona bad debt
altrimenti:
    unhealthy   = ltv - ltv_max
    max_bonus   = min( max(max_bps_coll, max_bps_debt), emode_max_bps )
    min_bonus   = max( max(min_bps_coll, min_bps_debt), unhealthy )
    b           = min( min_bonus, max_bonus, 1 - ltv_nobf )
```

Per la coppia USDY/USDC del market Nysa: `min_bps = max(200, 200) = 200`,
`max_bps = max(500, 500) = 500` → **b parte da 2 % e cresce fino a 5 %** man mano che
l'LTV supera la soglia. Il cap `1 - ltv_nobf` diventa vincolante sopra il 95 % di LTV.

## 4.3 Quanto collaterale ricevi

```
liquidatable_mv = min( D_mv × CF_effettivo , max_liquidatable_debt_mv_at_once )
CF_effettivo    = 1,0  se ltv > insolvency_risk_unhealthy_ltv (95 %)   [V]
                = 0,20 altrimenti

R_max           = D × (liquidatable_mv / D_mv)
R               = min(R_richiesto, R_max)

valore_seized   = R_mv × (1 + b)
W_lordo         = valore_seized / P_scope_USDY          (in USDY)
protocol_fee    = max( ceil( (W_lordo - W_lordo/(1+b)) × π ), 1 )    [V]
W               = W_lordo - protocol_fee
```

Con `π = 0` → `protocol_fee = 1 lamport`. Trascurabile ma **non zero**: il codice fa
`max(protocol_fee, 1)`.

Vincolo duro da controllare **prima** di firmare:
```
W_lordo (in cToken) <= withdraw_reserve.freely_redeemable_collateral_amount()
```
altrimenti ricevi cUSDY invece di USDY e la tx fa revert allo swap (vedi
[00-VERDETTO §4](00-VERDETTO.md)).

## 4.4 L'output dello swap

```
O = W × P_orca(W) × (1 - f_orca)
```
dove `P_orca(W)` è il prezzo **medio eseguito**, non spot: va preso da un quote reale sui
tick array, non da `sqrtPrice`. Scriviamo `P_orca(W) = P_orca_spot × (1 - s(W))`.

## 4.5 Profitto netto

```
Π = O − R − φ·R − c_base − c_prio

  = W · P_orca_spot · (1 − s(W)) · (1 − f_orca) − R · (1 + φ) − c_base − c_prio
```

Sostituendo `W ≈ R · (P_scope_USDC / P_scope_USDY) · (1 + b)`:

```
Π ≈ R · [ (1 + b) · ρ · (1 − s) · (1 − f_orca) − (1 + φ) ] − c_base − c_prio
```

dove **`ρ = P_orca_USDY→USDC / P_scope_USDY`** è il rapporto tra quanto il mercato paga
davvero lo USDY e quanto Kamino dice che vale. `ρ` è il vero fattore di rischio: se
Scope sovrastima USDY dell'1 %, ti mangia metà del bonus minimo.

### Numeri concreti [A]

`b = 0,02`, `ρ = 1,000`, `f_orca = 0,0016`, `φ = 0,00001`, e `s = 0,00015` (impatto prezzo misurato su 50.000 USDY con `npm run quote`, al netto della fee):

```
margine relativo = 1,02 · 1 · 0,99985 · 0,9984 − 1,00001 = 0,01812 → 1,81 %
```

| `R` ripagati | Lordo | Costi fissi (c_base+c_prio @ 350k CU, 20k µLmp ≈ 0,000012 SOL) | Netto |
|---|---|---|---|
| 500 USDC | 8,98 | ~0,004 USD | **≈ 8,97 USDC** |
| 2.000 USDC | 35,9 | ~0,004 USD | **≈ 35,9 USDC** |
| 10.000 USDC | 179,5 | ~0,004 USD | **≈ 179,5 USDC** |

Sotto `b = 0,02`, il break-even su costi fissi è ~0,25 USDC di debito: irrilevante.
**Il vero break-even non è la gas fee, è `ρ` e `s`.** Il margine si azzera quando

```
(1 + b)(1 − s)(1 − f_orca) ρ = 1 + φ
```

cioè, con b = 2 %, quando `ρ·(1−s)` scende sotto **0,98216** — un disallineamento
oracle/mercato dell'1,8 %.

## 4.6 Soglia minima di esecuzione

Definisco tre soglie, tutte da configurare:

```
Π_atteso        = come sopra, su quote Orca live
Π_worst         = ricalcolato con s = s_p95 e ρ = ρ_p05 (percentili storici)
costo_fallimento = c_base + c_prio

Esegui se e solo se:
  (1) Π_worst                                  >  MIN_PROFIT_USDC        (es. 2,0 USDC)
  (2) Π_atteso · (1 − p_fail) − p_fail · costo_fallimento > MIN_EV_USDC  (es. 1,0 USDC)
  (3) Π_atteso / R                             >  MIN_MARGIN_BPS         (es. 50 bps)
  (4) W_lordo                                  ≤  freely_redeemable_collateral
  (5) R                                        ≤  flash_reserve.total_available_liquidity
  (6) simulateTransaction                      →  err == null
```

La (3) evita di bruciare inventario e attenzione su liquidazioni enormi con margine
sottilissimo. La (2) è quella che conta quando c'è competizione: con `p_fail` alto
(race persa) l'EV crolla anche se `Π_atteso` è ottimo.

### Parametri on-chain da rileggere ad ogni ciclo (mai cachare)
`liquidation_max_debt_close_factor_pct`, `min/max_liquidation_bonus_bps`,
`protocol_liquidation_fee_pct`, `flash_loan_fee_sf`, `feeRate` del pool,
`total_available_liquidity_amount`. Un curator può cambiarli con
`update_reserve_config` / `update_lending_market` in qualsiasi momento.

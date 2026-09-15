# Verdetto sulla strategia proposta

> Stato della verifica: sorgenti `Kamino-Finance/klend` (branch `main`, clonato),
> IDL `@kamino-finance/klend-sdk@12.0.0`, sorgenti `orca-so/whirlpools`,
> stato on-chain letto via RPC mainnet allo **slot ~446.813.000 (13–14 set 2026)**.
>
> Legenda: **[V]** = verificato su codice sorgente o stato on-chain.
> **[A]** = assunzione / stima mia, da validare.

## Sintesi: il flusso funziona, ma 4 passaggi su 7 sono formulati male

| # | Passo proposto | Esito |
|---|---|---|
| 1 | Rilevare posizione liquidabile | ✅ corretto, ma serve *refresh* on-chain nella stessa tx |
| 2 | Flash loan USDC "dentro la stessa tx" | ✅ possibile — **ma non dal market Nysa**, vedi §2 |
| 3 | Ripagare il debito | ⚠️ non esiste un "repay" separato: è dentro la stessa ix di liquidazione |
| 4 | Ricevere collaterale USDY | ⚠️ **non garantito**: puoi ricevere cUSDY (cToken) invece di USDY |
| 5 | Swap USDY→USDC su Orca | ✅ corretto, pool verificato |
| 6 | Rimborso flash loan | ✅ corretto |
| 7 | Profitto residuo | ⚠️ il margine reale è **200–500 bps**, non "quello che avanza" |

---

## 1. Il market indicato è VUOTO — oggi non c'è nulla da liquidare [V]

Market `F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy` — nome on-chain **"Nysa First Trial"**,
owner `66pW72Fchnr34FGgXrxheGs3BbUsDSwJmGcK7m8Bz1Yv`.

| Misura | Valore letto on-chain |
|---|---|
| Obligation esistenti nel market | **0** (`getProgramAccounts`, dataSize 3344, memcmp offset 32) |
| `borrowedAmountSf` reserve USDC | **0** |
| `totalAvailableAmount` reserve USDC | **100000** = 0,1 USDC |
| `totalAvailableAmount` reserve USDY | **100000** = 0,1 USDY |
| Ultimo refresh reserve USDC | slot 445.316.393 (≈ 7 giorni fa) |

È un market di test con i soli *seed deposit* da 0,1 token creati da `init_reserve`.
**Conclusione**: il bot va scritto e testato qui, ma il flusso economico non può girare
finché il curator non apre depositi/prestiti reali. Il codice deve essere multi-market
dal giorno 1.

## 2. Il flash loan NON può venire dal market Nysa [V]

`flash_borrow_reserve_liquidity` preleva da `reserve.liquidity.supply_vault`: nel market
Nysa ci sono **0,1 USDC**. Massimo flash loan: 0,1 USDC.

Ma — verificato leggendo `handler_flash_borrow_reserve_liquidity.rs` — la ix richiede solo
`reserve.has_one = lending_market` della *coppia che passi tu*: **non c'è alcun vincolo che
leghi la reserve del flash loan al market dell'obligation liquidata**. Quindi:

- flash borrow USDC dal **Main Market** `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`,
  reserve USDC `D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59` → **23.059.624 USDC disponibili** [V]
- liquidazione sull'obligation del market Nysa
- flash repay sulla stessa reserve del Main Market

Fee flash loan Main Market USDC: `flash_loan_fee_sf = 11529215046068`, scala `2^60`
→ **1e-5 = 0,001 % = 0,1 bps**, addebitata *Exclusive* (sopra al capitale) [V].
Nel market Nysa `flash_loan_fee_sf = 0` per entrambe le reserve → flash loan **gratis**,
ma inutilizzabile per mancanza di liquidità [V].

> `flash_loan_fee_sf == u64::MAX` significa "flash loan disabilitati"; `0` significa "fee zero". [V]

## 3. "Ripagare il debito" non è un'istruzione separata [V]

Non esiste un flusso `repay → seize`. Esiste **una sola** istruzione:

`liquidate_obligation_and_redeem_reserve_collateral_v2`

che in un colpo solo: (a) preleva USDC dal tuo ATA verso il vault della repay reserve,
(b) trasferisce cToken dal collateral supply vault al tuo ATA cToken,
(c) *redime* i cToken in USDY verso il tuo ATA USDY, (d) trattiene la protocol liquidation fee.

Usa la **V2**, non la V1: la V1 ha `check_refresh_ixs!` che impone
`refresh_obligation_farms_for_reserve` nelle posizioni immediatamente precedenti/successive,
il che rende fragile l'incastro col flash loan. La V2 fa il refresh farm via CPI internamente
e accetta account farm opzionali (`None` qui: entrambe le reserve Nysa hanno
`farm_collateral = farm_debt = 11111111111111111111111111111111`) [V].

## 4. Puoi NON ricevere USDY [V] — questo è il bug logico più serio del piano

In `lending_operations::liquidate_obligation`:

```rust
let withdraw_collateral_amount = min(withdraw_amount, max_redeemable_collateral);
```

e in `post_liquidate_redeem`, se `withdraw_collateral_amount == 0` la ix **non redime nulla**
e tu resti con **cUSDY** (cToken, mint `C7dKsFYaM2DcVJSDjouPTfLc9292Lkd5ti9VQCdx2UDg`),
che su Orca non esiste e non è vendibile.

`max_redeemable_collateral` dipende dalla liquidità USDY *disponibile* nella withdraw reserve.
Oggi: 0,1 USDY. Se la reserve USDY è prosciugata (utilizzo alto), la liquidazione "riesce"
ma tu non hai nulla da swappare → **il flash repay fallisce → tutta la tx fa revert**.
Costo: solo base fee + priority fee, ma è uno stato da rilevare *prima*, in simulazione.

Mitigazione obbligatoria nel profit engine: `withdraw_amount_stimato <= freely_redeemable_collateral_amount`.

## 5. USDY non vale 1 USDC [V]

Prezzo Orca al momento della lettura: **1,1435 USDC/USDY**. USDY è un token a rendimento
accumulato (Ondo), il prezzo sale nel tempo. Kamino lo valuta via **Scope**
(feed `3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C`, chain `[3]`), non via il prezzo Orca.
Ogni disallineamento oracle-Scope ↔ prezzo-Orca entra **direttamente** nel P&L e può
azzerare un bonus del 2 %.

USDY mint `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6`: SPL Token **legacy** (non Token-2022),
6 decimali, **con freeze authority** `51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK` [V] →
rischio di congelamento ATA, da elencare tra i rischi.

## 5-bis. L'oracolo della reserve USDY punta a un indice segnaposto [V]

La scope chain della reserve USDY è `[3]`, sul feed `3NJYftD5…`.
Decodificando quell'account (layout `disc(8) + oracle_mappings(32) + [DatedPrice; 512]`,
56 byte per entry, `prezzo = value / 10^exp`):

```
indice 3  →  value = 1_000_000_000_000, exp = 18  →  0,000001 USD
indice 20 →  0,99987991      (USDC, chain [20, 230] → prodotto ≈ 0,99976)
```

Il prezzo reale di USDY (~1,1452) sta agli indici 79/97 e 441/442, **non al 3**.
Verificato su `utils/prices/scope.rs`: `get_base_price` indicizza direttamente l'array e
`price_to_fraction` fa `value / 10^exp`, quindi con questa config `refresh_reserve`
scriverebbe un prezzo USDY di **0,000001 USD**.

Coerente con il resto (reserve mai rinfrescate, seed da 0,1 token, nome "First Trial"):
**il market non è finito di configurare**. Va sistemato dal curator prima che qualunque
liquidazione abbia senso.

## 6. Il margine è 200–500 bps, punto [V]

Config reserve USDY Nysa (`rpTGWR3JDjjPfXLCg5Fx1GpSdUxPt1pxW7fwXGUT6js`):

| Parametro | Valore |
|---|---|
| `loan_to_value_pct` | 70 |
| `liquidation_threshold_pct` | 75 |
| `min_liquidation_bonus_bps` | **200** (2 %) |
| `max_liquidation_bonus_bps` | **500** (5 %) |
| `bad_debt_liquidation_bonus_bps` | 10 |
| `protocol_liquidation_fee_pct` | **0** |
| `borrow_factor_pct` | 100 |

Market: `liquidation_max_debt_close_factor_pct = 20`,
`max_liquidatable_debt_market_value_at_once = 500000` USD,
`min_full_liquidation_value_threshold = 2` USD,
`insolvency_risk_unhealthy_ltv_pct = 95`,
`permissioning_authority = 11111111111111111111111111111111` → **market NON permissionato,
liquidazione permissionless** [V].

Quindi il lordo massimo per liquidazione è `bonus × debito_ripagato`, con
`debito_ripagato ≤ 20 % × debito_totale`. Su un debito di 10.000 USDC: max 2.000 USDC
ripagati, bonus 2–5 % → **40–100 USDC lordi**. Da lì togli fee Orca, slippage, flash fee,
priority fee.

## 7. Il pool Orca c'è ed è sorprendentemente profondo nella direzione giusta [V]

Pool `AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD` (Whirlpool, `tickSpacing = 16`,
`feeRate = 1600` → **0,16 %**, `protocolFeeRate = 1300` → 13 % *della fee*, non aggiuntivo).

- `tokenMintA = USDY`, `tokenMintB = USDC` → vendere USDY è **A→B**, `a_to_b = true`
- Bilanci: **49.739 USDY / 2.857.245 USDC** → il lato che ti serve (USDC in uscita) è profondo
- `liquidity` in-range: `352.599.358.162.720`, `sqrtPrice = 19726079875541305854`, tick 1341
- Volume 24 h: ~11.000 USD → pool **illiquido come flusso**, ma non come profondità
- ALT del pool: `9iiRsm2M5jaFnDbgAjBbbasTwo6m3AV6N22k1ANt47Bm`

Quote reali eseguite sui tick array veri (`npm run quote`, slot 446.815.345) **[V]**:

| USDY venduti | USDC ottenuti | Prezzo medio | Scostamento dallo spot (fee 0,16 % inclusa) |
|---|---|---|---|
| 1.000 | 1.141,68 | 1,141682 | −0,160 % |
| 10.000 | 11.416,51 | 1,141651 | −0,163 % |
| 50.000 | 57.075,66 | 1,141513 | −0,175 % |

Quindi l'**impatto prezzo puro** (al netto della fee) va da ~0 % a **0,015 %** su 50.000 USDY.
Il pool regge comodamente size da decine di migliaia di dollari in questa direzione.
Da ricalcolare ad ogni quote: `L` vale solo dentro il tick range corrente.

Tick array (PDA `["tick_array", pool, start.toString()]`, span = 88×16 = 1408) [V]:
- start `0` → `4buLqbryTiZzUQLL449cnBi7DFfz9GkKcNy7bhpY6brh` (484 byte → **dynamic tick array**)
- start `-1408` → `5iGQLNDVu5V8HHvEr51iYiPF2GnF5Gs3GTLH5zXjUChW` (148 byte)
- start `-2816` → `J9DGsBtR7WyRihLXiqUc3hC8Zamt7sedKaeXufckN2pW` (**non inizializzato**)
- oracle PDA `["oracle", pool]` → `4PsbTRYTjM8ZcMFwcfPs7NnbMWJg7FwcMwEq7ety292P` (**non inizializzato**,
  normale: `adaptiveFeeEnabled = false`)

⚠️ I tick array sono in formato **dynamic** (dimensione variabile), non il legacy da 9988 byte.
Serve un SDK Orca recente per decodificarli; `SparseSwapTickSequenceBuilder` tollera gli array
non inizializzati.

## 8. Il terminator ufficiale NON usa flash loan [V]

`Kamino-Finance/terminator` liquida con **inventario proprio** e riequilibra dopo,
in transazioni separate, via **Jupiter** (`terminator/src/jupiter.rs`). Nessun riferimento a
flash loan in tutto il repo (l'unica occorrenza di "flash" è un commento in `math.rs`).
Non prenderlo come modello per la parte atomica: prendilo come modello per
scanner, lookup table, gestione ATA e `crank`.

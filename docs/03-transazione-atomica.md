# Step 3 — La transazione atomica

## 3.1 Sequenza istruzioni (v1 del bot, single-tx)

```
idx  programma   istruzione                                         note
───────────────────────────────────────────────────────────────────────────────────────
 0   ComputeBudget setComputeUnitLimit(CU_stimati * 1.15)
 1   ComputeBudget setComputeUnitPrice(micro_lamports)
 2   klend        refreshReserve(USDC_reserve_Nysa)   + scope_prices
 3   klend        refreshReserve(USDY_reserve_Nysa)   + scope_prices
 4   klend        refreshObligation(obligation)       + remaining[deposits..., borrows...]
 5   klend        flashBorrowReserveLiquidity(amount = repay_usdc)      ← MAIN MARKET
 6   klend        liquidateObligationAndRedeemReserveCollateralV2(
                      liquidity_amount = repay_usdc,
                      min_acceptable_received_liquidity_amount = usdy_min,
                      max_allowed_ltv_override_percent = 0)
 7   whirlpool    swapV2(amount = usdy_ricevuti, a_to_b = true,
                      amount_specified_is_input = true,
                      other_amount_threshold = usdc_min)
 8   klend        flashRepayReserveLiquidity(amount = repay_usdc,
                      borrow_instruction_index = 5)
```

### Perché è atomico

Solana esegue le istruzioni di una transazione in sequenza e **committa tutto o niente**.
Se lo swap rende meno USDC del dovuto, la ix 8 fallisce sul `transfer` da
`user_source_liquidity` per insufficienza fondi → l'intera transazione fa revert:
il flash loan non è mai avvenuto, la liquidazione non è mai avvenuta. Paghi solo
base fee + priority fee.

Oltre a questo, hai **tre** guardie esplicite che ti proteggono *prima* del revert generico:

| Guardia | Dove | Effetto |
|---|---|---|
| `min_acceptable_received_liquidity_amount` | ix 6 | `LiquidationRewardTooSmall` se il collaterale netto è sotto soglia |
| `other_amount_threshold` | ix 7 | Orca `AmountOutBelowMinimum` |
| `sqrt_price_limit` | ix 7 | blocca lo swap se il prezzo esce dal range |

### Vincoli che l'ordine deve rispettare (verificati sul codice)

- ix 2/3/4 devono stare **nello stesso slot** della ix 6 → stessa tx, sempre vero.
- ix 5 e ix 8 devono avere **liste account identiche** e `borrow_instruction_index = 5`.
  Se aggiungi/togli una ComputeBudget in testa, l'indice cambia: calcolalo
  programmaticamente, mai hardcoded.
- Un solo flash borrow e un solo flash repay per tx.
- Nessuna delle due può essere in CPI.
- ix 4 `refreshObligation` va **dopo** i refresh delle reserve, perché legge i prezzi
  già aggiornati.

## 3.2 Account, ATA, firme

Firma **una sola chiave**: il liquidator. È contemporaneamente
`user_transfer_authority` (flash), `liquidator` (klend) e `token_authority` (Orca).
Nessuna approvazione SPL (`approve`) è necessaria: tutti i trasferimenti in uscita usano
l'authority-signer diretta.

ATA necessari (owner = liquidator), da creare **una volta sola**, fuori dalla tx calda:

| ATA | Mint | Ruolo |
|---|---|---|
| ATA_USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | riceve il flash loan, paga il repay del debito, riceve l'output swap, paga il flash repay |
| ATA_USDY | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` | riceve il collaterale redento, input dello swap |
| ATA_cUSDY | `C7dKsFYaM2DcVJSDjouPTfLc9292Lkd5ti9VQCdx2UDg` | transito dei cToken dentro la ix 6 |

⚠️ `ATA_cUSDY` è obbligatorio anche se il saldo torna sempre a zero: la ix 6 lo usa come
`user_destination_collateral`. Dimenticarlo è l'errore più comune.

Non mettere `createAssociatedTokenAccountIdempotent` nella tx calda: aggiunge ~20k CU e
un account scrivibile in più, e il rent lo paghi comunque una volta sola.

## 3.3 Il flusso USDC dentro ATA_USDC (una sola ATA, quattro movimenti)

```
saldo iniziale            S
+ flash borrow            S + F
- repay debito            S + F - R          (R = repay_amount effettivo ≤ F)
+ output swap             S + F - R + O
- flash repay (capitale)  S     - R + O
- flash fee (Exclusive)   S     - R + O - φ
──────────────────────────────────────────
profitto = O - R - φ
```

Nota: il flash repay trasferisce `flash_loan_amount + referrer_fee` da
`user_source_liquidity` al supply vault, **più** un secondo trasferimento di
`reserve_origination_fee` verso il fee vault (solo se > 0). Con `referral_fee_bps = 0`
e nessun referrer, `referrer_fee = 0` [V].

Serve `S > 0`? No in teoria, ma tieni un buffer: gli arrotondamenti `to_ceil()` su
`repay_amount` possono farti mancare 1 lamport.

## 3.4 Address Lookup Table

La tx tocca ~45–50 account unici. Senza ALT si sta sopra il limite pratico di una
legacy transaction. Usa una **v0 transaction** con due ALT:

1. una ALT tua, creata una volta, con: reserve Nysa (USDC/USDY) e i loro vault, mint,
   cToken mint, market, market authority, scope feed, i tuoi ATA, la reserve USDC del
   Main Market e i suoi vault, i program id;
2. la ALT del pool Orca già esistente: `9iiRsm2M5jaFnDbgAjBbbasTwo6m3AV6N22k1ANt47Bm`.

`terminator/src/lookup_tables.rs` è un riferimento diretto per crearla e persisterla su file.

⚠️ Gli account **signer** e quelli **writable che devono restare writable** funzionano
comunque via ALT, ma la deattivazione/chiusura di una ALT rompe le tx in volo: non
riutilizzare ALT di terzi per account critici.

## 3.5 Compute budget [A], tranne dove indicato

Stima da tarare con `simulateTransaction` + `unitsConsumed` (il campo esiste nella
risposta RPC e va letto, non indovinato):

| ix | CU stimati |
|---|---|
| refreshReserve ×2 (Scope) | ~40k–70k |
| refreshObligation (2 reserve) | ~30k |
| flashBorrow | ~25k |
| liquidateV2 (no farms) | ~90k–140k |
| swapV2 (1–2 tick array attraversati) | **37.318 misurati** su 1.000 USDY (LiteSVM) |
| flashRepay | ~30k |
| **totale** | **~280k–400k** |

Sta sotto i 1,4 M CU per tx. Imposta il limite al valore misurato ×1,15: un limite
gonfiato aumenta linearmente il costo della priority fee.

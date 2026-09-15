# Step 7 — Rischi e salvaguardie

## 7.1 Rischi di protocollo / smart contract

| Rischio | Perché | Mitigazione |
|---|---|---|
| Il curator cambia i parametri | `update_reserve_config` può azzerare `max_liquidation_bonus_bps` o mettere `flash_loan_fee_sf = u64::MAX` (= flash loan disabilitati) tra la tua simulazione e l'invio | rileggi la config nello snapshot di ogni ciclo; guardie on-chain (`minAcceptableReceived`) rendono comunque la tx safe |
| `emergency_mode` / `price_triggered_liquidation_disabled` | il market può bloccare le liquidazioni da prezzo | controlla i flag prima di costruire |
| Ricevi cUSDY invece di USDY | `withdraw_collateral_amount = min(withdraw_amount, freely_redeemable)` | controllo esplicito pre-tx; la tx comunque fa revert sullo swap |
| `RepayTooSmallForFullLiquidation` | sotto `min_full_liquidation_value_threshold` ($2) **devi** ripagare tutto il debito | gestisci il caso "full liquidation forzata" nel sizing |
| Market permissionato | `permissioning_authority ≠ default` richiede la firma del permissioner come ultimo remaining account | oggi è default su Nysa [V], ma **controllalo a runtime**: può essere impostato |

## 7.2 Rischi di transazione

- **Mai** `skipPreflight: true` senza aver simulato tu. La simulazione è la preflight.
- `borrowInstructionIndex` hardcoded → `InvalidFlashRepay`. Calcolalo.
- Liste account di borrow/repay divergenti (anche solo l'ordine degli optional) →
  `InvalidFlashRepay`. Costruiscile da **una sola** funzione condivisa.
- CU limit troppo basso → `ComputeBudgetExceeded` a metà: perdi la fee. Misura, non stimare.
- ALT disattivata da terzi → tx non deserializzabile. Usa una ALT tua per gli account critici.

## 7.3 Gestione chiavi

- La chiave del liquidator firma flash loan, liquidazione e swap: **è una hot key**.
  Tienici sopra solo SOL per le fee e i rent ATA. Il profitto USDC va spazzato
  periodicamente su un cold wallet con una tx separata.
- Mai la keypair nel repo. `.env` fuori dal git, permessi `600`. In produzione:
  KMS/HSM o un signer separato su socket locale.
- Rate-limit sul signer: max N firme/minuto; un bug in loop non deve poter firmare 10.000 tx.
- Chiave dedicata solo a questo bot: nessun fondo, nessuna delega, nessun `approve` SPL.

## 7.4 RPC

- Un RPC compromesso può servirti stato falso per farti costruire una liquidazione
  perdente. Mitigazione: **le guardie on-chain**. Con `minAcceptableReceivedLiquidityAmount`
  e `other_amount_threshold` corretti, il peggio che un RPC ostile ottiene è farti pagare
  una fee per una tx che fa revert.
- Non fidarti mai del profitto stimato off-chain come unica difesa.
- Quorum: valuta la liquidabilità su due RPC prima di inviare, se l'importo è grande.

## 7.5 Slippage

Tre guardie indipendenti, tutte on-chain:

```
min_acceptable_received_liquidity_amount = W_atteso × (1 − tol_liq)     // es. tol 0,5 %
other_amount_threshold                   = O_atteso × (1 − tol_swap)    // es. tol 0,3 %
sqrt_price_limit                         = sqrt_price_corrente × (1 − tol_px)
```

Calibrale sul **worst case**, non sull'atteso. Se `tol` è troppo largo, un sandwich su un
pool da 11k$ di volume giornaliero ti prende tutto il bonus.

## 7.6 Oracle

- Kamino valuta USDY con **Scope**, tu vendi su **Orca**. Sono due prezzi diversi.
  Il rapporto `ρ` (vedi [04](04-profittabilita.md)) è il rischio principale, non la gas fee.
- `max_age_price_seconds = 180` su entrambe le reserve [V]: prezzi vecchi fino a 3 minuti
  sono accettati dal programma. In un movimento veloce, il prezzo Scope su cui calcoli il
  bonus può essere significativamente diverso dal prezzo Orca a cui vendi.
- Salvaguardia: rifiuta il plan se
  `|P_orca_spot / P_scope_USDY − 1| > MAX_ORACLE_DIVERGENCE` (es. 1 %).
- USDY è yield-bearing: il prezzo sale nel tempo. Un feed fermo è un feed che **sottostima**
  → il bonus calcolato è ottimista. Controlla la freschezza del feed Scope, non solo il valore.

## 7.7 Contabilità

- Non dedurre il profitto dalla simulazione: leggilo dai `pre/postTokenBalances` della tx
  confermata.
- Traccia separatamente: bonus lordo, fee Orca, flash fee, priority fee, base fee, e
  **il costo delle tx fallite** (che è puro costo senza ricavo).
- Il P&L vero di giornata = Σ(profitti confermati) − Σ(fee delle tx fallite). Un bot con
  80 % di fallimenti può essere in perdita pur avendo "liquidazioni profittevoli".

## 7.8 Rischi specifici di USDY

- **Freeze authority attiva** (`51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK`) [V]:
  Ondo può congelare un ATA. Se il tuo ATA USDY viene congelato, ogni liquidazione fa
  revert allo swap. Rileva il flag `state == Frozen` all'avvio e ad ogni fallimento.
- Token soggetto a restrizioni regolamentari a livello di emittente. Non è un rischio
  tecnico del bot, ma è un rischio di inventario: non tenere USDY a bilancio se non per
  i millisecondi della transazione — cosa che l'atomicità garantisce già.
- Liquidità secondaria concentrata su **un solo pool** con 11k$/giorno di volume. Se quel
  pool si prosciuga, la strategia non ha uscita.

## 7.9 Salvaguardie contro l'esecuzione non profittevole — checklist

```
[ ] Π_worst > MIN_PROFIT_USDC                      (off-chain)
[ ] Π_atteso / R > MIN_MARGIN_BPS                  (off-chain)
[ ] |ρ − 1| < MAX_ORACLE_DIVERGENCE                (off-chain)
[ ] snapshot_age_slots ≤ MAX_SNAPSHOT_AGE_SLOTS    (off-chain)
[ ] W_lordo ≤ freely_redeemable_collateral         (off-chain)
[ ] R ≤ flash_reserve.total_available_liquidity    (off-chain)
[ ] simulate.err == null                           (simulazione)
[ ] delta ATA_USDC simulato ≥ MIN_PROFIT_USDC      (simulazione)
[ ] minAcceptableReceivedLiquidityAmount > 0       (on-chain)
[ ] other_amount_threshold > 0                     (on-chain)
[ ] priority_fee ≤ 0,25 × Π_atteso                 (off-chain)
[ ] kill switch: DRY_RUN=true di default           (config)
```

`DRY_RUN=true` deve essere il default del file di config. Si toglie a mano, consapevolmente.

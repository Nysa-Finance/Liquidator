# Step 2 — Architettura del bot

```
                     ┌──────────────────────────────────────────────┐
                     │  L0  RPC / DATA LAYER                        │
                     │  • RPC primario (Helius/Triton, staked)      │
                     │  • RPC secondario (failover, quorum su slot) │
                     │  • WS accountSubscribe / programSubscribe    │
                     │  • (opz.) Geyser gRPC per <100 ms            │
                     └───────────────┬──────────────────────────────┘
                                     │ AccountUpdate{pubkey, slot, data}
          ┌──────────────────────────┼──────────────────────────────┐
          ▼                          ▼                              ▼
  ┌───────────────┐        ┌──────────────────┐         ┌────────────────────┐
  │ L1 STATE CACHE│        │ L1 PRICE FEED    │         │ L1 POOL CACHE      │
  │ reserves      │        │ Scope OraclePrices│        │ whirlpool + tick   │
  │ obligations   │        │ per chain index  │         │ arrays + fee/ALT   │
  │ lending mkts  │        └──────────────────┘         └────────────────────┘
  └───────┬───────┘
          │ snapshot coerente per slot
          ▼
  ┌──────────────────────┐   ┌──────────────────────┐   ┌────────────────────┐
  │ L2 SCANNER           │──▶│ L3 ELIGIBILITY       │──▶│ L4 PROFIT ENGINE   │
  │ enumerazione +       │   │ replica off-chain di │   │ quote Orca, fee,   │
  │ watchlist prioritaria│   │ calculate_liquidation│   │ soglie, sizing     │
  └──────────────────────┘   └──────────────────────┘   └─────────┬──────────┘
                                                                  │ LiquidationPlan
                                                                  ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │ L5 TX BUILDER                                                              │
  │  refresh×2 → refreshObligation → flashBorrow → liquidateV2 → swap → repay  │
  │  + ComputeBudget + ALT + blockhash                                         │
  └───────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────────────┐
  │ L6 SIMULATOR     │──▶│ L7 FEE ORACLE    │──▶│ L8 SENDER                    │
  │ replaceRecent    │   │ getRecentPrio    │   │ sendRawTransaction skipPre=1 │
  │ Blockhash, CU,   │   │ Fees p75/p90 +   │   │ retry su più RPC, maxRetries │
  │ accounts post    │   │ bandit adattivo  │   │ =0 + rebroadcast proprio     │
  └──────────────────┘   └──────────────────┘   └──────────┬───────────────────┘
                                                            ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │ L9 CONFIRMER  → L10 RECONCILER (P&L reale da balance delta) → L11 OBSERVAB.│
  └────────────────────────────────────────────────────────────────────────────┘
```

## L0 — Blockchain / RPC

- **Due** provider minimo. Il free `api.mainnet-beta.solana.com` non regge
  `getProgramAccounts` su klend (58 reserve nel solo Main Market) né i rate di polling.
- WebSocket `programSubscribe` su klend filtrato con
  `buildObligationFilters` (esportato dall'SDK) per ricevere le obligation del market
  in push invece che in polling.
- Ogni update porta con sé lo `slot`: **scarta gli update con slot inferiore** a quello
  già in cache per la stessa pubkey (gli RPC riordinano).
- Health check: se `getSlot()` del primario resta indietro di >8 slot rispetto al
  secondario per 3 letture consecutive, promuovi il secondario.

## L1 — State cache

Tre mappe append-only versionate per slot:
`Map<Address, {slot, data}>` per reserve, obligation, whirlpool/tick array.
Il resto del bot legge **solo** da qui, mai direttamente dall'RPC, così ogni
valutazione è fatta su uno snapshot con slot noto.

## L2 — Position scanner

Due modalità che coesistono:

1. **Bootstrap**: `getProgramAccounts(klend, filters=[dataSize 3344, memcmp(32, market)])`
   una volta all'avvio (e ogni N minuti come riconciliazione).
   Verificato: `OBLIGATION_SIZE = 3336` → account space **3344**.
2. **Hot loop**: `programSubscribe` + una **watchlist** delle obligation con
   `ltv > liquidation_threshold − margine` (es. −300 bps), rivalutate ad ogni tick di
   prezzo Scope anche senza update dell'obligation — perché **il prezzo cambia senza
   che l'account obligation cambi**. Questo è il punto che fa perdere le corse.

## L3 — Eligibility engine

Riproduce off-chain `get_liquidation_params`. Deve replicare **anche le due priority rule**,
altrimenti costruisci tx che falliscono:

- `LiquidationBorrowFactorPriority`: la repay reserve deve avere
  `borrow_factor_pct >= obligation.highest_borrow_factor_pct` [V]
- `LiquidationLowestLiquidationLtvPriority`: la withdraw reserve deve avere
  `liquidation_threshold_pct <= obligation.lowest_reserve_deposit_liquidation_ltv` [V]

Con due sole reserve (USDY coll / USDC debito) sono banalmente soddisfatte, ma il codice
va scritto generico: appena il curator aggiunge una terza reserve, saltano.

Controlla anche: `market.price_triggered_liquidation_disabled`, `market.emergency_mode`,
`reserve.status`, e le condizioni di autodeleverage/order (che danno bonus diversi).

## L4 — Profitability calculator

Vedi [04-profittabilita.md](04-profittabilita.md). Input: snapshot L1 + quote Orca.
Output: `LiquidationPlan | null` con `repayAmount`, `minUsdyOut`, `minUsdcOut`,
`expectedProfit`, `worstCaseProfit`, `cuEstimate`.

## L5 — Tx builder

Stateless e puro: `(plan, blockhash, priorityFee) → VersionedTransaction`.
Testabile senza rete. `borrowInstructionIndex` calcolato dall'array, mai costante.

## L6 — Simulazione

`simulateTransaction` con `replaceRecentBlockhash: true`, `sigVerify: false`,
`accounts: { encoding: 'base64', addresses: [ATA_USDC] }` per leggere il saldo
post-esecuzione e **verificare il profitto reale**, non solo che non ci sia errore.
Leggi `unitsConsumed` e riscrivi il CU limit.

## L7 — Priority fee

`getRecentPrioritizationFees(lockedWritableAccounts)` sugli account scrivibili della tua tx
(obligation, reserve, vault, pool). Parti dal p75, sali al p90/p99 dopo un fallimento per
race, scendi dopo N successi consecutivi. Cap assoluto: `maxPrioritySol` e
`maxPriorityAsFractionOfProfit` (es. 25 % del `Π_atteso`).

## L8–L9 — Invio e conferma

`sendRawTransaction` con `skipPreflight: true` (la preflight aggiunge ~200 ms e l'hai già
simulata), `maxRetries: 0`, e rebroadcast tuo ogni ~400 ms fino a scadenza blockhash su
**tutti** gli RPC configurati. Conferma via `getSignatureStatuses` in polling + WS
`signatureSubscribe` come backup.

## L10 — Riconciliazione

Il P&L dichiarato dalla simulazione non è il P&L reale. Dopo la conferma leggi
`meta.preTokenBalances/postTokenBalances` dalla tx e registra il delta effettivo di USDC.
Se diverge dalla stima oltre una soglia, alza `MIN_MARGIN_BPS`.

## L11 — Osservabilità

Log strutturati JSON (`pino`), un evento per fase con `slot`, `obligation`, `signature`.
Metriche Prometheus minime: `scan_latency_ms`, `candidates_total`,
`plans_rejected{reason}`, `tx_sent`, `tx_landed`, `tx_failed{code}`, `profit_usdc_total`,
`priority_fee_lamports`. Alert su `tx_failed` consecutivi > 5 e su `landed_rate < 30 %`.

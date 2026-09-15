# Step 5 — Rust o TypeScript?

## Raccomandazione: **TypeScript per la v1, Rust per l'hot path dopo**

Non è una risposta di comodo: dipende da cosa è il collo di bottiglia, e qui **non è la
latenza**.

### Perché TypeScript adesso

1. **`@kamino-finance/klend-sdk@12` fa il lavoro difficile**: decoder di `Reserve`/
   `Obligation`/`LendingMarket`, `KaminoObligation.loanToValue()` /
   `liquidationLtv()` / `noBfLoanToValue()` che replicano *esattamente* la matematica
   del programma, i builder codegen di tutte le istruzioni. Riscrivere la matematica
   dei `Fraction` scalati a 2^60 in Rust senza dipendere dal crate `kamino_lending`
   significa reimplementare — e sbagliare — `calculate_liquidation`.
2. **Il market bersaglio ha 0 obligation e 0 volume.** La corsa MEV non esiste. Il
   vantaggio di 50 ms del Rust vale zero finché non ci sono posizioni.
3. **Orca**: `@orca-so/whirlpools-core` è WASM (stessa implementazione Rust del quote)
   e `@orca-so/whirlpools-client@5` è il codegen su `@solana/kit@2`, la stessa major
   che usa klend-sdk. La coppia compila insieme; vedi §"Trappola di compatibilità".
4. Iterazione: cambiare una soglia e ripartire in 2 secondi con `tsx`, contro 90 s di
   `cargo build` con le dipendenze Anchor.

### Quando passare a Rust

- Quando il market ha posizioni vere **e** compaiono altri liquidatori.
- Quando serve Geyser gRPC con decodifica zero-copy: con `kamino_lending` come crate
  (`git = "https://github.com/Kamino-Finance/klend"`) leggi `Reserve` con
  `bytemuck` senza allocare, e chiami le funzioni **vere** del programma
  (`liquidation_operations::calculate_liquidation`) invece di replicarle. È il vero
  vantaggio del Rust qui: **eliminare il rischio di divergenza dell'implementazione**,
  non i millisecondi.
- Il riferimento è `Kamino-Finance/terminator`: struttura `client.rs` / `liquidator.rs` /
  `instructions.rs` / `lookup_tables.rs`, comando `crank`. Ricorda che **non usa flash
  loan** — la parte atomica va scritta da zero.

### Compromesso consigliato

| Componente | Linguaggio | Motivo |
|---|---|---|
| Scanner + watchlist + oracle listener | Rust (fase 2) | zero-copy, gRPC, throughput |
| Eligibility + profit | Rust (fase 2) | riuso diretto del crate `kamino_lending` |
| Tx builder, simulazione, invio | TypeScript | SDK maturi, iterazione rapida |
| Ops / monitoraggio | TypeScript | sufficiente |

Non serve un programma on-chain proprio: **anzi, è vietato**. `is_flash_forbidden_cpi_call`
rifiuta flash borrow/repay chiamati via CPI, quindi non puoi incapsulare la strategia in un
tuo programma. Tutto deve stare a livello di transazione.

## Trappola di compatibilità (verificata)

`@kamino-finance/klend-sdk@12` richiede `@solana/kit@^2.3.0`.
`@orca-so/whirlpools@8` e `@orca-so/whirlpools-client@6+` richiedono `@solana/kit@^5`.
**Sono incompatibili nello stesso albero npm.**

Soluzione adottata: `@orca-so/whirlpools-client@^5.0.0` (ultima versione su kit ^2.1.0) +
`@orca-so/whirlpools-core` (WASM, nessuna dipendenza da kit). Il pacchetto high-level
`@orca-so/whirlpools` non si usa: i facade per il quote si costruiscono a mano in
`src/build/orca.ts`.

Se in futuro klend-sdk passa a kit 5, si allineano entrambi.

## Struttura del progetto

```
liq/
├── README.md                 punto d'ingresso
├── package.json              dipendenze e comandi (npm test, npm run test:live, …)
├── tsconfig.json             regole del compilatore TypeScript
├── .env.example              modello di configurazione da copiare in .env
│
├── docs/                     analisi e progetto (10 documenti)
│
├── scripts/                  strumenti da riga di comando, tutti in sola lettura
│   ├── inspect-market.mjs    stampa lo stato reale di un market on-chain
│   ├── quote-orca.ts         quote USDY→USDC reale, per tarare lo slippage
│   └── dump-fixtures.mjs     scarica programmi e account per il mondo locale
│
├── src/                      il bot
│   ├── config.ts             costanti verificate on-chain + lettura del .env
│   ├── logger.ts             log strutturati
│   ├── rpc.ts                connessione ai nodi, failover, caricamento chiave
│   ├── scanner.ts            prefiltro di salute su tutte le posizioni (dataSlice)
│   ├── eligibility.ts        "è liquidabile?" — replica off-chain delle regole
│   ├── profit.ts             "conviene?" — equazione di profitto e soglie
│   ├── execute.ts            simulazione, priority fee, invio, conferma, lock
│   ├── index.ts              il ciclo principale che orchestra tutto
│   └── build/                costruzione delle istruzioni
│       ├── klend.ts          refresh, coppia flash loan, liquidazione V2
│       ├── orca.ts           quote + swapV2 + tick array
│       ├── computeBudget.ts  le due istruzioni di budget, scritte a mano
│       └── tx.ts             assembla le 9 istruzioni nella transazione atomica
│
├── tests/
│   ├── world.ts              carica il fork locale in LiteSVM + helper
│   ├── readonly-rpc.ts       client RPC che rifiuta ogni scrittura
│   ├── refresh.test.ts       prezzi Scope riscritti e consumati da klend
│   ├── flashloan.test.ts     introspezione del prestito lampo (2 test negativi)
│   ├── swap.test.ts          swap Orca eseguito davvero, quote vs esecuzione
│   └── live.readonly.test.ts mainnet vera, market attivo, sola lettura
│
└── fixtures/                 generata da `npm run fixtures`, fuori da git
```

## Piano di implementazione

**Fase 0 — ricognizione (fatta)**
`npm run inspect` → conferma che market, reserve, bonus, fee e liquidità siano ancora
quelli hardcoded in `src/config.ts`. Da rieseguire prima di ogni deploy.

**Fase 1 — dry run (dove siamo)**
`DRY_RUN=true`, loop attivo, nessun invio. Il bot deve loggare `scan` ogni ciclo.
Con 0 obligation non stamperà mai un piano: è il comportamento atteso.

**Fase 2 — validazione su una posizione reale**
Serve una posizione liquidabile. Due strade:
- il curator apre depositi/prestiti e si costruisce una posizione di test che si porta
  volutamente sopra il 75 % di LTV;
- oppure si punta il bot su un market Kamino attivo (Main Market) cambiando
  `TARGET_MARKET` e la coppia di reserve — il codice è già parametrico.

In questa fase si valida che `simulate()` restituisca `err == null` e un delta USDC
positivo. **Non si passa alla fase 3 finché non si è visto un delta positivo in simulazione.**

**Fase 3 — primo invio reale**
`DRY_RUN=false`, `MIN_PROFIT_USDC` alto (es. 20), `MAX_PRIORITY_LAMPORTS` basso.
Una sola liquidazione, poi si riconcilia il P&L con `pre/postTokenBalances`.

**Fase 4 — indurimento**
ALT propria, WebSocket sul feed Scope, lock esterno se più istanze, metriche Prometheus,
alert. Solo allora eventualmente Rust per scanner ed eligibility.

## Cosa NON è implementato (onestà sullo stato)

- Il listener WebSocket su Scope: il loop è a polling `SCAN_INTERVAL_MS`.
- La creazione della ALT propria: la transazione al momento non usa lookup table e con
  ~45 account potrebbe superare i limiti di dimensione. **Va aggiunta prima della fase 3.**
- La creazione idempotente degli ATA (vanno creati a mano una volta).
- Il prezzo SOL/USDC nel cap della priority fee è cablato a 150: va preso da un feed.
- La riconciliazione post-conferma da `pre/postTokenBalances`.
- Nessun test: non c'è una posizione liquidabile contro cui testare. Il typecheck passa,
  il percorso di lettura on-chain (`scripts/inspect-market.mjs`) è verificato contro
  mainnet; il percorso di costruzione/invio **non è mai stato eseguito**.

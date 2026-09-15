# Step 8 — Testare in sicurezza

Sì, e non serve rischiare un dollaro. Cinque livelli, dal più sicuro al più esposto.
I primi due sono già implementati in questo repo.

| # | Ambiente | Rischio | Cosa valida | Stato |
|---|---|---|---|---|
| 0 | Script di sola lettura | nessuno | config on-chain, quote Orca | ✅ `npm run inspect`, `npm run quote` |
| 0b | **Test live in SOLA LETTURA** | nessuno | scanner e config contro market attivi veri | ✅ `npm run test:live` |
| 1 | **Fork locale mainnet (LiteSVM)** | nessuno | programmi reali, stato reale, istruzioni, CU | ✅ `npm test` |
| 2 | `solana-test-validator --clone` | nessuno | tutto il livello 1 + il percorso RPC del bot | da fare |
| 3 | Devnet | nessuno (SOL finto) | flussi lunghi, market proprio | opzionale |
| 4 | Mainnet in `DRY_RUN` | nessuno | `simulateTransaction` su stato vero | ✅ default del bot |
| 5 | Mainnet reale, size minima | reale | tutto | ultimo passo |

---

## Livello 1 — Fork locale con LiteSVM (implementato)

È l'ambiente giusto per il 90 % del lavoro. LiteSVM è la macchina virtuale Solana
senza validator: niente rete, niente slot, niente consenso — solo il runtime che
esegue i **programmi veri** presi da mainnet sullo **stato vero** preso da mainnet.

```bash
npm run fixtures   # scarica programmi e account da mainnet in fixtures/
npm test
```

### Cosa viene scaricato

`scripts/dump-fixtures.mjs` estrae:

- i `.so` di **klend**, **kfarms** e **whirlpool** dai rispettivi account `programdata`
  (header `UpgradeableLoaderState` di 45 byte, poi la lunghezza reale dell'ELF calcolata
  dalle section header — troncare "all'ultimo byte non nullo" produce un ELF corrotto che
  LiteSVM rifiuta con `Offset or value is out of bounds`);
- market, reserve, vault, mint, cToken mint, feed Scope — **derivati dalle reserve**,
  non cablati, così funziona anche su un altro market;
- il pool Orca con i suoi vault e 7 tick array attorno al prezzo corrente.

27 account + 3 programmi, ~4,8 MB, 17 chiamate RPC. Le fixture non vanno in git.

### La leva che rende tutto testabile: il feed Scope

Verificato su `utils/prices/scope.rs`: klend **non fa CPI a Scope**. Legge l'account
`OraclePrices` direttamente, e l'unico controllo è che l'indirizzo coincida con
`reserve.config.tokenInfo.scopeConfiguration.priceFeed`.

Quindi, in locale, **riscrivere quei byte significa muovere i prezzi**. Layout:

```
OraclePrices = discriminante(8) + oracle_mappings: Pubkey(32) + prices: [DatedPrice; 512]
DatedPrice   = value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 | [u8;24]
offset(i)    = 40 + i*56        prezzo = value / 10^exp
```

`tests/world.ts` espone `setScopePrice(world, feed, index, price)`, che scrive anche
slot e timestamp correnti così `max_age_price_seconds` (180 s) è soddisfatto.
**È così che si rende liquidabile una posizione senza aspettare il mercato**: si abbassa
il prezzo del collaterale finché l'LTV supera la soglia.

### Cosa è già coperto dai test

```
✔ il mondo locale carica programmi e stato di mainnet
✔ il feed Scope del market quota USDY a ~1e-6
✔ refreshReserve applica i prezzi Scope che scriviamo noi
✔ flash borrow + flash repay: la coppia passa i controlli di introspezione
✔ borrow_instruction_index sbagliato ⇒ la transazione fa revert
✔ senza flash repay il borrow fa revert
✔ swapV2 USDY→USDC: esecuzione reale e quote coerente
```

Risultati misurati, non stimati:

- **fee flash loan**: su 1.000 USDC presi a prestito dal Main Market il costo osservato è
  esattamente **10.000 unità base = 0,01 USDC**, cioè 1e-5. Conferma empirica del valore
  `flash_loan_fee_sf = 11529215046068` letto dalla reserve.
- **swap Orca**: 1.000 USDY → **1.141,68236 USDC**, contro un quote off-chain di
  1.141,68236 → scarto **0,000 bps**. Il motore di quote e l'esecuzione coincidono.
- **CU dello swap**: **37.318**, molto sotto la mia stima iniziale di 60–110k.

I due test negativi sul flash loan valgono quanto quello positivo: dimostrano che
`borrowInstructionIndex` sbagliato di **uno** fa fallire tutto. È l'errore più facile da
introdurre rifattorizzando l'ordine delle istruzioni.

### Il pezzo che manca: creare una posizione liquidabile

I test coprono i due estremi della transazione (flash loan, swap) ma non ancora la
liquidazione, perché serve un'obligation con debito. Nel mondo locale si costruisce così:

1. forgiare i token account del "vittima" con USDY (`forgeTokenAccount`);
2. `initUserMetadata` + `initObligation` + `depositReserveLiquidityAndObligationCollateralV2`
   (USDY) + `borrowObligationLiquidityV2` (USDC) — tutti builder già presenti nell'SDK;
3. la reserve USDC del market Nysa ha solo 0,1 USDC: o si alza la liquidità forgiando il
   supply vault **e** riscrivendo `liquidity.total_available_amount` nella reserve, oppure
   si usa un altro market nelle fixture;
4. `setScopePrice(feed, USDY_index, prezzo_crollato)` finché LTV > 75 %;
5. eseguire la transazione del bot (`buildLiquidationMessage`) e verificare il delta USDC.

Il punto 3 è l'unico fastidioso: modificare un campo di una struct `zero_copy` richiede
l'offset esatto. Alternativa più pulita: puntare le fixture a un market Kamino attivo
(`MARKET=… npm run fixtures`), dove la liquidità c'è già.

---

## Livello 0b — Test live in sola lettura

```bash
npm run test:live                                    # Main Market di Kamino
RPC=https://... LIVE_MARKET=<pubkey> npm run test:live
```

Girano contro **mainnet vera**, su un market **attivo** (di default il Main Market di
Kamino, `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`), perché il market bersaglio del
progetto è ancora vuoto. Nessuna chiave, nessuna firma, nessun invio.

### La sola lettura è un cancello, non una promessa

`tests/readonly-rpc.ts` costruisce il client RPC su un transport che **ispeziona il metodo
JSON-RPC prima di spedirlo** e lancia un'eccezione se non è nella whitelist di sole letture.
Anche un refactor sbadato che chiamasse `sendTransaction` non riuscirebbe a farlo partire —
e c'è un test che lo verifica.

### Il prefiltro di salute: 106.000 posizioni in 3 secondi

`src/scanner.ts` risolve il problema di scala. Il Main Market ha **106.217 obligation**:
scaricarle tutte sarebbero ~355 MB. Ma `getProgramAccounts` accetta un `dataSlice`, cioè
permette di farsi restituire **solo una finestra di byte** per account. Bastano 64 byte:

```
offset 2208  borrow_factor_adjusted_debt_value_sf   (u128)
offset 2224  borrowed_assets_market_value_sf        (u128)
offset 2240  allowed_borrow_value_sf                (u128)
offset 2256  unhealthy_borrow_value_sf              (u128)
```

Una posizione è sopra soglia quando `debt_value_sf >= unhealthy_borrow_value_sf`: il
denominatore dell'LTV è lo stesso per entrambi, quindi il loro rapporto **è** il rapporto
fra LTV e soglia. Non serve nemmeno leggere il valore depositato.

Risultato: **7 MB invece di 355, una sola chiamata, ~3 secondi sull'RPC pubblico gratuito.**

Gli offset non sono assunti: un test li **riverifica** confrontando i byte grezzi con il
decoder ufficiale dell'SDK su obligation reali. Se Kamino cambia la struct, il test
fallisce invece di lasciar passare numeri sbagliati.

### Cosa hanno già rivelato

```
57.360 obligation con debito   (in 2,9 s, una chiamata)
sopra soglia: 10.533           a rischio (95-100 %): 1.041
```

Ma i primi della classifica hanno **debito di 0,00 $ e zero prestiti attivi**: sono
posizioni chiuse o polvere, i cui valori aggregati sono rimasti **congelati all'ultimo
`refresh_obligation`**. Il prefiltro legge lo stato *salvato*, non i prezzi di adesso.

Con il filtro `minDebtUsd: 100` il quadro cambia e diventa utile:

```
con debito >= 100 $: 12.456    di cui sopra soglia: 1.300
CZxi8PNEx3yjFA5BVttwNtegnLaCmh3yoLUic7RNFjzQ  LTV 90,84 %  soglia 90,00 %  1 deposito, 1 prestito
AoMuGciBwsFdiKxnhyQ84nSjVSea6XteqCwZzmKm5gK6  LTV 90,75 %  soglia 90,00 %  1 deposito, 1 prestito
```

**Lezione da portarsi dietro**: la lista del prefiltro è di *candidati*, non di certezze.
Serve sempre il filtro sul debito minimo, poi il refresh on-chain dentro la transazione,
poi la simulazione.

### I sei test live

| Test | Cosa verifica |
|---|---|
| client in sola lettura | `sendTransaction` viene bloccato dal transport |
| offset del prefiltro | i byte grezzi coincidono col decoder ufficiale, su posizioni reali |
| prefiltro di salute | scansione completa del market, distribuzione, ordinamento |
| candidati decodificati | il rapporto del prefiltro coincide con LTV/soglia dal decode |
| costanti di `config.ts` | close factor, bonus, vault, fee flash loan **ancora uguali on-chain** |
| quote Orca + divergenza | quote live e la guardia anti-divergenza oracolo scatta davvero |

Il quinto è quello che vorrai in CI: se il curator cambia un parametro del market, o se
i flash loan vengono disabilitati sulla reserve sorgente, te ne accorgi subito invece che
con una transazione fallita.

---

## Livello 2 — `solana-test-validator --clone`

LiteSVM non espone un RPC: valida le istruzioni, **non** il codice del bot che parla con
la rete (`simulateTransaction`, `getRecentPrioritizationFees`, `sendTransaction`,
`getSignatureStatuses`, scadenza del blockhash, rebroadcast). Per quello serve un validator
locale con lo stato clonato:

```bash
# richiede l'Agave/Solana CLI, non installato su questa macchina
solana-test-validator --reset \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD \
  --clone-upgradeable-program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr \
  --clone-upgradeable-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc \
  $(for f in fixtures/accounts/*.json; do echo -n "--account $(basename $f .json) $f "; done)
```

Gli stessi file JSON prodotti da `npm run fixtures` sono già nel formato che
`--account` si aspetta. Poi si punta il bot con `RPC_PRIMARY=http://127.0.0.1:8899`
e si lascia `DRY_RUN=false`: le transazioni sono reali ma su una catena locale.

Esiste anche **surfpool** (binario Rust, non su npm) che fa fork on-demand di mainnet
senza dover enumerare gli account: più comodo, una dipendenza in più.

---

## Livello 3 — Devnet

Verificato: klend, kfarms e whirlpool sono deployati **anche su devnet**, e su devnet
esistono **159 lending market** sotto il program id di produzione. Il programma
`SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh` (staging) è deployato su entrambe le reti
ma **non ha market su devnet**.

Limite serio: su devnet **non esiste il pool Orca USDY/USDC**, quindi la gamba di uscita
va simulata o sostituita. Utile per provare i flussi lunghi (creare market e reserve
proprie, posizioni, tempi), poco utile per la strategia completa. Il fork locale è
strettamente migliore.

> Nota sul programma staging: `max_allowed_ltv_override_percent` funziona **solo** lì e
> **solo** se `liquidator == obligation.owner` — in mainnet è ignorato con un warning.
> Su staging permetterebbe di auto-liquidarsi senza essere davvero sott'acqua, ma senza
> market su devnet la strada non è percorribile oggi.

---

## Livello 4 — Mainnet in sola simulazione

È il default del bot: `DRY_RUN=true`. Il ciclo gira su stato mainnet reale, costruisce e
**firma** la transazione, la passa a `simulateTransaction` e la butta via. Non viene mai
inviata, quindi non costa nulla e non può perdere nulla.

Serve per l'ultima validazione: stato vero, oracoli veri, competizione vera. Ma senza
posizioni liquidabili nel market Nysa non produrrà mai un piano — vedi
[00-VERDETTO.md](00-VERDETTO.md).

---

## Livello 5 — Mainnet reale

Solo dopo aver visto un delta USDC positivo in simulazione. Impostazioni iniziali:

```
DRY_RUN=false
MIN_PROFIT_USDC=20          # alto: solo occasioni grandi
MAX_PRIORITY_LAMPORTS=50000 # basso: se perdi la gara, pazienza
```

Una liquidazione, poi si riconcilia il P&L con `pre/postTokenBalances` della transazione
confermata e si confronta con la stima. Solo se coincidono si abbassano le soglie.

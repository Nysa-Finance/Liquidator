# Bot di liquidazione Kamino — USDY collaterale / USDC debito

Liquidazione atomica su **Kamino Lend** con **flash loan USDC** e uscita del collaterale
**USDY** su **Orca Whirlpool**, tutto in una sola transazione.

Market bersaglio: [`F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy`](https://kamino.com/curators/markets/F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy)
— nome on-chain **"Nysa First Trial"**.

---

## ⚠️ Leggi prima questo

Il market bersaglio, allo slot ~446.815.000 (13–14 set 2026), è **vuoto**:
**0 obligation**, **0 debito**, **0,1 USDC** e **0,1 USDY** di liquidità nelle reserve.
Non c'è nulla da liquidare oggi e il flash loan non può partire da lì.

Il bot è scritto per funzionare quando il curator aprirà il market, e il flash loan
viene preso dal **Main Market** (~23 M USDC disponibili). Tutti i dettagli, con i punti
del piano originale che non stavano in piedi, sono in **[docs/00-VERDETTO.md](docs/00-VERDETTO.md)**.

---

## Documentazione

| File | Contenuto |
|---|---|
| [09-come-funziona.md](docs/09-come-funziona.md) | **Parti da qui se non conosci il settore**: spiegazione senza gergo, dall'inizio |
| [00-VERDETTO.md](docs/00-VERDETTO.md) | Cosa funziona e cosa no della strategia proposta, con i dati on-chain |
| [01-protocolli.md](docs/01-protocolli.md) | Programmi, istruzioni, account, PDA, vincoli di introspezione |
| [02-architettura.md](docs/02-architettura.md) | Architettura a livelli del bot |
| [03-transazione-atomica.md](docs/03-transazione-atomica.md) | Sequenza esatta delle istruzioni e perché è atomica |
| [04-profittabilita.md](docs/04-profittabilita.md) | Equazione di profitto completa e soglie di esecuzione |
| [05-implementazione.md](docs/05-implementazione.md) | Rust vs TypeScript, struttura, piano di lavoro, cosa manca |
| [06-affidabilita.md](docs/06-affidabilita.md) | Latenza, dati stantii, blockhash, priority fee, doppia esecuzione |
| [07-sicurezza.md](docs/07-sicurezza.md) | Rischi e salvaguardie, checklist anti-perdita |
| [10-produzione.md](docs/10-produzione.md) | Come andare in produzione: prerequisiti, sequenza di accensione, gestione |
| [08-testing.md](docs/08-testing.md) | Come testare in sicurezza: fork locale, validator clonato, devnet, dry run |

Ogni affermazione nei documenti è marcata **[V]** (verificata su sorgente o stato on-chain)
o **[A]** (assunzione/stima).

---

## Avvio rapido

```bash
npm install
cp .env.example .env    # poi compila RPC_PRIMARY e KEYPAIR_PATH
```

Verifica che i parametri on-chain siano ancora quelli cablati in `src/config.ts`
(sola lettura, nessuna chiave richiesta):

```bash
npm run inspect
```

Quote reale USDY → USDC sul pool di uscita, per tarare lo slippage:

```bash
npm run quote 1000 10000 50000
```

Avvia in dry run (default: **non invia nulla**):

```bash
npm start
```

Verifica di prontezza per la produzione (sola lettura, nessuna chiave necessaria):

```bash
npm run preflight
```

Test in **sola lettura** contro mainnet e un market attivo vero (nessuna chiave, nessun invio):

```bash
npm run test:live
```

Test contro programmi e stato reali di mainnet, eseguiti **in locale**, senza rete:

```bash
npm run fixtures   # scarica programmi e account da mainnet in fixtures/
npm test
```

Typecheck:

```bash
npm run typecheck
```

---

## La transazione

```
0  ComputeBudget  setComputeUnitLimit
1  ComputeBudget  setComputeUnitPrice
2  klend          refreshReserve(USDC)              + Scope
3  klend          refreshReserve(USDY)              + Scope
4  klend          refreshObligation                 + reserve in remaining accounts
5  klend          flashBorrowReserveLiquidity       ← Main Market, ~23 M USDC
6  klend          liquidateObligationAndRedeemReserveCollateralV2
7  whirlpool      swapV2  USDY → USDC  (aToB = true)
8  klend          flashRepayReserveLiquidity        borrowInstructionIndex = 5
```

Se lo swap rende meno del dovuto, la ix 8 fallisce e **l'intera transazione fa revert**:
il flash loan non è mai avvenuto. Costo di un tentativo fallito: base fee + priority fee.

---

## Numeri chiave verificati

| | |
|---|---|
| Liquidation bonus USDY | **200–500 bps** |
| Close factor | **20 %** (100 % sopra 95 % di LTV) |
| Protocol liquidation fee | **0 %** (minimo 1 lamport) |
| Flash loan fee (Main Market USDC) | **0,001 %** (`flash_loan_fee_sf = 11529215046068`, scala 2^60) |
| Fee pool Orca USDY/USDC | **0,16 %** |
| Impatto prezzo misurato, 50.000 USDY (fee esclusa) | **0,015 %** |
| Margine netto atteso a bonus minimo | **≈ 181 bps** |
| Market permissionato? | **No** — liquidazione permissionless |

---

## Stato

13 test verdi (vedi [docs/08-testing.md](docs/08-testing.md)).

**In sola lettura contro mainnet** (`npm run test:live`): lo scanner legge tutte le
**106.217 posizioni** del Main Market in **una chiamata da ~3 secondi** grazie al
`dataSlice` (7 MB invece di 355), gli offset dei campi sono riverificati contro il decoder
ufficiale, e le costanti di `src/config.ts` sono confrontate con lo stato on-chain.

**In locale con LiteSVM** (`npm test`), sui programmi veri:

- `flashBorrow` + `flashRepay` passano l'introspezione — e falliscono, come devono, con
  `borrowInstructionIndex` sbagliato di uno;
- `refreshReserve` consuma i prezzi Scope riscritti nel mondo locale;
- `swapV2` USDY→USDC eseguito davvero: **1.000 USDY → 1.141,68236 USDC**, identico al
  quote off-chain (**0,000 bps** di scarto), **37.318 CU**.

Non ancora testata la **liquidazione** vera e propria: serve un'obligation con debito, e
nel market bersaglio non ce n'è nessuna. La ricetta per costruirne una nel mondo locale è
in [docs/08-testing.md](docs/08-testing.md) § "Il pezzo che manca".

`DRY_RUN=true` è il default. Non toglierlo prima di aver visto un profitto positivo in
simulazione.

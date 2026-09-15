# Andare in produzione sul market Nysa

> Comando di riferimento, da eseguire prima di ogni accensione:
> ```bash
> npm run preflight
> ```
> È in sola lettura (il client rifiuta a monte qualsiasi scrittura) e dice
> esattamente quali condizioni mancano. Oggi risponde **NON PRONTO, 4 blocchi**.

---

## A. Le tre cose che NON dipendono da te

Nessuna quantità di codice le risolve: deve muoversi il curator del market
(`66pW72Fchnr34FGgXrxheGs3BbUsDSwJmGcK7m8Bz1Yv`).

### A1. L'oracolo di USDY punta a un indice segnaposto — **il più grave**

La scope chain della reserve USDY è `[3]`, e l'indice 3 del feed vale **0,000001 USD**.
Il prezzo vero di USDY (~1,145) sta agli indici 79/97 dello stesso feed.

Finché resta così, `refresh_reserve` scrive un prezzo USDY praticamente nullo: la garanzia
di chiunque vale zero, **ogni** posizione con debito risulta insolvente, e il bonus di
liquidazione calcolato è privo di senso. Il bot rifiuterebbe comunque il piano grazie alla
guardia di divergenza oracolo (ρ ≈ 1,1 milioni) — ed è giusto così, ma significa che non
lavorerebbe mai.

**Come verificare che sia risolto**: `npm run preflight` → riga *"prezzo USDY dall'oracolo
credibile"* verde, con un valore intorno a 1,14.

### A2. La reserve USDY deve avere liquidità

In cassa ci sono **0,1 USDY**. Serve perché la liquidazione possa *redimere* il collaterale
in USDY veri: sotto quella soglia ricevi cUSDY (una ricevuta) che su Orca non è vendibile,
e la transazione fa revert alla vendita.

Regola pratica: la liquidità USDY disponibile deve superare il collaterale che ti aspetti
di prendere nella liquidazione più grande che vuoi fare.

### A3. Devono esistere posizioni con debito

Oggi: **0 obligation**, 0 debito. Un liquidatore senza posizioni da liquidare non ha lavoro.

> Nel frattempo il bot si può far girare su un market Kamino **attivo** cambiando
> `TARGET_MARKET` e la coppia di reserve in `src/config.ts`. Il codice è parametrico; il
> Main Market ha 106.000 posizioni e ~12.400 con debito oltre 100 $.

---

## B. Le cinque cose che devi finire tu

| # | Cosa | Perché blocca | Dove |
|---|---|---|---|
| B1 | **Address Lookup Table** | la transazione tocca ~45–50 account: senza ALT rischia di non entrare nel limite di dimensione | nuovo, + `src/build/tx.ts` |
| B2 | **Creare i 3 ATA** | `USDC`, `USDY`, **`cUSDY`** — quest'ultimo è quello che si dimentica sempre, ma la liquidazione lo usa come transito | una tantum, fuori dal ciclo caldo |
| B3 | **Collegare `scanner.ts` al ciclo** | `index.ts` usa ancora il metodo dell'SDK che scarica le posizioni intere: va bene su un market vuoto, è inutilizzabile su uno attivo | `src/index.ts` |
| B4 | **Prezzo SOL reale** | nel cap della priority fee è cablato a 150 $: se SOL si muove, il tetto sul costo è sbagliato | `src/index.ts` |
| B5 | **Riconciliazione post-conferma** | il profitto vero si legge da `pre/postTokenBalances` della transazione confermata, non dalla stima | `src/execute.ts` |

Opzionali ma consigliati prima di alzare i volumi: listener WebSocket sul feed Scope
(oggi è polling ogni 2 s) e lock esterno se fai girare più di un'istanza.

---

## C. Setup operativo

### C1. Il nodo RPC

L'endpoint pubblico **non** è utilizzabile in produzione: è lento e a rate limit. Serve un
provider (Helius, Triton, QuickNode) e, idealmente, un secondo per il failover.

```
RPC_PRIMARY=https://mainnet.<provider>/?api-key=...
RPC_SECONDARY=https://...
WS_PRIMARY=wss://mainnet.<provider>/?api-key=...
```

### C2. La chiave

È una **chiave calda**: firma flash loan, liquidazione e swap su una macchina accesa.

- chiave dedicata **solo** a questo bot: nessun altro fondo, nessuna delega;
- tienici sopra solo SOL per commissioni e rent (0,2–0,5 SOL bastano);
- il file `.json` con permessi `600`, fuori dal repository, mai in git;
- sposta i profitti USDC su un wallet freddo con una transazione separata, periodicamente.

### C3. La macchina

Un VPS vicino ai validator (Francoforte o Amsterdam per l'Europa) riduce la latenza di
decine di millisecondi. Non serve nulla di potente: 2 vCPU e 2 GB bastano. Fai girare il
processo sotto `systemd` con riavvio automatico.

### C4. Monitoraggio

Il minimo indispensabile: un alert se il processo muore, uno se cinque transazioni di fila
falliscono, uno se il tasso di atterraggio scende sotto il 30 %. Log su file, ruotati.

---

## D. La sequenza di accensione

Nessuno di questi passi si salta, e ognuno ha una condizione d'uscita verificabile.

**1 — Preflight verde**
```bash
npm run preflight
```
Deve dire `PRONTO`. Se dice `NON PRONTO`, i blocchi elencati sono esattamente ciò che manca.

**2 — Controlli di regressione**
```bash
npm test          # locale, LiteSVM, nessuna rete
npm run test:live # mainnet, sola lettura
```
Il test *"le costanti in src/config.ts corrispondono ancora allo stato on-chain"* è quello
che conta: se il curator ha cambiato un parametro, fallisce qui invece che con una
transazione persa.

**3 — Dry run prolungato**
```
DRY_RUN=true
```
Lascialo girare **almeno 24 ore**. Quello che devi vedere: almeno un piano che supera tutti
i filtri **e** una simulazione con delta USDC positivo. Finché questo non succede, non c'è
niente da mettere in produzione.

**4 — Primo invio, soglie strette**
```
DRY_RUN=false
MIN_PROFIT_USDC=20           # solo occasioni grandi
MIN_MARGIN_BPS=100           # solo margini larghi
MAX_PRIORITY_LAMPORTS=50000  # se perdi la gara, pazienza
```
Una liquidazione. Poi fermati e riconcilia: `pre/postTokenBalances` della transazione
confermata contro la stima del bot. Se divergono, non alzare nulla — capisci perché.

**5 — Allentamento graduale**
Una soglia alla volta, con almeno un giorno di osservazione fra un cambio e l'altro.
Ordine consigliato: prima `MIN_PROFIT_USDC`, poi `MAX_PRIORITY_LAMPORTS`, per ultimo
`MIN_MARGIN_BPS`.

---

## E. Gestione quotidiana

| Quando | Cosa |
|---|---|
| ogni avvio | `npm run preflight` |
| ogni giorno | profitto netto = incassi confermati **meno** commissioni delle transazioni fallite |
| ogni giorno | saldo SOL del wallet; ricarica sotto 0,1 |
| ogni settimana | `npm run fixtures && npm test` — rileva cambi di programma o di stato |
| ogni settimana | spostamento dei profitti sul wallet freddo |
| a ogni fallimento anomalo | leggi i log della transazione, classifica il codice d'errore |

### I segnali di allarme

- **`ObligationHealthy` ricorrente** → arrivi sempre tardi: o alzi la priority fee, o
  riduci la latenza, o quel market ha concorrenza troppo forte.
- **Tasso di atterraggio in calo** → il nodo RPC sta degradando, o la priority fee è bassa.
- **Profitto reale < profitto stimato, sistematicamente** → il calcolo dello slippage è
  ottimista: alza `MIN_MARGIN_BPS` finché i due numeri tornano a coincidere.
- **`LiquidationRewardTooSmall`** → la tolleranza su `minAcceptableReceived` è troppo
  stretta, oppure il prezzo si è mosso tra simulazione e invio.

### Lo spegnimento

`DRY_RUN=true` e riavvio: il bot continua a osservare e a loggare, senza inviare nulla.
Non serve altro — non ci sono posizioni aperte da chiudere, perché il bot non tiene mai
inventario: ogni operazione nasce e muore dentro una singola transazione.

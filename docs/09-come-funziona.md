# Come funziona, dall'inizio

Spiegazione senza gergo. Se hai già chiaro cos'è un lending market, salta al §5.

---

## 1. Kamino è un banco dei pegni automatico

Immagina un banco dei pegni: porti un orologio d'oro, ti danno dei contanti, e l'orologio
resta lì finché non restituisci i soldi. Se non li restituisci, il banco vende l'orologio.

Kamino fa la stessa cosa, ma con monete digitali e senza impiegati: è solo un programma
che gira sulla blockchain Solana. Chi ha soldi fermi li **deposita** e guadagna interessi.
Chi ha bisogno di liquidità **lascia una garanzia** e prende in prestito.

### Cos'è un "market"

Un **market** (mercato di prestito) è un *recinto separato* dentro Kamino, con le sue
regole e la sua lista di monete ammesse. Kamino non ha un unico grande calderone: ha
tanti recinti indipendenti, così se uno va male non trascina gli altri.

Il market di questo progetto si chiama **"Nysa First Trial"** e contiene **due sole monete**:

| Moneta | Cos'è | Quanto vale | A cosa serve qui |
|---|---|---|---|
| **USDY** | token di Ondo che rappresenta dollari investiti in titoli di stato USA | ~1,14 $ e sale piano piano | si usa come **garanzia** |
| **USDC** | dollaro digitale | ~1,00 $ | è ciò che si **prende in prestito** |

Dentro un market, ogni moneta ha la sua **reserve**: la cassa che contiene quella moneta e
le regole che la riguardano (quanto puoi farci prestito, che premio spetta a chi liquida…).

---

## 2. La gerarchia: market, reserve, obligation

```
KAMINO
│
├── Market "SOL/BTC"              ← un recinto, $1,07 miliardi
│     ├── reserve SOL       supply $248,80M   Liq LTV 75%
│     ├── reserve USDC      supply $127,37M   Liq LTV 90%
│     ├── reserve JitoSOL   supply  $98,46M   Liq LTV 65%
│     └── … altre 30
│
├── Market "OnRe"                 ← un altro recinto, $301M
│     ├── reserve ONyc  (garanzia)
│     └── reserve USDC  (debito)
│
└── Market "Nysa First Trial"     ← il nostro, $0,10
      ├── reserve USDY  (garanzia)
      └── reserve USDC  (debito)
```

| Termine | Cos'è |
|---|---|
| **market** | il recinto: un elenco di monete ammesse e le sue regole |
| **reserve** | la cassa di *una* moneta dentro un market, con i suoi parametri |
| **obligation** | la scheda personale di un utente in *quel* market: cosa ha depositato, cosa deve |

### Cosa vedi davvero nella pagina Borrow

Quelle che sembrano "le singole monete" sono le **reserve dentro un market aperto**.
La pagina dice *"Showing 23 of 35 markets"*, e ogni scheda è un market:

```
┌─ SOL/BTC Market ──────────── Market Size $1,07B ──┐   ← il MARKET
│  Asset      Total Supply   Liq LTV   Supply APY   │
│  SOL         $248,80M        75%       4,48%      │   ← le RESERVE
│  USDC        $127,37M        90%       3,34%      │
│  JitoSOL      $98,46M        65%       4,91%      │
└───────────────────────────────────────────────────┘
```

**Sul market l'utente fa tutto**: è lì che deposita e prende in prestito.

### Perché recinti separati e non un unico calderone

Ogni moneta porta un rischio diverso. Se un token crolla del 90 % in un minuto e lascia
debito scoperto, il buco lo pagano i depositanti — ma **solo quelli del suo recinto**.

Conseguenza pratica: **la garanzia non attraversa i recinti**. I SOL depositati nel market
"SOL/BTC" non permettono di prendere in prestito nel market "OnRe". Sono mondi separati,
e anche il bot lavora dentro un recinto alla volta.

### Chi è il curator

Ogni market ha un proprietario che decide quali monete ammettere, con che LTV, che premio
ai liquidatori, che tetti di deposito. Kamino gestisce direttamente i market grandi;
chiunque altro può crearne uno e curarlo.

Attenzione a non confondere due pagine diverse:

| Pagina | A chi serve |
|---|---|
| `kamino.com/borrow` | **utenti**: deposita, prende in prestito, restituisce |
| `kamino.com/curators/markets/<id>` | **curator**: configura reserve, parametri, emergency zone |

Il secondo è un pannello di amministrazione: da lì un utente normale non può depositare.

## 3. Come nasce un debito

Marco deposita **10.000 USDY** come garanzia. Valgono 11.435 $.

Il market dice: *«su USDY puoi prenderti al massimo il 70 %»*. Quindi Marco può
prendere in prestito fino a ~8.000 USDC. Diciamo che se li prende tutti.

Questi due numeri contano:

- **70 %** = il limite per aprire il prestito;
- **75 %** = la **soglia di liquidazione**. Se il rapporto `debito ÷ garanzia` supera il
  75 %, la posizione è "malata" e chiunque può intervenire.

Il rapporto debito/garanzia si chiama **LTV** (*loan to value*).

---

## 4. Quando la posizione si ammala

Il prezzo di USDY scende da 1,1435 a **1,05 $**. La garanzia di Marco ora vale
10.000 × 1,05 = **10.500 $**, ma il debito è sempre 8.000 USDC.

```
LTV = 8.000 / 10.500 = 76,2 %      →  oltre la soglia del 75 %
```

Il protocollo ha un problema: se il prezzo continua a scendere, la garanzia varrà meno del
debito e i depositanti ci rimettono. Ma Kamino non ha dipendenti che stanno svegli la
notte a guardare i prezzi.

**Soluzione: paga chiunque lo faccia al posto suo.**

Chi arriva, ripaga un pezzo di debito di Marco e si porta via la garanzia corrispondente
**più un premio del 2–5 %**. Nessun permesso richiesto: è aperto a tutti. Quel "chiunque"
è il nostro bot.

Due regole limitano l'operazione:

- si può ripagare al massimo il **20 % del debito** per volta (serve a non spazzare via
  Marco in un colpo solo);
- il premio qui è tra il **2 %** e il **5 %**, e cresce quanto più la posizione è malata.

---

## 5. Il problema pratico: servono i soldi

Per incassare il premio devi **prima** mettere sul tavolo 1.600 USDC veri (il 20 % di
8.000). Se non li hai, non giochi.

Ed è qui che entra il trucco.

### Il flash loan (prestito lampo)

Su Solana una **transazione** è un blocco di operazioni che vengono eseguite tutte
insieme, nell'ordine che scegli tu. La regola d'oro è: **o riescono tutte, o non ne
risulta eseguita nessuna.** Non esistono vie di mezzo. Si chiama *atomicità*.

Questo permette una cosa impossibile nel mondo reale: farti prestare 1.600 USDC
**all'inizio** della transazione con l'obbligo di restituirli **prima della fine** della
stessa transazione. Se non li restituisci, l'intera transazione viene annullata — e quindi
è come se il prestito non fosse mai avvenuto.

Chi presta non rischia niente. Per questo costa quasi zero: **0,001 %**, cioè 1,6 centesimi
su 1.600 $. (Verificato: il costo misurato è esattamente 0,01 USDC su 1.000 USDC.)

> Nota: il prestito lampo **non** viene preso dal market di Marco — lì ci sono 0,1 USDC in
> tutto. Viene preso dal market principale di Kamino, che ne ha ~23 milioni. Le due cose
> possono stare nella stessa transazione perché il protocollo non le lega fra loro.

---

## 6. La transazione, passo per passo

Nove operazioni, un blocco solo, o tutto o niente:

```
1-2  Prenoto lo spazio di calcolo e decido quanto pagare di "precedenza"
3-4  Dico a Kamino di aggiornare i prezzi di USDY e USDC dall'oracolo
5    Dico a Kamino di ricalcolare lo stato della posizione di Marco
6    Mi faccio prestare 1.600 USDC (prestito lampo)  ─────────────┐
7    Pago 1.600 USDC del debito di Marco             │            │
     e ricevo garanzia per 1.632 $ (= 1.600 + 2 %)   │            │
     cioè 1.554 USDY                                 │            │
8    Vendo i 1.554 USDY su Orca e ricevo ~1.629 USDC │            │
9    Restituisco i 1.600 USDC (+ 1,6 centesimi)  ────┴────────────┘

Resto in mano: ~29 USDC di profitto.
```

**Orca** è un cambiavalute automatico (un "exchange decentralizzato"): un programma che
tiene due casse, una di USDY e una di USDC, e le scambia al prezzo corrente trattenendo
una commissione dello **0,16 %**.

### La parte importante: non puoi perderci il capitale

Il capitale non è tuo — è il prestito lampo. E se al passo 8 gli USDY rendessero meno di
1.600 USDC, al passo 9 non avresti abbastanza per restituire il prestito: **la
transazione fallirebbe e verrebbe annullata per intero**. Il prestito non sarebbe mai
avvenuto, la liquidazione nemmeno.

Costo di un tentativo andato male: solo la commissione di rete, **frazioni di centesimo**.

Non ti fidi solo di questo: dentro la transazione ci sono tre freni espliciti —
*«se ricevo meno di X USDY, fermati»*, *«se lo swap rende meno di Y USDC, fermati»*,
*«se il prezzo su Orca esce da questo intervallo, fermati»*.

---

## 7. Cosa fa il bot, in un giro

```
     ┌──────────────────────────────────────────────────┐
     │ 1. GUARDA    Chiede alla blockchain l'elenco      │
     │              delle posizioni e i prezzi           │
     ├──────────────────────────────────────────────────┤
     │ 2. FILTRA    Quali hanno LTV oltre la soglia?     │
     ├──────────────────────────────────────────────────┤
     │ 3. CALCOLA   Quanto posso ripagare? Che premio    │
     │              mi spetta? Quanto rende la vendita    │
     │              su Orca? Ci guadagno abbastanza?      │
     ├──────────────────────────────────────────────────┤
     │ 4. COSTRUISCE La transazione da 9 passi           │
     ├──────────────────────────────────────────────────┤
     │ 5. PROVA     La esegue "a vuoto" e legge quanti    │
     │              USDC avrebbe davvero guadagnato       │
     ├──────────────────────────────────────────────────┤
     │ 6. INVIA     Solo se la prova è andata bene        │
     │              (e solo se DRY_RUN è disattivato)     │
     └──────────────────────────────────────────────────┘
              ↺  ricomincia ogni 2 secondi
```

Il passo 5 è la rete di sicurezza vera: si può chiedere a un nodo Solana *«esegui questa
transazione ma non salvarla, e dimmi com'è andata»*. Costa zero e dice esattamente quanto
si sarebbe guadagnato.

---

## 8. Dove sta il rischio vero

Non nel perdere il capitale — quello è protetto dall'atomicità. Il rischio è altrove:

| Rischio | In parole semplici |
|---|---|
| **Commissioni bruciate** | Se altri bot arrivano prima, paghi la commissione e torni a casa a mani vuote. Tante volte di fila = perdita. |
| **Prezzo oracolo ≠ prezzo vero** | Kamino calcola il premio usando il prezzo di un "oracolo". Tu vendi al prezzo di Orca. Se l'oracolo sovrastima USDY dell'1,8 %, il premio del 2 % sparisce. |
| **Ricevi la moneta sbagliata** | Se la cassa USDY del market è vuota, Kamino ti dà una "ricevuta" (cUSDY) invece degli USDY veri. Quella ricevuta su Orca non è vendibile → la transazione si annulla. |
| **Chiave calda** | La chiave che firma sta su una macchina accesa. Tienici solo il necessario per le commissioni e sposta i profitti altrove. |

---

## 9. Perché oggi non gira

Il market "Nysa First Trial" è **vuoto**: zero posizioni, zero debiti, 0,1 USDC e 0,1 USDY
in cassa. È un market appena creato e non ancora aperto — c'è anche un parametro
dell'oracolo che punta a un valore segnaposto (USDY quotato 0,000001 $).

Il bot è pronto e testato nei suoi pezzi, ma finché non ci sono posizioni vere non ha
nulla da fare. Le due strade sono: aspettare che il curator apra il market, oppure
puntare il bot su un market Kamino già attivo — il codice è scritto per farlo cambiando
la configurazione.

---

## Glossario

| Termine | Significato |
|---|---|
| **market** | recinto separato dentro Kamino, con le sue monete e le sue regole |
| **reserve** | la cassa di una singola moneta dentro un market, con i suoi parametri |
| **obligation** | la posizione di una persona: cosa ha depositato e cosa ha in prestito |
| **collaterale** | la garanzia depositata (qui: USDY) |
| **LTV** | debito ÷ garanzia, in percentuale |
| **soglia di liquidazione** | l'LTV oltre il quale la posizione può essere liquidata (qui 75 %) |
| **close factor** | quanta parte del debito si può ripagare in un colpo (qui 20 %) |
| **liquidation bonus** | il premio per chi liquida (qui 2–5 %) |
| **flash loan** | prestito che nasce e muore dentro la stessa transazione |
| **transazione atomica** | o riescono tutte le operazioni, o non ne risulta eseguita nessuna |
| **swap** | scambio di una moneta con un'altra su un cambiavalute automatico |
| **Orca / Whirlpool** | il cambiavalute automatico usato per vendere USDY |
| **oracolo (Scope)** | il servizio che dice a Kamino quanto vale ogni moneta |
| **slippage** | la differenza tra il prezzo che ti aspettavi e quello che ottieni davvero |
| **priority fee** | mancia ai validatori per essere eseguito prima degli altri |

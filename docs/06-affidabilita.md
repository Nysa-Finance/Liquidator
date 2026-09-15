# Step 6 — Affidabilità e competizione

## 6.1 Rilevare in fretta

Il segnale che rende liquidabile una posizione **non è** un update dell'account obligation:
è un update del **feed Scope**. Quindi:

- `accountSubscribe` su `3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C` (OraclePrices) e,
  ad ogni notifica, ricalcola l'LTV di **tutta la watchlist** — non solo delle obligation
  che hanno cambiato stato.
- Watchlist = obligation con `ltv > threshold − 300 bps`, mantenuta in memoria e riordinata
  per distanza dalla soglia.
- Se servono davvero <100 ms, passa a **Geyser gRPC** (Yellowstone) con filtro su owner
  klend + account Scope. Con RPC WebSocket pubblico sei nell'ordine dei 400–1500 ms.

Su questo market specifico la competizione è ~zero (0 obligation, 0 volume). Non
sovra-ingegnerizzare la latenza finché non ci sono posizioni vere.

## 6.2 Dati RPC stantii

- Ogni valutazione porta lo `slot` dello snapshot. Rifiuta di costruire una tx se
  `current_slot − snapshot_slot > MAX_SNAPSHOT_AGE_SLOTS` (es. 4).
- Non mischiare dati provenienti da RPC diversi nello stesso snapshot.
- `commitment: 'processed'` per la rilevazione, `'confirmed'` per la conferma.
  `'finalized'` è inutilizzabile (12+ secondi).
- Prezzi: il `marketPriceSf` salvato nella reserve è quello dell'**ultimo refresh on-chain**.
  Sul market Nysa le reserve non vengono refreshate da giorni → quel campo è spazzatura.
  Calcola l'LTV leggendo **Scope direttamente**, esattamente come farà
  `refresh_reserve` dentro la tua tx.

## 6.3 Simulazione

Sempre, prima di ogni invio. Tre controlli distinti:

1. `err == null`
2. `unitsConsumed` → riscrivi `setComputeUnitLimit`
3. delta di `ATA_USDC` dagli `accounts` restituiti → **profitto reale simulato ≥ soglia**

Usa `replaceRecentBlockhash: true` in simulazione, poi rifirma con un blockhash fresco.
Se la simulazione fallisce con `ObligationHealthy` (codice custom klend), rimuovi
l'obligation dalla watchlist calda per N slot: significa che qualcun altro l'ha già presa
o il prezzo è rimbalzato.

Mappa i codici d'errore custom di klend (sono nell'SDK: `@codegen/klend/errors/custom`)
a decisioni: `ObligationHealthy` → drop; `ReserveStale` → bug tuo nell'ordine ix;
`LiquidationRewardTooSmall` → alza il sizing o abbassa `minAcceptableReceived`;
`InsufficientLiquidity` → la reserve del flash loan è secca.

## 6.4 Blockhash

- Mantieni un blockhash aggiornato in background ogni ~2 s (`getLatestBlockhash('confirmed')`)
  così la tx calda non aspetta un round-trip.
- Un blockhash vive ~150 slot ≈ 60 s. Traccia `lastValidBlockHeight` e smetti di
  rebroadcastare quando `getBlockHeight() > lastValidBlockHeight`.
- Alternativa per l'affidabilità massima: **durable nonce**. Costa un account e una ix in
  più (`advanceNonceAccount` deve essere la **prima** istruzione), ma elimina la scadenza.
  Attenzione: cambia gli indici → `borrowInstructionIndex` si sposta.

## 6.5 Priority fee

- `getRecentPrioritizationFees` con `lockedWritableAccounts` = i writable della tua tx.
- Politica: p75 di base; raddoppia (cap incluso) dopo un fallimento attribuito a race;
  decadi del 10 % dopo ogni successo.
- Cap duro: `priority_fee_lamports ≤ min(MAX_PRIORITY_SOL, 0,25 × Π_atteso)`.
- Ricorda che il costo è `CU_limit × price`, non `CU_usati × price`: un limite gonfiato
  è denaro buttato.

## 6.6 Niente doppia esecuzione

- **Lock in-process** per `obligation`: un solo plan in volo per obligation.
- Stato `inFlight: Map<obligation, {signature, sentAtSlot, blockhash}>`; rilascia solo su
  conferma o su scadenza blockhash.
- Se giri più istanze, serve un lock **esterno** (Redis `SET NX PX`) con chiave
  `liq:{obligation}` e TTL = durata blockhash.
- L'atomicità on-chain ti salva comunque: una seconda liquidazione sulla stessa obligation
  già risanata fallisce con `ObligationHealthy` e ti costa solo la fee. Ma il lock evita
  di pagarla.

## 6.7 Recupero dai fallimenti

| Situazione | Azione |
|---|---|
| Tx non atterra entro `lastValidBlockHeight` | rebuild completo da snapshot fresco, non rifirmare la vecchia |
| Tx atterra con errore | leggi i log, classifica il codice, aggiorna cache, backoff sull'obligation |
| Tx atterra ma profitto < atteso | logga la divergenza, alza `MIN_MARGIN_BPS` se ricorrente |
| RPC timeout in invio | prova gli altri RPC con la **stessa** tx firmata (idempotente per signature) |
| Simulazione fallisce 3× di fila sulla stessa obligation | quarantena 300 slot |

**Non ritentare mai** una tx fallita per `ObligationHealthy` o `InvalidFlashRepay`:
la prima è definitiva, la seconda è un bug di costruzione.

## 6.8 Inventario

Con il flash loan non ti serve inventario USDC — ed è il vantaggio principale rispetto al
terminator ufficiale, che invece deve tenere scorte. Ma ti serve:
- SOL per fee e rent ATA (tieni ≥ 0,1 SOL);
- il rent già pagato per i 3 ATA;
- un buffer USDC di 1–2 unità per gli arrotondamenti `to_ceil()`.

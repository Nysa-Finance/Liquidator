# Step 1 — Protocolli: programmi, istruzioni, account

Tutto ciò che segue è estratto dai sorgenti, non da documentazione secondaria.

## 1.1 Programmi coinvolti

| Programma | Address | Fonte |
|---|---|---|
| Kamino Lending (klend) | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | `declare_id!` in `programs/klend/src/lib.rs` [V] |
| klend staging | `SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh` | idem, feature `staging` [V] |
| Kamino Farms | vedi `farms::program::Farms` | richiesto come account anche se i farm sono `None` [V] |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | `declare_id!` in `whirlpools/programs/whirlpool/src/lib.rs` [V] |
| Scope (oracle) | `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ` | owner del feed `3NJYftD5…` [V] |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `liquidity.tokenProgram` di entrambe le reserve [V] |

## 1.2 PDA

```
lending_market_authority = PDA(["lma", lending_market],            KLend2g3…)   [V]
whirlpool_oracle         = PDA(["oracle", whirlpool],             whirLbMi…)   [V]
tick_array               = PDA(["tick_array", whirlpool,
                                start_tick_index.toString()],      whirLbMi…)  [V]
obligation_farm_user     = PDA(["user", reserve_farm_state, obligation], farms) [V]
```

`seeds::LENDING_MARKET_AUTH` è la costante usata da `gen_signer_seeds!`; il bump è
`lending_market.bump_seed`.

## 1.3 `flash_borrow_reserve_liquidity` — ordine account esatto (dall'IDL) [V]

```
0  user_transfer_authority          signer
1  lending_market_authority
2  lending_market
3  reserve                          mut     ← controllato dal flash_repay: accounts[3]
4  reserve_liquidity_mint
5  reserve_source_liquidity         mut     (= reserve.liquidity.supply_vault)
6  user_destination_liquidity       mut     (tuo ATA USDC)
7  reserve_liquidity_fee_receiver   mut     (= reserve.liquidity.fee_vault)
8  referrer_token_state             mut  opt
9  referrer_account                 mut  opt
10 sysvar_info                              (Sysvar1nstructions1111…)
11 token_program
args: liquidity_amount: u64
```

## 1.4 `flash_repay_reserve_liquidity` [V]

Stessa forma, con `reserve_destination_liquidity` e `user_source_liquidity` al posto degli
omologhi. Args: `liquidity_amount: u64`, `borrow_instruction_index: u8`.

## 1.5 I vincoli di introspezione del flash loan — `lending_market/flash_ixs.rs` [V]

Dal codice sorgente, `flash_borrow_checks_internal` e `flash_repay_checks` impongono:

1. **Nessuna CPI**: `is_flash_forbidden_cpi_call()` — l'ix deve essere top-level
   (`stack_height == TRANSACTION_LEVEL_STACK_HEIGHT`) e il `program_id` dell'ix corrente
   deve essere klend. Non puoi wrappare il flash loan in un tuo programma.
2. **Un solo flash borrow** e **un solo flash repay** per transazione.
3. `repay.liquidity_amount == borrow.liquidity_amount` (il capitale, non capitale+fee).
4. `repay.borrow_instruction_index` deve puntare **esattamente** all'indice del flash borrow.
5. `borrow_instruction_index < current_index`.
6. `repay_ix.accounts[3] == reserve` passato al repay.
7. **Gli elenchi account di borrow e repay devono essere identici**: stessa lunghezza e
   stessa pubkey in ogni posizione. Quindi i due account opzionali referrer vanno passati
   nello stesso modo in entrambe.

> **Non c'è** alcun divieto di inserire altre istruzioni klend tra borrow e repay.
> Il ciclo in `flash_borrow_checks_internal` fa `continue` su tutto ciò che non è
> borrow/repay e non rifiuta altre ix di klend. Conferma indipendente: l'SDK ufficiale
> (`dist/leverage/instructions.js`) costruisce proprio flash-borrow → deposit → borrow →
> flash-repay. **La liquidazione in mezzo è lecita.**

## 1.6 `liquidate_obligation_and_redeem_reserve_collateral_v2` — account (dall'IDL) [V]

```
liquidation_accounts:
  0  liquidator                              signer
  1  obligation                              mut
  2  lending_market
  3  lending_market_authority
  4  repay_reserve                           mut     ← reserve USDC (debito)
  5  repay_reserve_liquidity_mint
  6  repay_reserve_liquidity_supply          mut
  7  withdraw_reserve                        mut     ← reserve USDY (collaterale)
  8  withdraw_reserve_liquidity_mint
  9  withdraw_reserve_collateral_mint        mut     (cUSDY)
 10  withdraw_reserve_collateral_supply      mut
 11  withdraw_reserve_liquidity_supply       mut
 12  withdraw_reserve_liquidity_fee_receiver mut
 13  user_source_liquidity                   mut     ← tuo ATA USDC (esce il repay)
 14  user_destination_collateral             mut     ← tuo ATA cUSDY (transito)
 15  user_destination_liquidity              mut     ← tuo ATA USDY (entra il collaterale)
 16  collateral_token_program                        (sempre SPL Token legacy: `Program<Token>`)
 17  repay_liquidity_token_program
 18  withdraw_liquidity_token_program
 19  instruction_sysvar_account
collateral_farms_accounts: obligation_farm_user_state opt, reserve_farm_state opt
debt_farms_accounts:       obligation_farm_user_state opt, reserve_farm_state opt
farms_program
args: liquidity_amount u64, min_acceptable_received_liquidity_amount u64,
      max_allowed_ltv_override_percent u64
```

Note dal codice:
- `collateral_token_program` è tipizzato `Program<'info, Token>` → **sempre** SPL Token legacy,
  anche se la liquidity mint fosse Token-2022. I cToken sono sempre legacy [V].
- `max_allowed_ltv_override_percent` funziona **solo** se `liquidator == obligation.owner`
  **e** solo nel programma staging. In mainnet è ignorato con un warning [V].
- `min_acceptable_received_liquidity_amount` è il tuo slippage guard on-chain:
  se `net_withdraw_liquidity_amount < min` → errore `LiquidationRewardTooSmall` [V].
  **Va sempre valorizzato.**

## 1.7 Precondizioni di freschezza [V]

`utils::assert_obligation_liquidatable` richiede che, **nello slot corrente**:
- `repay_reserve.last_update` non sia stale con `PriceStatusFlags::LIQUIDATION_CHECKS`
- `withdraw_reserve.last_update` idem
- `obligation.last_update` idem

Flag: `PRICE_LOADED=0b1`, `PRICE_AGE_CHECKED=0b10`, `TWAP_CHECKED=0b100`,
`TWAP_AGE_CHECKED=0b1000`, `HEURISTIC_CHECKED=0b10000`.

Quindi nella stessa transazione servono, prima della liquidazione:
`refresh_reserve(USDC)`, `refresh_reserve(USDY)`, `refresh_obligation`.

`refresh_reserve` account [V]: `reserve` (mut), `lending_market`,
`pyth_oracle` opt, `switchboard_price_oracle` opt, `switchboard_twap_oracle` opt,
`scope_prices` opt. Per questo market **solo `scope_prices`** è valorizzato
(`3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C`); Pyth è `nu1111…` e Switchboard vuoto [V].

`refresh_obligation` account [V]: `lending_market`, `obligation` (mut) + **remaining accounts**
nell'ordine: prima tutte le deposit reserve (`active_deposits_count`), poi tutte le borrow
reserve (`active_borrows_count`), poi — solo se `obligation.has_referrer()` — un
`referrer_token_state` per ogni borrow. Il conteggio è verificato esattamente:
lunghezza sbagliata → `InvalidAccountInput`.

`price_refresh_trigger_to_max_age_pct = 0` sul market Nysa ⇒ `is_price_refresh_needed` è
**sempre true** ⇒ `refresh_reserve` rilegge Scope ad ogni chiamata. Non puoi saltarlo [V].

## 1.8 Orca — `swap` e `swap_v2` [V]

`swap` (v1), account nell'ordine:
```
token_program, token_authority(signer), whirlpool(mut),
token_owner_account_a(mut), token_vault_a(mut),
token_owner_account_b(mut), token_vault_b(mut),
tick_array_0(mut), tick_array_1(mut), tick_array_2(mut),
oracle            // non-mut in v1; se il pool ha AdaptiveFee va passato mut nei remaining
```
`swap_v2` aggiunge in testa `token_program_a`, `token_program_b`, `memo_program` e,
dopo `whirlpool`, `token_mint_a` / `token_mint_b`; `oracle` è **mut**; accetta
`remaining_accounts_info: Option<RemainingAccountsInfo>` per transfer hook e tick array
supplementari.

Args (identici nei due): `amount u64`, `other_amount_threshold u64`,
`sqrt_price_limit u128`, `amount_specified_is_input bool`, `a_to_b bool`.

Per il nostro caso: USDY = mint A, USDC = mint B → **`a_to_b = true`**,
`amount_specified_is_input = true`, `amount` = USDY ricevuti,
`other_amount_threshold` = minimo USDC accettato (slippage guard on-chain),
`sqrt_price_limit` = `MIN_SQRT_PRICE + 1` oppure un limite più stretto calcolato.

Entrambe le mint sono SPL Token legacy ⇒ `swap` v1 è sufficiente e costa 5 account in meno.
Uso comunque **v2** nel codice, perché è la strada che Orca mantiene e perché rende il bot
riusabile su reserve Token-2022 (es. PYUSD sul Main Market).

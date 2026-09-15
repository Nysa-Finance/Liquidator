import type { Address, Base58EncodedBytes } from '@solana/kit';
import type { RpcClient } from './rpc.js';
import { KLEND_PROGRAM } from './config.js';

/**
 * Prefiltro di salute su TUTTE le obligation di un market, in una sola chiamata.
 *
 * L'idea: `getProgramAccounts` accetta un `dataSlice`, cioè permette di farsi
 * restituire solo una finestra di byte di ogni account. Invece di scaricare
 * 106.000 obligation × 3.344 byte (≈355 MB) se ne scaricano 64 byte ciascuna
 * (≈7 MB) — abbastanza per sapere chi è sopra la soglia di liquidazione.
 *
 * Una obligation è sopra soglia quando
 *     borrow_factor_adjusted_debt_value_sf >= unhealthy_borrow_value_sf
 * (entrambi sono valori in USD scalati: il denominatore dell'LTV è lo stesso,
 * quindi il rapporto fra i due È il rapporto fra LTV e soglia).
 *
 * ATTENZIONE: questi campi contengono lo stato dell'ULTIMO `refresh_obligation`
 * andato a buon fine, non lo stato ai prezzi di adesso. Il risultato è una lista
 * di CANDIDATI da verificare, non un elenco di certezze.
 */

/** OBLIGATION_SIZE (3336) + 8 byte di discriminante Anchor. */
export const OBLIGATION_ACCOUNT_SIZE = 3344;

/**
 * Offset dei campi dentro l'account, discriminante inclusa.
 * Ricavati empiricamente e ri-verificati dal test `tests/live.readonly.test.ts`
 * confrontandoli con il decoder ufficiale dell'SDK: se Kamino cambia la struct,
 * quel test fallisce invece di lasciar passare numeri sbagliati.
 */
export const OBLIGATION_OFFSETS = {
  lendingMarket: 32,
  depositedValueSf: 1192,
  borrowFactorAdjustedDebtValueSf: 2208,
  borrowedAssetsMarketValueSf: 2224,
  allowedBorrowValueSf: 2240,
  unhealthyBorrowValueSf: 2256,
} as const;

/** Finestra che copre i quattro valori aggregati in fondo alla struct. */
export const HEALTH_WINDOW = {
  offset: OBLIGATION_OFFSETS.borrowFactorAdjustedDebtValueSf,
  length: 64,
} as const;

export type HealthRow = {
  obligation: Address;
  /** debito aggiustato per borrow factor, in unità scalate 2^60 */
  debtValueSf: bigint;
  borrowedAssetsValueSf: bigint;
  allowedBorrowValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  /** 1,0 = esattamente sulla soglia di liquidazione; > 1 = sopra */
  healthRatio: number;
  /** 1,0 = esattamente al limite di indebitamento */
  borrowUtilization: number;
};

const SF = 2 ** 60;

function readU128LE(b: Buffer, o: number): bigint {
  return b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
}

export function decodeHealthWindow(obligation: Address, data: Buffer): HealthRow | null {
  if (data.length < HEALTH_WINDOW.length) return null;
  const base = HEALTH_WINDOW.offset;
  const debtValueSf = readU128LE(data, OBLIGATION_OFFSETS.borrowFactorAdjustedDebtValueSf - base);
  const borrowedAssetsValueSf = readU128LE(data, OBLIGATION_OFFSETS.borrowedAssetsMarketValueSf - base);
  const allowedBorrowValueSf = readU128LE(data, OBLIGATION_OFFSETS.allowedBorrowValueSf - base);
  const unhealthyBorrowValueSf = readU128LE(data, OBLIGATION_OFFSETS.unhealthyBorrowValueSf - base);

  if (debtValueSf === 0n || unhealthyBorrowValueSf === 0n) return null; // nessun debito utile

  return {
    obligation,
    debtValueSf,
    borrowedAssetsValueSf,
    allowedBorrowValueSf,
    unhealthyBorrowValueSf,
    healthRatio: Number(debtValueSf) / Number(unhealthyBorrowValueSf),
    borrowUtilization:
      allowedBorrowValueSf === 0n ? Infinity : Number(debtValueSf) / Number(allowedBorrowValueSf),
  };
}

/** Valore in USD di un campo scalato 2^60. */
export function sfToUsd(sf: bigint): number {
  return Number(sf) / SF;
}

export type ScanOptions = {
  /**
   * Scarta le posizioni sotto questa soglia di debito in USD.
   *
   * Serve davvero: sul Main Market ~10.500 obligation risultano "sopra soglia",
   * ma la stragrande maggioranza sono posizioni chiuse o polvere, con valori
   * aggregati rimasti congelati all'ultimo refresh. Senza questo filtro la lista
   * di candidati è dominata da rumore.
   */
  minDebtUsd?: number;
};

export async function scanObligationHealth(
  rpc: RpcClient,
  market: Address,
  programId: Address = KLEND_PROGRAM,
  opts: ScanOptions = {},
): Promise<HealthRow[]> {
  const res = await rpc
    .getProgramAccounts(programId, {
      encoding: 'base64',
      dataSlice: HEALTH_WINDOW,
      filters: [
        { dataSize: BigInt(OBLIGATION_ACCOUNT_SIZE) },
        {
          memcmp: {
            offset: BigInt(OBLIGATION_OFFSETS.lendingMarket),
            bytes: market as unknown as Base58EncodedBytes,
            encoding: 'base58',
          },
        },
      ],
    })
    .send();
  // senza `withContext` l'RPC restituisce direttamente l'array
  const accounts = res as unknown as { pubkey: Address; account: { data: [string, string] } }[];

  const rows: HealthRow[] = [];
  for (const a of accounts) {
    const data = Buffer.from(a.account.data[0], 'base64');
    const row = decodeHealthWindow(a.pubkey, data);
    if (!row) continue;
    if (opts.minDebtUsd !== undefined && sfToUsd(row.debtValueSf) < opts.minDebtUsd) continue;
    rows.push(row);
  }
  rows.sort((x, y) => y.healthRatio - x.healthRatio);
  return rows;
}

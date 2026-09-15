import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';
import type { RpcClient } from './rpc.js';

/**
 * Client RPC che *non può* scrivere sulla catena.
 *
 * Non è una promessa: è un cancello. Il transport ispeziona il metodo JSON-RPC
 * prima di inviarlo e lancia un'eccezione se non è nella whitelist. Anche un
 * refactor sbadato che chiamasse `sendTransaction` non riuscirebbe a spedirlo.
 *
 * Lo usano sia i test live sia `npm run preflight`.
 */
const ALLOWED = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getBlockTime',
  'getEpochInfo',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSlot',
  'getTokenAccountBalance',
  'getTransaction',
  'getVersion',
  // la simulazione non modifica lo stato: nessuna firma valida, nessun invio
  'simulateTransaction',
]);

export class WriteAttemptError extends Error {
  constructor(method: string) {
    super(`Client in sola lettura: il metodo "${method}" è vietato`);
    this.name = 'WriteAttemptError';
  }
}

export function createReadOnlyRpc(url: string): RpcClient {
  const inner = createDefaultRpcTransport({ url });
  const guarded = (async (config: Parameters<typeof inner>[0]) => {
    const payload = (config as { payload?: { method?: string } }).payload;
    const method = payload?.method ?? '<sconosciuto>';
    if (!ALLOWED.has(method)) throw new WriteAttemptError(method);
    return inner(config as never);
  }) as typeof inner;

  return createSolanaRpcFromTransport(guarded) as unknown as RpcClient;
}

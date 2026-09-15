import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';
import type { RpcClient } from './rpc.js';

/**
 * An RPC client that *cannot* write to the chain.
 *
 * This is a gate, not a promise: the transport inspects the JSON-RPC method
 * before sending it and throws if the method is not on the allowlist. Even a
 * careless refactor calling `sendTransaction` would never get it on the wire.
 *
 * Used by both the live tests and `npm run preflight`.
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
  // simulation does not mutate state: no valid signature, nothing submitted
  'simulateTransaction',
]);

export class WriteAttemptError extends Error {
  constructor(method: string) {
    super(`Read-only client: method "${method}" is not allowed`);
    this.name = 'WriteAttemptError';
  }
}

export function createReadOnlyRpc(url: string): RpcClient {
  const inner = createDefaultRpcTransport({ url });
  const guarded = (async (config: Parameters<typeof inner>[0]) => {
    const payload = (config as { payload?: { method?: string } }).payload;
    const method = payload?.method ?? '<unknown>';
    if (!ALLOWED.has(method)) throw new WriteAttemptError(method);
    return inner(config as never);
  }) as typeof inner;

  return createSolanaRpcFromTransport(guarded) as unknown as RpcClient;
}

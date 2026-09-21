import {
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  type Rpc,
  type SolanaRpcApi,
  type KeyPairSigner,
} from '@solana/kit';
import { readFile } from 'node:fs/promises';
import { CFG } from './config.js';
import { log } from './logger.js';

export type RpcClient = Rpc<SolanaRpcApi>;

/**
 * RPC pool with failover.
 *
 * Rule: a single evaluation *snapshot* must never mix data from different
 * endpoints, or the reference slot is undefined. That is why `active()` keeps
 * returning the same client for as long as it is healthy.
 */
export class RpcPool {
  private readonly clients: RpcClient[];
  private idx = 0;
  private strikes = 0;

  constructor(urls: string[]) {
    const valid = urls.filter((u) => u.length > 0);
    if (valid.length === 0) throw new Error('No RPC endpoint configured');
    this.clients = valid.map((u) => createSolanaRpc(u));
  }

  active(): RpcClient {
    return this.clients[this.idx]!;
  }

  /** Every configured endpoint, for idempotent broadcast of a signed transaction. */
  all(): readonly RpcClient[] {
    return this.clients;
  }

  /** Call after every network error; promotes the next endpoint after 3 strikes. */
  reportFailure(err: unknown): void {
    this.strikes += 1;
    log.warn({ err: String(err), strikes: this.strikes }, 'rpc failure');
    if (this.strikes >= 3 && this.clients.length > 1) {
      this.idx = (this.idx + 1) % this.clients.length;
      this.strikes = 0;
      log.warn({ idx: this.idx }, 'rpc failover');
    }
  }

  reportSuccess(): void {
    this.strikes = 0;
  }
}

export function makeRpcPool(): RpcPool {
  return new RpcPool([CFG.rpcPrimary, CFG.rpcSecondary]);
}

export async function loadSigner(): Promise<KeyPairSigner> {
  const raw = await readFile(CFG.keypairPath, 'utf8');
  const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
  if (bytes.length !== 64) throw new Error(`Unexpected keypair: ${bytes.length} bytes, expected 64`);
  return createKeyPairSignerFromBytes(bytes);
}

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
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
 * Pool di RPC con failover.
 *
 * Regola: uno *snapshot* di valutazione non deve mai mescolare dati provenienti
 * da endpoint diversi, altrimenti lo slot di riferimento non è definito.
 * Per questo `active()` restituisce sempre lo stesso client finché è sano.
 */
export class RpcPool {
  private readonly clients: RpcClient[];
  private idx = 0;
  private strikes = 0;

  constructor(urls: string[]) {
    const valid = urls.filter((u) => u.length > 0);
    if (valid.length === 0) throw new Error('Nessun RPC configurato');
    this.clients = valid.map((u) => createSolanaRpc(u));
  }

  active(): RpcClient {
    return this.clients[this.idx]!;
  }

  /** Da chiamare dopo ogni errore di rete; promuove il successivo dopo 3 strike. */
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

export function makeSubscriptions() {
  if (!CFG.wsPrimary) return null;
  return createSolanaRpcSubscriptions(CFG.wsPrimary as `wss://${string}`);
}

export async function loadSigner(): Promise<KeyPairSigner> {
  const raw = await readFile(CFG.keypairPath, 'utf8');
  const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
  if (bytes.length !== 64) throw new Error(`Keypair inattesa: ${bytes.length} byte, attesi 64`);
  return createKeyPairSignerFromBytes(bytes);
}

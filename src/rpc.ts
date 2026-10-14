import {
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
  type Rpc,
  type Slot,
  type UnixTimestamp,
  type SolanaRpcApi,
  type KeyPairSigner,
} from '@solana/kit';
import { readFile } from 'node:fs/promises';
import { CFG } from './config.js';
import { log } from './logger.js';

export type RpcClient = Rpc<SolanaRpcApi>;

const NO_BLOCK = [
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED,
] as const;

/**
 * The newest processed slot and a block time for it.
 *
 * The SDK's getCurrentLedgerInstant asks for the block time of that exact slot,
 * which fails whenever the slot was skipped (about one in twenty) or the node
 * has not stored its block yet: on the public RPC that killed a tick every half
 * hour or so. Here it falls back to the nearest earlier block — half a second
 * older, well inside the precision the time is used for (interest accrual,
 * price age). Any other error, a 429 included, is not retried here.
 */
export async function ledgerInstant(
  rpc: Pick<RpcClient, 'getSlot' | 'getBlockTime'>,
): Promise<{ slot: Slot; blockTime: UnixTimestamp }> {
  const slot = await rpc.getSlot({ commitment: 'processed' }).send();
  for (let back = 0n; back < 4n; back += 1n) {
    try {
      const blockTime = await rpc.getBlockTime(slot - back).send();
      if (blockTime !== null) return { slot, blockTime };
    } catch (e) {
      if (!NO_BLOCK.some((code) => isSolanaError(e, code))) throw e;
    }
  }
  throw new Error(`no block time within 4 slots of ${slot}`);
}

/**
 * RPC pool with failover.
 *
 * Rule: a single evaluation *snapshot* must never mix data from different
 * endpoints, or the reference slot is undefined. That is why `active()` keeps
 * returning the same client for as long as it is healthy.
 */
export class RpcPool {
  private readonly clients: RpcClient[];
  private readonly hosts: string[];
  private idx = 0;
  private strikes = 0;

  constructor(urls: string[]) {
    const valid = urls.filter((u) => u.length > 0);
    if (valid.length === 0) throw new Error('No RPC endpoint configured');
    this.clients = valid.map((u) => createSolanaRpc(u));
    this.hosts = valid.map((u) => new URL(u).host);
  }

  active(): RpcClient {
    return this.clients[this.idx]!;
  }

  /** Host of the endpoint in use, without the path or query that carry API keys. */
  activeHost(): string {
    return `${this.hosts[this.idx]!}${this.idx === 0 ? '' : ' (secondary)'}`;
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

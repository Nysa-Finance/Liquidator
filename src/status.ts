import { CFG } from './config.js';

/**
 * What the bot is doing right now, kept in memory for the Telegram commands.
 *
 * Written by the main loop, read by commands.ts. Nothing here survives a
 * restart, the pause included: a restarted bot runs as its .env says.
 */

export type MarketView = {
  at: number;
  obligations: number;
  /** closest to liquidation first */
  top: { address: string; ltv: number; liquidationLtv: number; debtUsd: number }[];
  usdyInVault: number;
  flashUsdc: number;
  /** USDC per USDY; null while there is no position to price an exit for */
  orcaPrice: number | null;
  oraclePrice: number;
};

export type Event = { at: number; text: string; count: number };

export const status = {
  startedAt: Date.now(),
  lastScanAt: 0,
  lastSlot: 0n,
  failures: 0,
  paused: null as null | { by: string; at: number },
  market: null as MarketView | null,
  events: [] as Event[],
  /** fees paid by sends that failed on-chain, for the circuit breaker */
  failedFees: [] as { at: number; lamports: bigint }[],
};

const HOUR_MS = 3_600_000;

export function failedFeesLastHourSol(now = Date.now()): number {
  while (status.failedFees.length && now - status.failedFees[0]!.at > HOUR_MS) status.failedFees.shift();
  return status.failedFees.reduce((sum, f) => sum + Number(f.lamports), 0) / 1e9;
}

/**
 * Records the fee a failed send paid. Returns true when this pushed the last
 * hour over MAX_FAILED_FEES_SOL_PER_HOUR and the bot has just paused itself.
 */
export function recordFailedFee(lamports: bigint, now = Date.now()): boolean {
  if (lamports > 0n) status.failedFees.push({ at: now, lamports });
  if (status.paused || failedFeesLastHourSol(now) <= CFG.maxFailedFeesSolPerHour) return false;
  status.paused = { by: 'the circuit breaker', at: now };
  return true;
}

const MAX_EVENTS = 10;

/**
 * Records a notable event for /last. The same text again (a position skipped
 * for the same reason every round) bumps a counter instead of pushing out
 * everything else.
 */
export function note(text: string): void {
  const i = status.events.findIndex((e) => e.text === text);
  const prev = i >= 0 ? status.events.splice(i, 1)[0]! : undefined;
  status.events.push({ at: Date.now(), text, count: (prev?.count ?? 0) + 1 });
  if (status.events.length > MAX_EVENTS) status.events.shift();
}

export function mode(): 'LIVE' | 'DRY RUN' | 'PAUSED' {
  if (status.paused) return 'PAUSED';
  return CFG.dryRun ? 'DRY RUN' : 'LIVE';
}

/** The one gate in front of every submission. */
export function maySend(): boolean {
  return mode() === 'LIVE';
}

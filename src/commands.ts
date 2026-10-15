import { CFG, TARGET_MARKET } from './config.js';
import { log } from './logger.js';
import { say, telegram, telegramEnabled, TelegramError } from './alert.js';
import { failedFeesLastHourSol, mode, note, status } from './status.js';

/**
 * Telegram commands, read from the alert chat by long polling: the bot asks
 * Telegram for new messages, so no port is opened and the RPC sees no extra
 * load unless a command reads a balance.
 *
 * The rule: from Telegram the bot can only become more careful. /pause stops
 * submissions; /resume returns to what .env says, so it can never turn on
 * sending that .env has off. Nothing here moves funds, changes thresholds or
 * shows a secret.
 */

export type Deps = {
  /** live balances of the bot wallet; null when the RPC cannot answer */
  wallet: () => Promise<{ address: string; sol: number; usdc: number; usdy: number } | null>;
  rpcHost: () => string;
};

export type Incoming = { chatId: number | string; fromId: number; fromName: string; text: string };

const COMMANDS = [
  { command: 'status', description: 'is it working: mode, last scan, errors, SOL' },
  { command: 'market', description: 'positions closest to liquidation, liquidity, prices' },
  { command: 'wallet', description: 'SOL, USDC and USDY on the bot wallet' },
  { command: 'last', description: 'last 10 notable events' },
  { command: 'pause', description: '(admin) stop sending transactions now' },
  { command: 'resume', description: '(admin) back to the .env mode: /resume CONFIRM' },
  { command: 'help', description: 'this list' },
];

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const romeTime = (ms: number) => new Date(ms).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome' });

/** A scan older than this means the loop is stuck or the RPC is down. */
const staleAfterMs = () => Math.max(60_000, CFG.scanIntervalMs * 6);

/**
 * Answers one message, or returns null to stay silent: another chat, not a
 * command, or a command addressed to a different bot in the same group.
 */
export async function handle(msg: Incoming, deps: Deps, botUsername?: string): Promise<string | null> {
  if (String(msg.chatId) !== CFG.telegramChatId) return null;
  const m = /^\/([a-z]+)(?:@(\w+))?\s*(.*)$/is.exec(msg.text.trim());
  if (!m) return null;
  const [, cmd, target, arg] = m;
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;

  switch (cmd!.toLowerCase()) {
    case 'start':
    case 'help':
      return [
        'Commands:',
        ...COMMANDS.map((c) => `/${c.command} — ${c.description}`),
        CFG.telegramAdminIds.length ? '' : '\n(admin commands are off: TELEGRAM_ADMIN_IDS is empty)',
      ].join('\n').trim();

    case 'status': {
      const lines = [`${mode()}${status.paused ? ` by ${status.paused.by}, ${ago(status.paused.at)}` : ''}`];
      lines.push(`up ${ago(status.startedAt).replace(' ago', '')}`);
      if (status.lastScanAt === 0) lines.push('no successful scan yet');
      else lines.push(`last scan ${ago(status.lastScanAt)}, slot ${status.lastSlot}`);
      if (Date.now() - (status.lastScanAt || status.startedAt) > staleAfterMs()) {
        lines.push('⚠️ NOT SCANNING — check /last and the logs');
      }
      lines.push(`failed scans in a row: ${status.failures}`);
      lines.push(
        `fees burned on failed sends, last hour: ${failedFeesLastHourSol().toFixed(4)} SOL ` +
          `(pauses above ${CFG.maxFailedFeesSolPerHour})`,
      );
      lines.push(`rpc: ${deps.rpcHost()}`);
      const w = await deps.wallet();
      lines.push(w ? `SOL ${w.sol.toFixed(4)}${w.sol < CFG.minSolBalance ? ' ⚠️ LOW' : ''}` : 'SOL: rpc did not answer');
      return lines.join('\n');
    }

    case 'market': {
      const v = status.market;
      if (!v) return 'no scan completed yet';
      const lines = [`${TARGET_MARKET.name} — as of ${ago(v.at)}`, `positions: ${v.obligations}`];
      if (v.top.length) {
        lines.push('closest to liquidation (LTV / liquidation LTV, debt):');
        for (const o of v.top) {
          lines.push(`${short(o.address)}  ${pct(o.ltv)} / ${pct(o.liquidationLtv)}  $${o.debtUsd.toFixed(2)}`);
        }
      }
      lines.push(`USDY in vault: ${v.usdyInVault.toFixed(2)}`);
      lines.push(`flash liquidity: ${Math.round(v.flashUsdc).toLocaleString('en-US')} USDC`);
      if (v.orcaPrice !== null) {
        const bps = Math.abs(v.orcaPrice / v.oraclePrice - 1) * 10_000;
        lines.push(
          `USDY: Orca ${v.orcaPrice.toFixed(6)} vs oracle ${v.oraclePrice.toFixed(6)} USDC ` +
            `(${bps.toFixed(0)} bps, limit ${CFG.maxOracleDivergenceBps})`,
        );
      } else {
        lines.push(`USDY oracle: ${v.oraclePrice.toFixed(6)} USDC`);
      }
      return lines.join('\n');
    }

    case 'wallet': {
      const w = await deps.wallet();
      if (!w) return 'rpc did not answer, try again';
      return [
        `wallet ${w.address}`,
        `SOL  ${w.sol.toFixed(4)}`,
        `USDC ${w.usdc.toFixed(2)} (profits)`,
        `USDY ${w.usdy.toFixed(6)} (leftovers)`,
        `https://solscan.io/account/${w.address}`,
      ].join('\n');
    }

    case 'last':
      if (!status.events.length) return 'nothing notable yet';
      return status.events
        .map((e) => `${romeTime(e.at)}  ${e.text}${e.count > 1 ? `  (×${e.count})` : ''}`)
        .join('\n');

    case 'pause':
    case 'resume': {
      if (!CFG.telegramAdminIds.includes(String(msg.fromId))) {
        return `${msg.fromName} is not an admin (your id: ${msg.fromId})`;
      }
      if (cmd!.toLowerCase() === 'pause') {
        if (status.paused) return `already paused by ${status.paused.by}`;
        status.paused = { by: msg.fromName, at: Date.now() };
        note(`paused by ${msg.fromName}`);
        log.warn({ by: msg.fromName, id: msg.fromId }, 'paused from telegram');
        return `PAUSED by ${msg.fromName}: nothing will be sent, scanning continues. /resume CONFIRM to undo.`;
      }
      if (!status.paused) return `not paused, mode is ${mode()}`;
      if (!/^(confirm|confermo)$/i.test(arg!.trim())) return 'to resume, send: /resume CONFIRM';
      status.paused = null;
      // a human looked and chose to go on: the breaker counts from zero again
      status.failedFees.length = 0;
      note(`resumed by ${msg.fromName}`);
      log.warn({ by: msg.fromName, id: msg.fromId, mode: mode() }, 'resumed from telegram');
      return `resumed by ${msg.fromName}: mode is ${mode()}, as .env says`;
    }

    default:
      return `unknown command /${cmd}, see /help`;
  }
}

type Update = {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number; username?: string; first_name?: string }; text?: string };
};

/** Starts polling for commands; returns a stop function. A no-op without Telegram. */
export function startCommands(deps: Deps): () => void {
  if (!telegramEnabled()) return () => {};
  const ac = new AbortController();
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      ac.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });

  void (async () => {
    let offset: number | undefined;
    let botUsername: string | undefined;
    try {
      // Commands typed while the bot was down are dropped, not replayed: an
      // old /resume should not fire hours later.
      const backlog = await telegram<Update[]>('getUpdates', { offset: -1, timeout: 0 });
      if (backlog.length) offset = backlog[backlog.length - 1]!.update_id + 1;
      botUsername = (await telegram<{ username: string }>('getMe', {})).username;
      await telegram('setMyCommands', { commands: COMMANDS });
    } catch (e) {
      log.warn({ err: String(e) }, 'telegram commands: setup incomplete, polling anyway');
    }

    while (!ac.signal.aborted) {
      try {
        const updates = await telegram<Update[]>(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message'] },
          AbortSignal.any([ac.signal, AbortSignal.timeout(35_000)]),
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text || !msg.from) continue;
          const reply = await handle(
            {
              chatId: msg.chat.id,
              fromId: msg.from.id,
              fromName: msg.from.username ? `@${msg.from.username}` : (msg.from.first_name ?? String(msg.from.id)),
              text: msg.text,
            },
            deps,
            botUsername,
          ).catch((e) => `command failed: ${String(e).slice(0, 200)}`);
          if (reply) await say(reply).catch((e) => log.warn({ err: String(e) }, 'telegram reply failed'));
        }
      } catch (e) {
        if (ac.signal.aborted) break;
        // 409: another process polls the same bot token (a second instance, or
        // a getUpdates typed by hand). Back off longer and let it finish.
        const conflict = e instanceof TelegramError && e.status === 409;
        log.warn({ err: String(e) }, 'telegram commands: polling failed');
        await sleep(conflict ? 30_000 : 5_000);
      }
    }
  })();

  return () => ac.abort();
}

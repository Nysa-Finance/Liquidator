import { CFG } from './config.js';
import { log } from './logger.js';

/**
 * Telegram: alerts out, and the API call commands.ts shares.
 *
 * Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set, and never allowed
 * to break the bot: a failed alert is logged and dropped. The same key is not
 * repeated within ten minutes, so a stuck RPC does not page every tick.
 */

/** Telegram's refusal. Built from its JSON reply, so it never carries the token. */
export class TelegramError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    /** set when the group was upgraded to a supergroup: the chat id to use instead */
    readonly newChatId: number | undefined,
  ) {
    super(`telegram ${status}: ${reason ?? 'no description'}`);
  }
}

export function telegramEnabled(): boolean {
  return Boolean(CFG.telegramBotToken && CFG.telegramChatId);
}

export async function telegram<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${CFG.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(5_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    parameters?: { migrate_to_chat_id?: number };
  };
  if (!res.ok || !json.ok) throw new TelegramError(res.status, json.description, json.parameters?.migrate_to_chat_id);
  return json.result as T;
}

/** Posts to the configured chat. Throws; alert() is the variant that never does. */
export async function say(text: string): Promise<void> {
  await telegram('sendMessage', {
    chat_id: CFG.telegramChatId,
    text: `[liquidator] ${text}`,
    disable_web_page_preview: true,
  });
}

const lastSent = new Map<string, number>();
const REPEAT_AFTER_MS = 10 * 60_000;

export async function alert(key: string, text: string): Promise<void> {
  if (!telegramEnabled()) return;

  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < REPEAT_AFTER_MS) return;
  lastSent.set(key, now);

  try {
    await say(text);
  } catch (e) {
    // Telegram says why (never echoing the token): "chat not found", or a
    // group upgraded to a supergroup along with the new chat id to use.
    if (e instanceof TelegramError) {
      log.warn({ key, status: e.status, reason: e.reason, newChatId: e.newChatId }, 'telegram alert refused');
    } else {
      log.warn({ key, err: String(e) }, 'telegram alert failed');
    }
  }
}

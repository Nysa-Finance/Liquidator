import { CFG } from './config.js';
import { log } from './logger.js';

/**
 * Optional Telegram alerts.
 *
 * Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set, and never allowed
 * to break the bot: a failed alert is logged and dropped. The same key is not
 * repeated within ten minutes, so a stuck RPC does not page every tick.
 */
const lastSent = new Map<string, number>();
const REPEAT_AFTER_MS = 10 * 60_000;

export async function alert(key: string, text: string): Promise<void> {
  const token = CFG.telegramBotToken;
  const chat = CFG.telegramChatId;
  if (!token || !chat) return;

  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < REPEAT_AFTER_MS) return;
  lastSent.set(key, now);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `[liquidator] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // Telegram says why (never echoing the token): "chat not found", or a
      // group upgraded to a supergroup along with the new chat id to use.
      const body = (await res.json().catch(() => ({}))) as {
        description?: string;
        parameters?: { migrate_to_chat_id?: number };
      };
      log.warn(
        { key, status: res.status, reason: body.description, newChatId: body.parameters?.migrate_to_chat_id },
        'telegram alert refused',
      );
    }
  } catch (e) {
    log.warn({ key, err: String(e) }, 'telegram alert failed');
  }
}

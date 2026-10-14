import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle, startCommands, type Deps } from '../src/commands.js';
import { maySend, mode, note, status } from '../src/status.js';

/**
 * The Telegram command surface. What matters most is what it must refuse:
 * other chats, other bots' commands, non-admins, and any path from Telegram
 * to a riskier mode than .env allows.
 */

const CHAT = '-1001234567890';
const ADMIN = 42;
const deps: Deps = {
  rpcHost: () => 'rpc.example.com',
  wallet: async () => ({ address: 'Wallet1111111111111111111111111111111111111', sol: 0.0889, usdc: 12.5, usdy: 0.01 }),
};
const say = (text: string, fromId = ADMIN, chatId: string | number = CHAT) =>
  handle({ chatId, fromId, fromName: fromId === ADMIN ? '@admin' : '@member', text }, deps, 'nysa_liq_bot');

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = '123:test';
  process.env.TELEGRAM_CHAT_ID = CHAT;
  process.env.TELEGRAM_ADMIN_IDS = `${ADMIN}, 7`;
  process.env.DRY_RUN = 'false';
  status.paused = null;
  status.lastScanAt = Date.now() - 5_000;
  status.events.length = 0;
});

test('silent outside the configured chat, on plain text, and on commands for another bot', async () => {
  assert.equal(await say('/status', ADMIN, '-100999'), null);
  assert.equal(await say('hello'), null);
  assert.equal(await say('/status@some_other_bot'), null);
  assert.match((await say('/status@nysa_liq_bot'))!, /LIVE/);
});

test('/status flags a loop that stopped scanning', async () => {
  assert.doesNotMatch((await say('/status'))!, /NOT SCANNING/);
  status.lastScanAt = Date.now() - 10 * 60_000;
  const r = (await say('/status'))!;
  assert.match(r, /NOT SCANNING/);
  assert.match(r, /rpc: rpc\.example\.com/);
  assert.match(r, /SOL 0\.0889/);
});

test('only admins pause; pausing stops submissions even with DRY_RUN=false', async () => {
  assert.match((await say('/pause', 99))!, /not an admin \(your id: 99\)/);
  assert.equal(status.paused, null);
  assert.equal(maySend(), true);

  assert.match((await say('/pause'))!, /PAUSED by @admin/);
  assert.equal(mode(), 'PAUSED');
  assert.equal(maySend(), false);
});

test('/resume needs CONFIRM and returns to .env, never past it', async () => {
  process.env.DRY_RUN = 'true';
  await say('/pause');
  assert.match((await say('/resume'))!, /\/resume CONFIRM/);
  assert.equal(mode(), 'PAUSED');
  assert.match((await say('/resume CONFIRM'))!, /mode is DRY RUN/);
  assert.equal(mode(), 'DRY RUN');
  assert.equal(maySend(), false);
});

test('admin commands are off when TELEGRAM_ADMIN_IDS is empty', async () => {
  process.env.TELEGRAM_ADMIN_IDS = '';
  assert.match((await say('/pause'))!, /not an admin/);
  assert.match((await say('/help'))!, /admin commands are off/);
});

test('/last counts a repeated event instead of filling up', async () => {
  for (let i = 0; i < 30; i += 1) note('scan failed: HTTP error (429)');
  note('started in LIVE');
  assert.equal(status.events.length, 2);
  assert.match((await say('/last'))!, /429\)\s+\(×30\)/);
});

test('polling skips the backlog, executes new commands and replies in the chat', async () => {
  const sent: string[] = [];
  let polls = 0;
  const realFetch = globalThis.fetch;
  const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  globalThis.fetch = (async (url: string, init: { body: string; signal: AbortSignal }) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    const msg = (id: number, text: string) => ({
      update_id: id,
      message: { chat: { id: Number(CHAT) }, from: { id: ADMIN, username: 'admin' }, text },
    });
    if (method === 'getUpdates' && body.offset === -1) return reply([msg(5, '/pause')]); // typed while down
    if (method === 'getMe') return reply({ username: 'nysa_liq_bot' });
    if (method === 'setMyCommands') return reply(true);
    if (method === 'sendMessage') return (sent.push(body.text), reply({}));
    if (method === 'getUpdates') {
      polls += 1;
      if (polls === 1) {
        assert.equal(body.offset, 6, 'backlog confirmed, not replayed');
        return reply([msg(6, '/status')]);
      }
      // later polls hang like a real long poll until the bot stops
      return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;

  try {
    const stop = startCommands(deps);
    for (let i = 0; i < 100 && sent.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    stop();
    assert.equal(status.paused, null, 'the /pause from the backlog did not run');
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^\[liquidator\] LIVE/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

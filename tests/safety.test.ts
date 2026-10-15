import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Quarantine, readFlashSource } from '../src/execute.js';
import { maySend, recordFailedFee, failedFeesLastHourSol, status } from '../src/status.js';
import { FLASH_SOURCE } from '../src/config.js';
import { loadWorld } from './world.js';

/**
 * The limits on what a failing liquidation can cost: back-off per position,
 * the hourly circuit breaker, and the flash fee read from chain.
 */

beforeEach(() => {
  process.env.DRY_RUN = 'false';
  process.env.MAX_FAILED_FEES_SOL_PER_HOUR = '0.01';
  status.paused = null;
  status.failedFees.length = 0;
});

test('quarantine doubles per failure even after a hold expires, and a success clears it', () => {
  const q = new Quarantine();
  let slot = 1_000n;
  const holds: bigint[] = [];
  for (let i = 0; i < 5; i += 1) {
    q.record('ob', slot, 'fail');
    let held = 0n;
    while (q.isHeld('ob', slot + held)) held += 1n;
    holds.push(held);
    slot += held; // retried the moment the hold ran out
  }
  assert.deepEqual(holds, [30n, 60n, 120n, 240n, 480n]);

  q.clear('ob');
  q.record('ob', slot, 'fail');
  assert.equal(q.isHeld('ob', slot + 30n), false, 'back to the first hold after a success');
});

test('an hour without failures starts the back-off over', () => {
  const q = new Quarantine();
  const t0 = 1_000_000;
  q.record('ob', 0n, 'fail', t0);
  q.record('ob', 100n, 'fail', t0 + 60_000);
  assert.equal(q.isHeld('ob', 100n + 59n), true, 'second strike holds 60 slots');
  q.record('ob', 1_000n, 'fail', t0 + 60_000 + 3_600_001);
  assert.equal(q.isHeld('ob', 1_000n + 30n), false, 'counted as a first strike again');
});

test('the circuit breaker pauses sending once failed fees pass the hourly cap', () => {
  const t = 5_000_000;
  // four failures at the 0.002 SOL cap: 0.008, under 0.01
  for (let i = 0; i < 4; i += 1) assert.equal(recordFailedFee(2_005_000n, t + i), false);
  assert.equal(maySend(), true);
  // the fifth crosses it
  assert.equal(recordFailedFee(2_005_000n, t + 5), true);
  assert.equal(maySend(), false);
  assert.match(status.paused!.by, /circuit breaker/);
  // tripping again while paused does not re-alert
  assert.equal(recordFailedFee(2_005_000n, t + 6), false);
});

test('fees older than an hour drop out of the breaker window', () => {
  recordFailedFee(9_000_000n, 0);
  assert.equal(failedFeesLastHourSol(3_600_001), 0);
  assert.equal(recordFailedFee(2_000_000n, 3_600_002), false);
});

test('the flash fee and liquidity are read from the real Main Market reserve', async () => {
  const world = await loadWorld({ sigverify: false });
  const acc = world.svm.getAccount(FLASH_SOURCE.reserve);
  assert.ok(acc && 'data' in acc && acc.data);
  const data = Buffer.from(acc.data as Uint8Array).toString('base64');
  const rpc = { getAccountInfo: () => ({ send: async () => ({ value: { data: [data, 'base64'] } }) }) };
  const f = await readFlashSource(rpc as never);
  assert.equal(f.disabled, false);
  assert.ok(Math.abs(f.feeRate.toNumber() - FLASH_SOURCE.flashLoanFeeRate) < 1e-15, `fee ${f.feeRate}`);
  assert.ok(f.available.gt(0));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmptyLedger, updateWallet } = require('../src/core/model');
const { commitLedger } = require('../src/core/commitLedger');

const clock = { today: '2026-10-18', nowMs: Date.parse('2026-10-18T01:00:00+08:00') };
const wallet = (id, name = 'Wallet') =>
  createEmptyLedger({ name }, { clock, newIncarnationId: () => id });
function setup(current) {
  let bytes = JSON.stringify(current);
  const calls = [];
  const storage = {
    async save(next) {
      calls.push('write');
      bytes = JSON.stringify(next);
      return next;
    },
    async readCurrent() {
      calls.push('read-current');
      return JSON.parse(bytes);
    },
  };
  const transition = {
    async prepare() {
      calls.push('pause');
      return { ok: true, pending: false };
    },
    async resume() {
      calls.push('resume');
      return { ok: true, pending: false };
    },
  };
  return { storage, transition, calls, bytes: () => bytes };
}

test('ordinary edits persist without pausing reminders or changing wallet ownership', async () => {
  const current = wallet('owner-old');
  const next = updateWallet(current, { name: 'Renamed', currency: 'MYR' });
  const f = setup(current);
  const result = await commitLedger({ current, next, ...f });
  assert.equal(result.ok, true);
  assert.equal(result.ledger.wallet.name, 'Renamed');
  assert.deepEqual(f.calls, ['write']);
});

test('a fresh wallet cannot be written before confirmed old-owner cleanup', async () => {
  const current = wallet('owner-old');
  const next = wallet('owner-new');
  const f = setup(current);
  let result = await commitLedger({ current, next, storage: f.storage });
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls, []);
  f.transition.prepare = async () => {
    f.calls.push('pause');
    return { ok: false, pending: true };
  };
  result = await commitLedger({ current, next, ...f });
  assert.equal(result.ok, false);
  assert.equal(f.bytes(), JSON.stringify(current));
  assert.deepEqual(f.calls, ['pause', 'resume']);
});

test('successful reset saves after cleanup and never resumes the retired owner', async () => {
  const current = wallet('owner-old');
  const next = wallet('owner-new');
  const f = setup(current);
  const result = await commitLedger({ current, next, ...f });
  assert.equal(result.ok, true);
  assert.equal(result.ledger.wallet.incarnationId, 'owner-new');
  assert.deepEqual(f.calls, ['pause', 'write']);
});

test('write-then-throw reset is confirmed by exact active bytes and keeps old reminders retired', async () => {
  const current = wallet('owner-old');
  const next = wallet('owner-new');
  const f = setup(current);
  const save = f.storage.save;
  f.storage.save = async (value) => {
    await save(value);
    throw new Error('transport result lost');
  };
  const result = await commitLedger({ current, next, ...f });
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.equal(result.ledger.wallet.incarnationId, 'owner-new');
  assert.deepEqual(f.calls, ['pause', 'write', 'read-current']);
});

test('a rejected reset resumes the old owner only after observing it still persisted', async () => {
  const current = wallet('owner-old');
  const f = setup(current);
  f.storage.save = async () => {
    f.calls.push('write');
    throw new Error('storage full');
  };
  const result = await commitLedger({ current, next: wallet('owner-new'), ...f });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, false);
  assert.equal(result.ledger.wallet.incarnationId, 'owner-old');
  assert.deepEqual(f.calls, ['pause', 'write', 'read-current', 'resume']);
});

test('failed outcome read blocks further edits and does not resurrect a possibly retired owner', async () => {
  for (const missing of [true, false]) {
    const current = wallet('owner-old');
    const f = setup(current);
    f.storage.save = async () => {
      throw new Error('unknown write');
    };
    f.storage.readCurrent = async () => {
      if (missing) return null;
      throw new Error('unknown read');
    };
    const result = await commitLedger({ current, next: wallet('owner-new'), ...f });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(f.calls, ['pause']);
  }
});

test('a different observed owner becomes the actual view without resuming a stale owner', async () => {
  const current = wallet('owner-old');
  const f = setup(current);
  f.storage.save = async () => {
    throw new Error('unknown write');
  };
  f.storage.readCurrent = async () => wallet('owner-observed', 'Observed wallet');
  const result = await commitLedger({ current, next: wallet('owner-requested'), ...f });
  assert.equal(result.ok, false);
  assert.equal(result.ledger.wallet.incarnationId, 'owner-observed');
  assert.deepEqual(f.calls, ['pause']);
});

test('failed reminder compensation stays visible while the saved old wallet remains usable', async () => {
  const current = wallet('owner-old');
  const f = setup(current);
  f.storage.save = async () => {
    throw new Error('full');
  };
  f.transition.resume = async () => ({ ok: false, pending: true });
  const result = await commitLedger({ current, next: wallet('owner-new'), ...f });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, false);
  assert.match(result.message, /reminders need repair/);
});

test('the saved candidate is captured before an awaited transition can outlive its caller draft', async () => {
  const current = wallet('owner-old');
  const next = wallet('owner-new', 'Intended name');
  const f = setup(current);
  f.transition.prepare = async () => {
    next.wallet.name = 'Late mutation';
    return { ok: true, pending: false };
  };
  const result = await commitLedger({ current, next, ...f });
  assert.equal(result.ok, true);
  assert.equal(result.ledger.wallet.name, 'Intended name');
  assert.equal(JSON.parse(f.bytes()).wallet.name, 'Intended name');
});

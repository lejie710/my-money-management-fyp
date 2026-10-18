const test = require('node:test');
const assert = require('node:assert/strict');
const { createLedgerStorage, STORAGE_KEY, LEGACY_STORAGE_KEY } = require('../src/core/storage');
const { createDemoLedger, createEmptyLedger, totals } = require('../src/core/model');
const { createDemoLedger: createV1 } = require('../src/demo/ledger');

function memoryStore(initial = []) {
  const data = new Map(initial);
  const reads = [];
  const writes = [];
  const adapter = {
    async getItem(key) {
      reads.push(key);
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      writes.push(key);
      data.set(key, value);
    },
  };
  return { data, reads, writes, adapter };
}

test('default storage migrates once only and preserves original preview bytes', async () => {
  const oldText = JSON.stringify(createV1(new Date(2026, 9, 17)), null, 2);
  const memory = memoryStore([[LEGACY_STORAGE_KEY, oldText]]);
  const store = createLedgerStorage(memory.adapter);
  const migrated = await store.load();
  assert.equal(migrated.version, 5);
  assert.equal(memory.data.get(LEGACY_STORAGE_KEY), oldText);
  assert.equal(memory.data.has(STORAGE_KEY), true);
  assert.deepEqual(memory.writes, [STORAGE_KEY]);
  const reloaded = await createLedgerStorage(memory.adapter).load();
  assert.deepEqual(reloaded, migrated);
  assert.deepEqual(totals(reloaded), totals(migrated));
  assert.deepEqual(memory.writes, [STORAGE_KEY]);
});

test('custom test namespace never reads or modifies either canonical preview store', async () => {
  const mainV1 = JSON.stringify(createV1());
  const mainV2 = JSON.stringify(createDemoLedger());
  const memory = memoryStore([
    [LEGACY_STORAGE_KEY, mainV1],
    [STORAGE_KEY, mainV2],
  ]);
  const store = createLedgerStorage(memory.adapter, { key: '@tests/foundation-one' });
  assert.equal(await store.load(), null);
  await store.save(createEmptyLedger({ name: 'Synthetic test' }));
  assert.deepEqual(memory.reads, ['@tests/foundation-one']);
  assert.deepEqual(memory.writes, ['@tests/foundation-one']);
  assert.equal(memory.data.get(LEGACY_STORAGE_KEY), mainV1);
  assert.equal(memory.data.get(STORAGE_KEY), mainV2);
});

test('migration tests can explicitly connect two isolated synthetic keys', async () => {
  const oldText = JSON.stringify(createV1());
  const memory = memoryStore([['@tests/old', oldText]]);
  const store = createLedgerStorage(memory.adapter, { key: '@tests/new', legacyKey: '@tests/old' });
  assert.equal((await store.load()).version, 5);
  assert.equal(memory.data.get('@tests/old'), oldText);
  assert.deepEqual(memory.reads, ['@tests/new', '@tests/old']);
  assert.deepEqual(memory.writes, ['@tests/new']);
  assert.equal(memory.data.has(STORAGE_KEY), false);
});

test('existing new store takes precedence and corrupted new data never falls back', async () => {
  const fresh = createEmptyLedger({ name: 'My existing new wallet' });
  const memory = memoryStore([
    [STORAGE_KEY, JSON.stringify(fresh)],
    [LEGACY_STORAGE_KEY, 'corrupt legacy data'],
  ]);
  assert.deepEqual(await createLedgerStorage(memory.adapter).load(), fresh);
  assert.deepEqual(memory.reads, [STORAGE_KEY]);
  for (const invalid of ['', 'broken JSON', JSON.stringify({ version: 99 })]) {
    const broken = memoryStore([
      [STORAGE_KEY, invalid],
      [LEGACY_STORAGE_KEY, JSON.stringify(createV1())],
    ]);
    await assert.rejects(() => createLedgerStorage(broken.adapter).load());
    assert.deepEqual(broken.reads, [STORAGE_KEY]);
    assert.equal(broken.writes.length, 0);
    assert.equal(broken.data.get(STORAGE_KEY), invalid);
  }
});

test('corrupt legacy payload and failed migration write preserve all source bytes', async () => {
  for (const invalid of ['broken JSON', JSON.stringify({ version: 99 })]) {
    const memory = memoryStore([[LEGACY_STORAGE_KEY, invalid]]);
    await assert.rejects(() => createLedgerStorage(memory.adapter).load());
    assert.equal(memory.data.get(LEGACY_STORAGE_KEY), invalid);
    assert.equal(memory.data.has(STORAGE_KEY), false);
    assert.equal(memory.writes.length, 0);
  }
  const oldText = JSON.stringify(createV1());
  const memory = memoryStore([[LEGACY_STORAGE_KEY, oldText]]);
  memory.adapter.setItem = async () => {
    throw new Error('No storage space');
  };
  await assert.rejects(() => createLedgerStorage(memory.adapter).load(), /No storage space/);
  assert.equal(memory.data.get(LEGACY_STORAGE_KEY), oldText);
  assert.equal(memory.data.has(STORAGE_KEY), false);
});

test('storage read and write failures are surfaced without returning false success', async () => {
  let writes = 0;
  const brokenRead = createLedgerStorage({
    async getItem() {
      throw new Error('Read unavailable');
    },
    async setItem() {
      writes += 1;
    },
  });
  await assert.rejects(() => brokenRead.load(), /Read unavailable/);
  assert.equal(writes, 0);
  const previous = JSON.stringify(createDemoLedger());
  const memory = memoryStore([[STORAGE_KEY, previous]]);
  memory.adapter.setItem = async () => {
    throw new Error('Write unavailable');
  };
  await assert.rejects(
    () => createLedgerStorage(memory.adapter).save(createEmptyLedger()),
    /Write unavailable/,
  );
  assert.equal(memory.data.get(STORAGE_KEY), previous);
});

test('missing stores return null without seeding; invalid save never reaches storage', async () => {
  const memory = memoryStore();
  const store = createLedgerStorage(memory.adapter);
  assert.equal(await store.load(), null);
  assert.equal(memory.writes.length, 0);
  await assert.rejects(() => store.save({ version: 99 }));
  assert.equal(memory.writes.length, 0);
  assert.throws(() => createLedgerStorage(memory.adapter, { key: LEGACY_STORAGE_KEY }));
  assert.throws(() =>
    createLedgerStorage(memory.adapter, { key: '@test/same', legacyKey: '@test/same' }),
  );
});

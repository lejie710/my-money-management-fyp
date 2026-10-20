const networkBoundary = require('./emulatorOnly.cjs').install();
// Explicit demo-only integration; immutable synthetic wallet records remain in this disposable emulator run.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  Module = require('node:module'),
  ts = require('typescript');
if (process.env.FYP_FIREBASE_RULES_TEST !== '1')
  throw Error('Explicit local emulator verification is required.');
const { initializeApp, deleteApp } = require('firebase/app');
const {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  deleteUser,
} = require('firebase/auth');
const { getFirestore, terminate } = require('firebase/firestore');
const { validateCloudConfiguration } = require('../../src/cloud/config');
const { createEverydayCloudStore } = require('../../src/cloud/everydayStore');
const { decodeRecord, everydayKeys } = require('../../src/cloud/everydayFormat');
const { commitLedger } = require('../../src/core/commitLedger');
const { inspectImageHeader } = require('../../src/attachments/imageHeader');
const { photoKey } = require('../../src/core/transactionContext');
const { sha256Hex } = require('../../src/cloud/hash');
const model = require('../../src/core/model');
const file = path.resolve(__dirname, '../../src/cloud/firebasePorts.ts'),
  compiled = new Module(file, module);
compiled.filename = file;
compiled.paths = Module._nodeModulePaths(path.dirname(file));
compiled._compile(
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  file,
);
const { createFirebasePorts } = compiled.exports;
test('actual SDK everyday save, second-device hydration, revision conflict, operation replay and backup service sharing', async () => {
  const stamp = Date.now().toString(36),
    projectId = 'demo-money-backup',
    clock = { today: '2026-10-19', nowMs: Date.UTC(2026, 9, 19) },
    apps = [];
  const configuration = validateCloudConfiguration({
    mode: 'emulator',
    firebase: {
      apiKey: 'demo-only-money-backup-key',
      projectId,
      appId: '1:1234567890:android:0000000000000000000000',
      authDomain: projectId + '.firebaseapp.com',
      storageBucket: projectId + '.appspot.com',
    },
    emulators: { auth: 19099, firestore: 18080, storage: 19199 },
  });
  const create = (suffix) => {
    const app = initializeApp(configuration.firebase, 'everyday-' + stamp + '-' + suffix),
      auth = getAuth(app);
    connectAuthEmulator(auth, 'http://127.0.0.1:19099', { disableWarnings: true });
    apps.push({ app, auth });
    return { app, auth };
  };
  const a = create('a'),
    b = create('b'),
    email = 'everyday-' + stamp + '@example.test',
    password = 'Synthetic-Only-Password-' + stamp;
  let account;
  try {
    account = await createUserWithEmailAndPassword(a.auth, email, password);
    await signInWithEmailAndPassword(b.auth, email, password);
    const owner = { projectId, uid: account.user.uid },
      family = {
        scope: { kind: 'test', namespace: 'everyday-' + stamp },
        actor: { kind: 'firebase-hosted', ...owner },
      },
      keys = everydayKeys(family);
    const bytes = new Uint8Array(
        fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/images/receipt-a.png')),
      ),
      photosA = new Map(),
      photosB = new Map();
    const make = (client, localPhotos, label) => {
      let serial = 0;
      const data = new Map(),
        ports = createFirebasePorts(
          () => ({ ...client, configuration, uid: client.auth.currentUser?.uid }),
          owner,
          globalThis.fetch,
        );
      const store = createEverydayCloudStore({
        family,
        deviceStorage: {
          async getItem(key) {
            return data.get(key) ?? null;
          },
          async setItem(key, value) {
            data.set(key, value);
          },
          async removeItem(key) {
            data.delete(key);
          },
        },
        legacyStorage: {
          async readCurrent() {
            return null;
          },
        },
        ports: () => ports,
        assertCurrent() {
          assert.equal(client.auth.currentUser?.uid, owner.uid);
        },
        now: () => clock.nowMs,
        newId: () => `wallet-emulator-${stamp}-${label}-${++serial}`,
        files: {
          async read(_, photo) {
            return localPhotos.get(photoKey(photo));
          },
          async hydrate(_, storage, items, read, current) {
            for (const item of items) {
              current();
              const value = await read(item);
              assert.equal(sha256Hex(value), item.sha256);
              localPhotos.set(photoKey(item.photo), value);
            }
          },
        },
      });
      return { store, ports, data };
    };
    const left = make(a, photosA, 'left'),
      right = make(b, photosB, 'right');
    const initial = model.createEmptyLedger(
      { name: 'Synthetic cloud wallet' },
      { clock, newIncarnationId: () => 'wallet-sdk-everyday' },
    );
    assert.equal(await left.store.load(), null);
    assert.equal(
      (await commitLedger({ current: initial, next: initial, storage: left.store })).ok,
      true,
    );
    assert.deepEqual(await right.store.load(), initial);
    let candidate = model.saveTransaction(
      initial,
      model.transactionFromDraft(
        {
          title: 'Coffee',
          amount: '12.50',
          type: 'expense',
          date: clock.today,
          categoryId: 'expense-food',
        },
        'coffee',
        initial,
      ),
    );
    const photo = {
      id: 'photo-everyday',
      ownerIncarnationId: initial.wallet.incarnationId,
      fileName: 'photo-everyday.png',
      ...inspectImageHeader(bytes),
    };
    candidate.transactions[0] = model.patchTransactionContext(
      candidate.transactions[0],
      { photo, notes: 'Fictional receipt' },
      candidate,
    );
    photosA.set(photoKey(photo), bytes);
    const OriginalBlob = globalThis.Blob;
    globalThis.Blob = class {
      constructor() {
        throw Error('RN cannot construct Blob from ArrayBuffer.');
      }
    };
    try {
      assert.equal(
        (await commitLedger({ current: initial, next: candidate, storage: left.store })).ok,
        true,
      );
    } finally {
      globalThis.Blob = OriginalBlob;
    }
    assert.equal(left.store.getSnapshot().revision, 2);
    const stale = model.saveTransaction(
      initial,
      model.transactionFromDraft(
        {
          title: 'Bus',
          amount: '4.00',
          type: 'expense',
          date: clock.today,
          categoryId: 'expense-transport',
        },
        'bus',
        initial,
      ),
    );
    const rejected = await commitLedger({ current: initial, next: stale, storage: right.store });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.ledger, candidate);
    assert.equal(right.store.getSnapshot().draft.phase, 'conflict');
    await right.store.discardDraft(right.store.getSnapshot().draft.token);
    assert.deepEqual(await right.store.refresh(), candidate);
    assert.equal(sha256Hex(photosB.get(photoKey(photo))), sha256Hex(bytes));
    const head = await left.ports.readWallet(keys.walletId),
      receipt = await left.ports.readOperation(keys.walletId, head.operationId);
    assert.equal(receipt.payloadHash, head.payloadHash);
    assert.deepEqual(
      await left.ports.commitWallet(keys.walletId, {
        baseRevision: 1,
        baseHash: '0'.repeat(64),
        record: head,
      }),
      head,
      'Exact existing operation is idempotent even after its original base is old.',
    );
    const backupPorts = createFirebasePorts(
      () => ({ ...a, configuration, uid: a.auth.currentUser?.uid }),
      owner,
      globalThis.fetch,
    );
    assert.deepEqual(
      await backupPorts.listIndices(5),
      [],
      'Backup reuses initialized services without rebinding emulators.',
    );
    assert.deepEqual(
      decodeRecord(await left.ports.readWallet(keys.walletId), owner).ledger,
      candidate,
    );
  } finally {
    if (account && a.auth.currentUser) await deleteUser(a.auth.currentUser);
    for (const client of apps) {
      await terminate(getFirestore(client.app));
      await deleteApp(client.app);
    }
    networkBoundary.assertClean();
    console.log(JSON.stringify({ networkBoundary: networkBoundary.summary() }));
    networkBoundary.restore();
  }
});

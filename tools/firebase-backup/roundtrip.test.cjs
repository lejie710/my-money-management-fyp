const networkBoundary = require('./emulatorOnly.cjs').install();
// Uses only the documented isolated demo emulators. Never accepts a live project option.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  Module = require('node:module'),
  ts = require('typescript');
const { initializeApp, deleteApp } = require('firebase/app');
const {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  deleteUser,
} = require('firebase/auth');
const { deleteDoc, doc, getFirestore, terminate } = require('firebase/firestore');
const { deleteObject, ref, getStorage } = require('firebase/storage');
const { validateCloudConfiguration } = require('../../src/cloud/config'),
  { createCloudTransport } = require('../../src/cloud/transport'),
  { makeSnapshot, restoreLedger } = require('../../src/cloud/backupFormat'),
  { sha256Hex } = require('../../src/cloud/hash'),
  model = require('../../src/core/model');
if (process.env.FYP_FIREBASE_RULES_TEST !== '1')
  throw new Error('Explicit local emulator verification is required.');
const file = path.resolve(__dirname, '../../src/cloud/firebasePorts.ts');
const compiled = new Module(file, module);
compiled.filename = file;
compiled.paths = Module._nodeModulePaths(path.dirname(file));
compiled._compile(
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  file,
);
const { createFirebasePorts } = compiled.exports;
test('real Auth, Firestore and Storage roundtrip preserves a wallet and optional photo through the actual SDK ports', async () => {
  const stamp = Date.now().toString(36),
    projectId = 'demo-money-backup';
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
  const app = initializeApp(configuration.firebase, 'roundtrip-' + stamp),
    auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:19099', { disableWarnings: true });
  let owner, backup, photo;
  try {
    const account = await createUserWithEmailAndPassword(
      auth,
      'roundtrip-' + stamp + '@example.test',
      'Synthetic-Only-Password-' + stamp,
    );
    owner = { projectId, uid: account.user.uid };
    const getContext = () => ({ app, auth, configuration, uid: auth.currentUser?.uid });
    const ports = createFirebasePorts(getContext, owner, globalThis.fetch),
      transport = createCloudTransport({ owner, sdk: ports });
    const bytes = new Uint8Array(
        fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/images/receipt-a.png')),
      ),
      hash = sha256Hex(bytes);
    let ledger = model.createEmptyLedger({ name: 'Synthetic SDK roundtrip' });
    ledger = model.saveTransaction(
      ledger,
      model.transactionFromDraft(
        {
          type: 'expense',
          title: 'Receipt test',
          amount: '12.50',
          date: '2026-10-18',
          categoryId: 'expense-food',
        },
        'receipt-expense',
        ledger,
      ),
    );
    photo = {
      id: 'photo-roundtrip',
      ownerIncarnationId: ledger.wallet.incarnationId,
      fileName: 'photo-roundtrip.png',
      mimeType: 'image/png',
      width: 1100,
      height: 900,
      byteSize: bytes.length,
    };
    ledger.transactions[0].context = {
      notes: 'Synthetic receipt',
      photo,
      withPerson: null,
      location: null,
    };
    const before = JSON.stringify(ledger);
    backup = makeSnapshot({
      ledger,
      owner,
      id: 'backup-roundtrip-' + stamp + '-0123456789',
      createdAtMs: Date.now(),
      includePhotos: true,
      photos: [
        {
          sha256: hash,
          mimeType: photo.mimeType,
          width: photo.width,
          height: photo.height,
          byteSize: photo.byteSize,
          transactionIds: ['receipt-expense'],
        },
      ],
    });
    const OriginalBlob = globalThis.Blob;
    let index;
    globalThis.Blob = class {
      constructor() {
        throw new Error('React Native Blob cannot construct ArrayBuffer views.');
      }
    };
    try {
      index = await transport.backup(backup, async () => bytes);
    } finally {
      globalThis.Blob = OriginalBlob;
    }
    assert.equal(index.transactionCount, 1);
    assert.equal(index.photoCount, 1);
    assert.equal(
      (await transport.list()).some((row) => row.backupId === index.backupId),
      true,
    );
    const downloaded = await transport.download(index);
    assert.deepEqual(downloaded, backup);
    const downloadedPhoto = await transport.photo(downloaded, downloaded.photos[0]);
    assert.deepEqual(downloadedPhoto, bytes);
    const restored = restoreLedger(downloaded, owner, 'restored-roundtrip-wallet', {
      [hash]: { ...photo, ownerIncarnationId: 'restored-roundtrip-wallet' },
    });
    assert.equal(model.totals(restored).balance, -1250);
    assert.equal(restored.transactions[0].context.notes, 'Synthetic receipt');
    assert.equal(
      restored.transactions[0].context.photo.ownerIncarnationId,
      'restored-roundtrip-wallet',
    );
    assert.equal(JSON.stringify(ledger), before);
    assert.deepEqual(await transport.backup(backup, async () => bytes), index);
  } finally {
    const cleanupErrors = [];
    const cleanupStorage = getStorage(app, `gs://${configuration.firebase.storageBucket}`);
    assert.equal(cleanupStorage.host, '127.0.0.1:19199');
    if (owner && backup) {
      for (const name of [
        'snapshot.json',
        ...backup.photos.map((item) => 'photos/' + item.sha256),
      ]) {
        try {
          await deleteObject(
            ref(
              getStorage(app, `gs://${configuration.firebase.storageBucket}`),
              `users/${owner.uid}/walletBackups/${backup.backupId}/${name}`,
            ),
          );
        } catch (error) {
          if (error?.code !== 'storage/object-not-found')
            cleanupErrors.push(error?.code || 'object-cleanup-failed');
        }
      }
      try {
        await deleteDoc(
          doc(getFirestore(app), 'users', owner.uid, 'walletBackups', backup.backupId),
        );
      } catch (error) {
        cleanupErrors.push(error?.code || 'index-cleanup-failed');
      }
    }
    if (auth.currentUser) await deleteUser(auth.currentUser);
    await terminate(getFirestore(app));
    await deleteApp(app);
    networkBoundary.assertClean();
    assert.deepEqual(cleanupErrors, [], 'Synthetic emulator cleanup must be confirmed.');
    console.log(JSON.stringify({ networkBoundary: networkBoundary.summary() }));
    networkBoundary.restore();
  }
});

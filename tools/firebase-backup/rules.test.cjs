const networkBoundary = require('./emulatorOnly.cjs').install();
// Explicit local emulator gate only. Not part of the ordinary offline npm test suite.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  setDoc,
  getDocFromServer,
  getDocsFromServer,
  collection,
  deleteDoc,
  terminate,
  writeBatch,
} = require('firebase/firestore');
const {
  getStorage,
  connectStorageEmulator,
  ref,
  uploadBytes,
  getBytes,
  getMetadata,
  deleteObject,
} = require('firebase/storage');
if (process.env.FYP_FIREBASE_RULES_TEST !== '1')
  throw new Error(
    'Start only the documented demo emulators, then explicitly set FYP_FIREBASE_RULES_TEST=1.',
  );
const stamp = Date.now().toString(36),
  projectId = 'demo-money-backup',
  apps = [];
function client(uid) {
  const app = initializeApp(
    { projectId, apiKey: 'demo-only-key', storageBucket: projectId + '.appspot.com' },
    'rules-' + (uid || 'anonymous') + '-' + stamp,
  );
  const db = getFirestore(app);
  connectFirestoreEmulator(
    db,
    '127.0.0.1',
    18080,
    uid ? { mockUserToken: { sub: uid, user_id: uid } } : undefined,
  );
  const files = getStorage(app);
  connectStorageEmulator(
    files,
    '127.0.0.1',
    19199,
    uid ? { mockUserToken: { sub: uid, user_id: uid } } : undefined,
  );
  const value = { app, db, files, uid };
  apps.push(value);
  return value;
}
const a = client('rules-a-' + stamp),
  b = client('rules-b-' + stamp),
  anonymous = client(null),
  id = 'backup-rules-' + stamp + '-0123456789';
const document = (c) => doc(c.db, 'users', a.uid, 'walletBackups', id);
const location = (c, name = 'snapshot.json') =>
  ref(c.files, `users/${a.uid}/walletBackups/${id}/${name}`);
const bytes = new TextEncoder().encode('{}'),
  hash = crypto.createHash('sha256').update(bytes).digest('hex');
const index = {
  version: 1,
  backupId: id,
  createdAtMs: 1000,
  currency: 'MYR',
  transactionCount: 0,
  photoCount: 0,
  snapshotBytes: bytes.length,
  snapshotHash: hash,
  includesPhotos: false,
};
const denied = (error) =>
  ['permission-denied', 'storage/unauthorized', 'storage/unauthenticated'].includes(error?.code);
test.after(async () => {
  for (const c of apps) {
    await terminate(c.db);
    await deleteApp(c.app);
  }
  networkBoundary.assertClean();
  networkBoundary.restore();
});
test('owner can create and read an immutable complete backup index', async () => {
  await setDoc(document(a), index);
  assert.deepEqual((await getDocFromServer(document(a))).data(), index);
  assert.equal(
    (await getDocsFromServer(collection(a.db, 'users', a.uid, 'walletBackups'))).size,
    1,
  );
});
test('other users and anonymous callers cannot read, list or forge owner indexes', async () => {
  for (const c of [b, anonymous]) {
    await assert.rejects(getDocFromServer(document(c)), denied);
    await assert.rejects(
      getDocsFromServer(collection(c.db, 'users', a.uid, 'walletBackups')),
      denied,
    );
    await assert.rejects(
      setDoc(doc(c.db, 'users', a.uid, 'walletBackups', id + '-forged'), {
        ...index,
        backupId: id + '-forged',
      }),
      denied,
    );
  }
});
test('index updates and invalid fields, counts, hashes or mismatched document IDs are rejected', async () => {
  await assert.rejects(setDoc(document(a), { ...index, createdAtMs: 2000 }), denied);
  for (const [suffix, change] of [
    ['extra', { privateField: 'synthetic' }],
    ['hash', { snapshotHash: 'bad' }],
    ['count', { transactionCount: 10001 }],
    ['photo', { photoCount: 1, includesPhotos: false }],
    ['id', { backupId: 'backup-wrong-0123456789abcdef' }],
  ]) {
    const next = id + '-' + suffix;
    await assert.rejects(
      setDoc(doc(a.db, 'users', a.uid, 'walletBackups', next), {
        ...index,
        backupId: next,
        ...change,
      }),
      denied,
    );
  }
});
test('owner can upload and read a snapshot with integrity metadata', async () => {
  await uploadBytes(location(a), bytes, {
    contentType: 'application/json',
    customMetadata: { sha256: hash },
  });
  assert.deepEqual(new Uint8Array(await getBytes(location(a), 10)), bytes);
  assert.equal((await getMetadata(location(a))).customMetadata.sha256, hash);
});
test('snapshot reads, writes, deletes and metadata are owner restricted', async () => {
  for (const c of [b, anonymous]) {
    await assert.rejects(getBytes(location(c), 10), denied);
    await assert.rejects(getMetadata(location(c)), denied);
    await assert.rejects(
      uploadBytes(location(c), bytes, {
        contentType: 'application/json',
        customMetadata: { sha256: hash },
      }),
      denied,
    );
    await assert.rejects(deleteObject(location(c)), denied);
  }
});
test('immutable objects reject overwrite and mismatched photo hashes/content types', async () => {
  await assert.rejects(
    uploadBytes(location(a), bytes, {
      contentType: 'application/json',
      customMetadata: { sha256: hash },
    }),
    denied,
  );
  await assert.rejects(
    uploadBytes(location(a, `photos/${hash}`), bytes, {
      contentType: 'image/png',
      customMetadata: { sha256: '0'.repeat(64) },
    }),
    denied,
  );
  await assert.rejects(
    uploadBytes(location(a, `photos/${hash}`), bytes, {
      contentType: 'text/plain',
      customMetadata: { sha256: hash },
    }),
    denied,
  );
});
test('owner can delete only its test backup objects and index', async () => {
  await assert.rejects(deleteDoc(document(b)), denied);
  await deleteObject(location(a));
  await deleteDoc(document(a));
  assert.equal((await getDocFromServer(document(a))).exists(), false);
});

const walletId =
  'test-' +
  crypto
    .createHash('sha256')
    .update('wallet-rules-' + stamp)
    .digest('hex');
const walletDocument = (c) => doc(c.db, 'users', a.uid, 'wallets', walletId);
const operationDocument = (c, id) =>
  doc(c.db, 'users', a.uid, 'wallets', walletId, 'operations', id);
const walletValue = (revision, suffix) => ({
  version: 1,
  ownerUid: a.uid,
  revision,
  operationId: 'wallet-rules-' + stamp + '-' + suffix,
  updatedAtMs: 1000,
  payload: '{}',
  payloadHash: hash,
});
function pair(c, value, change = {}) {
  const batch = writeBatch(c.db);
  batch.set(walletDocument(c), value);
  batch.set(operationDocument(c, value.operationId), {
    version: 1,
    ownerUid: a.uid,
    operationId: value.operationId,
    revision: value.revision,
    payloadHash: value.payloadHash,
    ...change,
  });
  return batch.commit();
}
test('everyday wallet requires atomic matching receipt and monotonic revision, never a standalone head write', async () => {
  const first = walletValue(1, 'first-0123456789');
  await assert.rejects(setDoc(walletDocument(a), first), denied);
  await pair(a, first);
  assert.deepEqual((await getDocFromServer(walletDocument(a))).data(), first);
  assert.equal(
    (await getDocFromServer(operationDocument(a, first.operationId))).data().revision,
    1,
  );
  await assert.rejects(pair(a, walletValue(1, 'stale-0123456789')), denied);
  await assert.rejects(pair(a, walletValue(3, 'skip-0123456789')), denied);
  await assert.rejects(
    pair(a, walletValue(2, 'mismatch-0123456789'), { payloadHash: '0'.repeat(64) }),
    denied,
  );
  await pair(a, walletValue(2, 'second-0123456789'));
  assert.equal((await getDocFromServer(walletDocument(a))).data().revision, 2);
});
test('everyday wallet and receipt paths reject foreign actors, forged fields and destructive writes', async () => {
  const next = walletValue(3, 'third-0123456789');
  for (const c of [b, anonymous]) {
    await assert.rejects(getDocFromServer(walletDocument(c)), denied);
    await assert.rejects(getDocFromServer(operationDocument(c, next.operationId)), denied);
    await assert.rejects(pair(c, next), denied);
  }
  for (const change of [
    { ownerUid: b.uid },
    { privateField: 'synthetic' },
    { payloadHash: 'bad' },
    { payload: '' },
    { payload: 'x'.repeat(786433) },
  ])
    await assert.rejects(pair(a, { ...next, ...change }), denied);
  const existing = walletValue(2, 'second-0123456789');
  await assert.rejects(
    setDoc(operationDocument(a, existing.operationId), {
      version: 1,
      ownerUid: a.uid,
      operationId: existing.operationId,
      revision: 2,
      payloadHash: hash,
    }),
    denied,
  );
  await assert.rejects(deleteDoc(operationDocument(a, existing.operationId)), denied);
  await assert.rejects(deleteDoc(walletDocument(a)), denied);
  assert.equal((await getDocFromServer(walletDocument(a))).data().revision, 2);
});
test('everyday photo objects are private immutable images with matching content-address metadata', async () => {
  const photo = (c) => ref(c.files, `users/${a.uid}/walletFiles/${walletId}/${hash}`);
  await uploadBytes(photo(a), bytes, {
    contentType: 'image/png',
    customMetadata: { sha256: hash },
  });
  assert.deepEqual(new Uint8Array(await getBytes(photo(a), 10)), bytes);
  for (const c of [b, anonymous]) {
    await assert.rejects(getBytes(photo(c), 10), denied);
    await assert.rejects(getMetadata(photo(c)), denied);
    await assert.rejects(
      uploadBytes(photo(c), bytes, { contentType: 'image/png', customMetadata: { sha256: hash } }),
      denied,
    );
  }
  await assert.rejects(
    uploadBytes(photo(a), bytes, { contentType: 'image/png', customMetadata: { sha256: hash } }),
    denied,
  );
  await assert.rejects(deleteObject(photo(a)), denied);
  for (const [scope, digest, mime, metadataHash] of [
    ['invalid', hash, 'image/png', hash],
    ['main', '0'.repeat(64), 'image/png', hash],
    ['main', hash, 'application/json', hash],
  ])
    await assert.rejects(
      uploadBytes(ref(a.files, `users/${a.uid}/walletFiles/${scope}/${digest}`), bytes, {
        contentType: mime,
        customMetadata: { sha256: metadataHash },
      }),
      denied,
    );
});

const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs');
const { loadSource } = require('./helpers/account-hook-harness.cjs');
const source = path.join(__dirname, '../src/cloud/nativeFiles.ts');
const { inspectImageHeader } = require('../src/attachments/imageHeader'),
  { sha256Hex } = require('../src/cloud/hash');
const family = {
  scope: { kind: 'canonical' },
  actor: { kind: 'firebase-hosted', projectId: 'project-alpha', uid: 'a' },
};
function fixture(options = {}) {
  const calls = { initialize: 0, begin: 0, close: 0, dispose: 0, directoryDelete: 0, stage: 0 },
    dirs = [];
  class Directory {
    constructor() {
      this.present = !!options.existingDirectory;
      dirs.push(this);
    }
    get exists() {
      return options.directoryInfoDenied ? false : this.present;
    }
    info() {
      if (options.directoryInfoDenied) throw Error('READ access denied');
      return { exists: this.present };
    }
    create() {
      if (options.createFails) throw Error('directory create failed');
      this.present = true;
    }
    delete() {
      calls.directoryDelete++;
      if (options.deleteFails) throw Error('directory delete failed');
      if (!options.silentDirectoryDelete) this.present = false;
    }
  }
  class File {
    constructor(directory, name) {
      this.uri = 'file:///synthetic/' + name;
      this.exists = false;
    }
    info() {
      return { exists: this.exists };
    }
    write() {
      this.exists = true;
    }
    delete() {
      this.exists = false;
    }
  }
  const manager = {
    async initialize() {
      calls.initialize++;
      if (options.initializeFails) throw Error('init failed');
      return { pending: false, deleted: 0, retained: 0, message: '' };
    },
    beginDraft() {
      calls.begin++;
      return { id: 'draft-test', ownerIncarnationId: 'new-owner' };
    },
    async closeDraft() {
      calls.close++;
      return {
        pending: !!options.closePending,
        deleted: 0,
        retained: 0,
        message: options.closePending ? 'Synthetic cleanup pending' : '',
      };
    },
    dispose() {
      calls.dispose++;
    },
    async stage() {
      calls.stage++;
      throw Error('Synthetic copy failure');
    },
    async retryCleanup() {
      return { pending: false, deleted: 0, retained: 0, message: '' };
    },
  };
  const module = loadSource(source, {
    '@react-native-async-storage/async-storage': {},
    'expo-file-system': { Directory, File, Paths: { cache: 'file:///cache' } },
    '../attachments/photoFiles': { createPhotoFileAdapter: () => ({}) },
    '../attachments/photoManager': {
      createPhotoManager: () => manager,
      photoFamilyToken: () => JSON.stringify(family),
    },
    '../attachments/imageHeader': { inspectImageHeader },
    '../core/transactionContext': { validatePhotoRef() {} },
    './hash': { sha256Hex },
  });
  return { service: module.createBackupFileServices(), calls, dirs, manager };
}
test('temporary creation failure closes its draft and never deletes a pre-existing directory', async () => {
  const f = fixture({ createFails: true, existingDirectory: true });
  await assert.rejects(
    f.service.stage(
      family,
      {},
      'new-owner',
      [],
      async () => new Uint8Array(),
      () => {},
    ),
  );
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.dispose, 1);
  assert.equal(f.calls.directoryDelete, 0);
  assert.equal(f.dirs[0].exists, true);
});
test('photo manager initialization failure still disposes the owned binding', async () => {
  const f = fixture({ initializeFails: true });
  await assert.rejects(
    f.service.stage(
      family,
      {},
      'new-owner',
      [],
      async () => new Uint8Array(),
      () => {},
    ),
  );
  assert.equal(f.calls.dispose, 1);
  assert.equal(f.calls.begin, 0);
});
test('failed copy carries pending owned cleanup to the coordinator even without a returned stage handle', async () => {
  const f = fixture({ closePending: true }),
    bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png')));
  await assert.rejects(
    f.service.stage(
      family,
      {},
      'new-owner',
      [{ sha256: sha256Hex(bytes), mimeType: 'image/png', byteSize: bytes.length }],
      async () => bytes,
      () => {},
    ),
    (error) => error.cleanupPending === true && /cleanup pending/.test(error.cleanupMessage),
  );
  assert.equal(f.calls.stage, 1);
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.dispose, 1);
  assert.equal(f.calls.directoryDelete, 1);
});
test('successful preparation returns idempotent cleanup and preserves pending temporary-delete recovery', async () => {
  const options = { deleteFails: true },
    f = fixture(options);
  const staged = await f.service.stage(
    family,
    {},
    'new-owner',
    [],
    async () => new Uint8Array(),
    () => {},
  );
  const first = await staged.close(),
    second = await staged.close();
  assert.equal(first.pending, true);
  assert.equal(second, first);
  assert.equal(f.calls.close, 1);
  options.deleteFails = false;
  assert.equal((await f.service.retryCleanup(family, {})).pending, false);
  assert.equal(f.dirs[0].exists, false);
});

test('denied temporary directory reads remain pending even when native exists reports false', async () => {
  const options = { directoryInfoDenied: true },
    f = fixture(options);
  const staged = await f.service.stage(
    family,
    {},
    'new-owner',
    [],
    async () => new Uint8Array(),
    () => {},
  );
  assert.equal(f.dirs[0].exists, false, 'The installed native exists getter hides denied access.');
  assert.equal(f.dirs[0].present, true);
  const closed = await staged.close();
  assert.equal(closed.pending, true);
  assert.equal(f.calls.directoryDelete, 0);
  assert.equal((await f.service.retryCleanup(family, {})).pending, true);
  assert.equal(f.dirs[0].present, true);
  options.directoryInfoDenied = false;
  assert.equal((await f.service.retryCleanup(family, {})).pending, false);
  assert.equal(f.calls.directoryDelete, 1);
  assert.equal(f.dirs[0].present, false);
});

test('temporary cleanup is not confirmed until a post-delete read establishes absence', async () => {
  const options = { silentDirectoryDelete: true },
    f = fixture(options);
  const staged = await f.service.stage(
    family,
    {},
    'new-owner',
    [],
    async () => new Uint8Array(),
    () => {},
  );
  assert.equal((await staged.close()).pending, true);
  assert.equal(f.calls.directoryDelete, 1);
  assert.equal(f.dirs[0].present, true);
  assert.equal((await f.service.retryCleanup(family, {})).pending, true);
  options.silentDirectoryDelete = false;
  assert.equal((await f.service.retryCleanup(family, {})).pending, false);
  assert.equal(f.dirs[0].present, false);
});

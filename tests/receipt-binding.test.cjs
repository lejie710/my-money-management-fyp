const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const {
  hostWithStores,
  loadSource,
  ledger,
  owner: owners,
} = require('./helpers/account-hook-harness.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const familyToken = (owner) => JSON.stringify([owner.scope, owner.actor]);
function host() {
  const value = hostWithStores();
  value.react.useLayoutEffect = value.react.useEffect;
  return value;
}
function connectionFixture() {
  const h = host(),
    reads = [],
    clients = [];
  const read = () => {
    const pending = deferred();
    reads.push(pending);
    return pending.promise;
  };
  const module = loadSource(
    path.join(__dirname, '../src/ui/useCompanionConnection.ts'),
    {
      react: h.react,
      '../companion/expoConnection': { readPrivateCompanionConnection: read },
      '../assistant/client':{createAssistantClient(){return{complete:async()=>{throw Error('No request expected during local file read');}};}},
      '../receipts/client': {
        createReceiptClient(configuration) {
          clients.push(configuration);
          return {
            recognize() {
              throw Error('No request expected during local file read');
            },
          };
        },
      },
    },
    { __DEV__: true, process: { env: {} } },
  );
  const props = { enabled: true, read };
  const render = () => h.render(() => module.useCompanionConnection(props));
  const configuration = {
    version: 1,
    runId: 'synthetic-run',
    url: 'http://127.0.0.1:8787/v1/recognize',
    token: 'x'.repeat(43),
  };
  return { h, reads, clients, props, render, configuration };
}
test('connection file read never contacts OCR and only configured copy is shown', async () => {
  const f = connectionFixture();
  assert.equal(f.render().phase, 'checking');
  f.reads[0].resolve(f.configuration);
  await flush();
  const view = f.render();
  assert.equal(view.phase, 'configured');
  assert.match(view.message, /Availability is checked/);
  assert.equal(f.clients.length, 1);
  assert.equal(JSON.stringify(view).includes(f.configuration.token), false);
  f.h.unmount();
});
test('explicit connection recheck invalidates old binding synchronously and joins duplicate clicks', async () => {
  const f = connectionFixture();
  f.render();
  f.reads[0].resolve(f.configuration);
  await flush();
  const old = f.render(),
    binding = old.binding;
  const work = old.recheck();
  assert.equal(old.getCurrent().binding, null);
  assert.equal(old.getCurrent().phase, 'checking');
  await old.recheck();
  assert.equal(f.reads.length, 2);
  f.reads[1].resolve(f.configuration);
  await work;
  assert.notEqual(f.render().binding, binding);
  f.h.unmount();
});
test('reader replacement ignores late old bytes and stale recheck cannot call new or old reader', async () => {
  const f = connectionFixture(),
    old = f.render(),
    next = deferred();
  let nextReads = 0;
  f.props.read = () => {
    nextReads++;
    return next.promise;
  };
  f.render();
  await old.recheck();
  assert.equal(f.reads.length, 1);
  assert.equal(nextReads, 1);
  f.reads[0].resolve(f.configuration);
  await flush();
  assert.equal(f.render().phase, 'checking');
  next.resolve(null);
  await flush();
  assert.equal(f.render().phase, 'not-configured');
  assert.equal(f.clients.length, 0);
  f.h.unmount();
});
test('disabled builds do not read, and StrictMode restoration cannot publish its first result', async () => {
  const f = connectionFixture();
  f.props.enabled = false;
  assert.equal(f.render().phase, 'disabled');
  assert.equal(f.reads.length, 0);
  f.props.enabled = true;
  f.render();
  f.h.replayEffects();
  assert.equal(f.reads.length, 2);
  f.reads[0].resolve(f.configuration);
  await flush();
  assert.equal(f.render().phase, 'checking');
  f.reads[1].reject(Error('Private raw payload must not be shown'));
  await flush();
  assert.equal(f.render().phase, 'unavailable');
  assert.doesNotMatch(f.render().message, /payload/);
  f.h.unmount();
});
function sessionFixture() {
  const h = host(),
    managers = [],
    photoMessages = [];
  let factoryError = false;
  const create = (options) => {
    if (factoryError) throw Error('Synthetic unavailable files');
    const manager = {
      options,
      ownerToken: owners.encodeReminderOwner(options.owner),
      familyToken: familyToken(options.owner),
      cameraAvailable: true,
      pending: false,
      closed: 0,
      retried: 0,
      picked: 0,
      async close() {
        this.closed++;
        return { pending: this.pending };
      },
      async retryCleanup() {
        this.retried++;
        if (this.check) await this.check();
        return { pending: this.pending };
      },
      async pickPhoto() {
        this.picked++;
        return null;
      },
      async takePhoto() {
        this.picked++;
        return null;
      },
      async readBytes() {
        return new Uint8Array([1]);
      },
      async release() {
        if (this.releaseFailure) throw Error('Synthetic release failure');
      },
    };
    managers.push(manager);
    return manager;
  };
  const module = loadSource(
    path.join(__dirname, '../src/ui/useReceiptSession.ts'),
    {
      react: h.react,
      '@react-native-async-storage/async-storage': {},
      '../reminders/store': owners,
      '../receipts/expoCapture': { createExpoReceiptCapture: create },
      '../receipts/captureManager': { receiptCaptureFamilyToken: familyToken },
    },
    { process: { env: {} } },
  );
  let currentConnection = {
    phase: 'configured',
    revision: 1,
    binding: { receipt: { recognize: async () => {} } },
  };
  const connection = {
    ...currentConnection,
    enabled: true,
    message: 'Configured',
    getCurrent: () => currentConnection,
    recheck: async () => {},
  };
  const data = ledger('A', 'same-incarnation');
  const props = {
    ledger: data,
    owner: {
      scope: { kind: 'test', namespace: 'receipt-test' },
      actor: { kind: 'firebase', uid: 'A' },
      incarnationId: data.wallet.incarnationId,
    },
    active: true,
    visible: true,
    photos: {},
    connection,
    getToday: () => '2026-10-18',
    onPhotoCleanupMessage: (...args) => photoMessages.push(args),
    cameraEnabled: false,
  };
  const render = () => h.render(() => module.useReceiptSession(props));
  return {
    h,
    managers,
    props,
    photoMessages,
    render,
    setFactoryError: (v) => {
      factoryError = v;
    },
    changeConnection() {
      currentConnection = {
        ...currentConnection,
        revision: currentConnection.revision + 1,
        binding: null,
        phase: 'checking',
      };
    },
    syncConnection() {
      props.connection = { ...props.connection, ...currentConnection };
    },
    open() {
      render().open();
      return render();
    },
  };
}
test('one full-owner receipt draft is opened, default camera stays disabled, normal saves preserve the session', async () => {
  const f = sessionFixture(),
    view = f.open(),
    session = view.session;
  assert.ok(session);
  assert.equal(session.ownerToken, owners.encodeReminderOwner(f.props.owner));
  assert.equal(session.binding.capture.cameraAvailable, false);
  await assert.rejects(session.binding.capture.takePhoto(), /unavailable/);
  const count = f.managers.length;
  view.open();
  assert.equal(f.managers.length, count);
  f.props.ledger = { ...f.props.ledger, transactions: [] };
  assert.equal(f.render().session.sessionKey, session.sessionKey);
  f.h.unmount();
  await flush();
});
test('synchronous connection invalidation prevents use before React rerenders; revision then aborts the session', async () => {
  const f = sessionFixture(),
    view = f.open(),
    session = view.session;
  let closed = 0;
  session.binding.attachLifecycle(async () => {
    closed++;
  });
  f.changeConnection();
  assert.equal(session.binding.isCurrent(), false);
  f.syncConnection();
  assert.equal(f.render().session, null);
  assert.equal(closed, 1);
  assert.equal(f.render().hasOpenDraft(), false);
  f.h.unmount();
  await flush();
});
test('same-incarnation actor replacement retires old capture and old close callback cannot close successor', async () => {
  const f = sessionFixture(),
    old = f.open();
  const oldManager = old.session.capture;
  f.props.owner = { ...f.props.owner, actor: { kind: 'firebase', uid: 'B' } };
  assert.equal(f.render().session, null);
  assert.equal(oldManager.closed, 1);
  const next = f.open();
  assert.notEqual(next.session.sessionKey, old.session.sessionKey);
  await old.closeCurrent();
  assert.ok(f.render().session);
  assert.equal(old.session.binding.isCurrent(), false);
  old.session.binding.onPhotoCleanupMessage('old-owner');
  assert.equal(f.photoMessages.length, 0);
  f.h.unmount();
  await flush();
});
test('hidden account recovery keeps a synchronous draft blocker until explicit discard, then aborts before awaiting cleanup', async () => {
  const f = sessionFixture(),
    view = f.open(),
    drain = deferred();
  let aborted = false;
  view.session.binding.attachLifecycle(() => {
    aborted = true;
    return drain.promise;
  });
  f.props.visible = false;
  const hidden = f.render();
  assert.equal(hidden.session, null);
  assert.equal(hidden.hasOpenDraft(), true);
  const closing = hidden.close();
  assert.equal(aborted, true);
  assert.equal(hidden.hasOpenDraft(), false);
  let settled = false;
  closing.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  drain.resolve();
  await closing;
  f.h.unmount();
  await flush();
});
test('temporary cleanup uncertainty is visible and only explicit same-family retry clears it', async () => {
  const f = sessionFixture(),
    view = f.open(),
    manager = view.session.capture;
  await flush();
  manager.pending = true;
  await view.close();
  assert.equal(f.render().cleanupPending, true);
  manager.pending = false;
  await f.render().retryCleanup();
  assert.equal(f.render().cleanupPending, false);
  assert.ok(manager.retried >= 2);
  f.h.unmount();
  await flush();
});
test('failed cleanup construction has a reachable retry, and old-family failure cannot overwrite current status', async () => {
  const f = sessionFixture();
  f.setFactoryError(true);
  assert.equal(f.render().cleanupPending, true);
  f.setFactoryError(false);
  await f.render().retryCleanup();
  assert.equal(f.render().cleanupPending, false);
  const old = f.open(),
    manager = old.session.capture,
    pending = deferred();
  manager.check = () => pending.promise;
  manager.pending = true;
  const closing = old.close();
  f.props.owner = { ...f.props.owner, actor: { kind: 'firebase', uid: 'B' } };
  f.render();
  await flush();
  pending.resolve();
  await closing;
  assert.equal(f.render().cleanupPending, false);
  f.h.unmount();
  await flush();
});
test('StrictMode replay closes an active capture once and permits a fresh session without reviving stale callbacks', async () => {
  const f = sessionFixture(),
    old = f.open(),
    manager = old.session.capture;
  let closed = 0;
  old.session.binding.attachLifecycle(async () => {
    closed++;
  });
  f.h.replayEffects();
  await flush();
  assert.equal(f.render().session, null);
  assert.equal(manager.closed, 1);
  assert.equal(closed, 1);
  f.open();
  assert.ok(f.render().session);
  await old.closeCurrent();
  assert.ok(f.render().session);
  f.h.unmount();
  await flush();
});

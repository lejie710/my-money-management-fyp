const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { fixture } = require('./helpers/account-bridge-harness.cjs');
const { hostWithStores, loadSource } = require('./helpers/account-hook-harness.cjs');
const identity = require('../src/accounts/identity');
function rootHost(f) {
  const originalBind = f.runtime.bridge.bind;
  let rendering = false,
    rootCallbacks = null;
  // The bridge fixture synchronously republishes finance during lease changes.
  // Keep the actual root callback projections while those store fields refresh.
  f.runtime.bridge.bind = (value) => {
    if (rendering)
      rootCallbacks = {
        hasOpenEditor: value.hasOpenEditor,
        closeEditor: value.closeEditor,
        closeExports: value.closeExports,
      };
    return originalBind({ ...value, ...rootCallbacks });
  };
  const host = hostWithStores();
  host.react.useLayoutEffect = host.react.useEffect;
  const accountView = loadSource(path.join(__dirname, '../src/ui/useAccountView.ts'), {
    react: host.react,
  });
  const gate = loadSource(path.join(__dirname, '../src/ui/AccountAccessGate.tsx'), {
    react: host.react,
    'react-native': {},
    './components': {},
    './theme': require('./helpers/theme-stub.cjs').themeStub,
  });
  let assistantClosed = 0;
  const assistant = {
    close() {
      assistantClosed++;
    },
  };
  const exportBindings = [],
    receiptBindings = [];
  let receiptOpen = false,
    receiptClosed = 0;
  const receipts = {
    hasOpenDraft: () => receiptOpen,
    close() {
      receiptOpen = false;
      receiptClosed++;
      return Promise.resolve();
    },
  };
  const module = loadSource(path.join(__dirname, '../src/ui/useAccountRoot.ts'), {
    react: host.react,
    'react-native': { AppState: { addEventListener: () => ({ remove() {} }) } },
    '../accounts/appRuntime': { getAccountAppRuntime: () => f.runtime },
    '../accounts/identity': identity,
    './useLedger': { useLedger: () => f.binding.ledger },
    './useWalletPhotos': { useWalletPhotos: () => f.binding.photos },
    './useWalletReminders': { useWalletReminders: () => f.binding.reminders },
    './useExportSession': {
      useExportSession(options) {
        exportBindings.push(options);
        return { close() {} };
      },
    },
    '../services/useServiceConnection': {
      useServiceConnection: () => ({ phase: 'disabled', source: 'local' }),
    },
    './useCloudWallet': {
      useCloudWallet: () => ({
        controller: null,
        state: { configured: false, signedIn: false, readOnly: true },
      }),
    },
    './useReceiptSession': {
      useReceiptSession(options) {
        receiptBindings.push(options);
        return receipts;
      },
    },
    './useAssistantSession': { useAssistantSession: () => assistant },
    './useAccountView': accountView,
    './AccountAccessGate': gate,
  });
  return {
    host,
    exportBindings,
    receiptBindings,
    setReceiptOpen(value) {
      receiptOpen = value;
    },
    get assistantClosed() {
      return assistantClosed;
    },
    get receiptClosed() {
      return receiptClosed;
    },
    render: () => {
      rendering = true;
      try {
        return host.render(() =>
          module.useAccountRoot({
            runtime: f.runtime,
            hasOpenEditor: () => false,
            closeEditor() {},
            onReminderOpen() {},
          }),
        );
      } finally {
        rendering = false;
      }
    },
  };
}
test('a remounted root masks a previously ready account until this mount confirms identity again', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  await f.signIn('A');
  const h = rootHost(f),
    initial = h.render();
  assert.equal(initial.financialAllowed, false);
  assert.equal(initial.gateState.phase, 'restoring');
  await f.runtime.initializeView();
  await Promise.resolve();
  const ready = h.render();
  assert.equal(ready.financialAllowed, true);
  assert.equal(ready.accountState.user.uid, 'A');
  assert.equal(f.mutations, 1);
  h.host.unmount();
});
test('the export owner is always the active ledger actor and exports remain disabled during mount restoration', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  await f.signIn('A');
  const h = rootHost(f);
  h.render();
  assert.equal(h.exportBindings[0].owner.actor.uid, 'A');
  assert.equal(h.exportBindings[0].active, false);
  await f.runtime.initializeView();
  await Promise.resolve();
  h.render();
  assert.equal(h.exportBindings.at(-1).owner.actor.uid, 'A');
  assert.equal(h.exportBindings.at(-1).active, true);
  h.host.unmount();
});
test('root StrictMode initialization replay joins pending restoration and cannot expose ready state early', async () => {
  const f = fixture();
  const h = rootHost(f);
  h.render();
  h.host.replayEffects();
  assert.equal(h.render().financialAllowed, false);
  await f.runtime.initializeView();
  await Promise.resolve();
  assert.equal(h.render().financialAllowed, true);
  assert.equal(f.log.filter((item) => item === 'sdk-initialize').length, 1);
  assert.equal(f.mutations, 0);
  h.host.unmount();
});

test('real account bridge reads the root receipt draft blocker before acquiring an identity lease', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  const h = rootHost(f);
  h.render();
  await f.runtime.initializeView();
  await Promise.resolve();
  h.render();
  h.setReceiptOpen(true);
  const before = f.mutations;
  const result = await f.runtime.bridge.financial.prepareIdentityChange({
    activeOwnerToken: f.controller.getIdentityState().ownerToken,
  });
  assert.equal(result.ok, false);
  assert.equal(f.mutations, before);
  assert.equal(f.runtime.bridge.hasHeldLease(), false);
  h.setReceiptOpen(false);
  h.render();
  const next = await f.runtime.bridge.financial.prepareIdentityChange({
    activeOwnerToken: f.controller.getIdentityState().ownerToken,
  });
  assert.equal(next.ok, true);
  assert.equal(f.mutations, before);
  h.host.unmount();
});
test('root binds receipts to exact actor and hides presentation during remount restoration', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  await f.signIn('A');
  const h = rootHost(f);
  h.render();
  assert.equal(h.receiptBindings.at(-1).owner.actor.uid, 'A');
  assert.equal(h.receiptBindings.at(-1).visible, false);
  await f.runtime.initializeView();
  await Promise.resolve();
  h.render();
  assert.equal(h.receiptBindings.at(-1).visible, true);
  h.host.unmount();
});

test('read-only chat never blocks identity lease and financial bridge closes it synchronously before mutation readiness', async () => {
  const f = fixture();
  await f.runtime.initializeView();
  const h = rootHost(f);
  h.render();
  await f.runtime.initializeView();
  await Promise.resolve();
  h.render();
  const before = h.assistantClosed;
  const result = await f.runtime.bridge.financial.prepareIdentityChange({
    activeOwnerToken: f.controller.getIdentityState().ownerToken,
  });
  assert.equal(result.ok, true);
  assert.ok(h.assistantClosed > before);
  assert.equal(f.mutations, 0);
  h.host.unmount();
});

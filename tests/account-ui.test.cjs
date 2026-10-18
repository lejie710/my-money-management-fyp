const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const { createHookHost } = require('./helpers/hook-host.cjs');
const { deferred } = require('./helpers/native-adapter-vm.cjs');
const model = require('../src/core/model');
function state(overrides = {}) {
  return {
    viewToken: 'test/guest/session-1',
    provider: 'configured',
    phase: 'ready',
    user: null,
    persistence: 'confirmed',
    activeOwnerToken: 'guest-wallet',
    sessionRestored: false,
    service: 'available',
    busy: false,
    operation: null,
    message: '',
    error: '',
    blockedReason: '',
    canSignIn: true,
    canRegister: true,
    canSignOut: false,
    canEditProfile: false,
    canSaveLocalProfile: false,
    canRequestReset: true,
    canRetry: false,
    today: '2026-10-18',
    profile: { phase: 'ready', extras: null, displayNamePending: false, error: '' },
    ...overrides,
  };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of (tree.props?.children ?? []).flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}
const byId = (tree, id) => find(tree, (item) => item.props?.testID === id);

function accountPage(overrides = {}) {
  const h = harness(),
    current = state(overrides);
  const controller = { createResetSession: () => ({ close() {} }) };
  const { AccountScreen } = h.load('AccountScreen.tsx', {
    './useAccountView': { ...h.hooks, useAccountView: () => current },
    './AccountCredentialsForm': { AccountCredentialsForm: 'AccountCredentialsForm' },
    './AccountProfileForm': { AccountProfileForm: 'AccountProfileForm' },
    './LocalResetForm': { LocalResetForm: 'LocalResetForm' },
  });
  const render = () =>
    h.host.render(() => {
      const content = AccountScreen({ controller, onBack() {} });
      return content.type(content.props);
    });
  return { h, current, controller, render };
}

test('account parent feedback stays off credential/profile/reset routes so stale sign-in feedback is not repeated', () => {
  const f = accountPage({ error: 'Wrong password', message: 'Wrong password' });
  let tree = f.render();
  assert.equal(byId(tree, 'account-status-error').props.message, 'Wrong password');
  assert.equal(byId(tree, 'account-transition-status'), null);
  byId(tree, 'account-sign-in').props.onPress();
  tree = f.render();
  const credentials = find(tree, (node) => node.type === 'AccountCredentialsForm');
  assert.ok(credentials);
  assert.equal(credentials.props.state.error, 'Wrong password');
  assert.equal(byId(tree, 'account-status-error'), null);
  assert.equal(byId(tree, 'account-transition-status'), null);
  credentials.props.onReset();
  tree = f.render();
  assert.ok(find(tree, (node) => node.type === 'LocalResetForm'));
  assert.equal(byId(tree, 'account-status-error'), null);
  assert.equal(byId(tree, 'account-transition-status'), null);
  find(tree, (node) => node.type === 'LocalResetForm').props.onBack();
  f.current.user = { uid: 'A', email: 'a@example.test', displayName: 'A' };
  f.current.canEditProfile = true;
  tree = f.render();
  byId(tree, 'account-edit-profile').props.onPress();
  tree = f.render();
  assert.ok(find(tree, (node) => node.type === 'AccountProfileForm'));
  assert.equal(byId(tree, 'account-status-error'), null);
  f.h.host.unmount();
});

test('unconfigured account setup explains local access without dead sign-in controls and preserves recovery', () => {
  const f = accountPage({
    provider: 'unconfigured',
    canSignIn: false,
    canRegister: false,
    canRequestReset: false,
  });
  let tree = f.render();
  assert.ok(byId(tree, 'account-setup-help'));
  assert.equal(byId(tree, 'account-sign-in'), null);
  assert.equal(byId(tree, 'account-create'), null);
  assert.ok(byId(tree, 'account-back'));
  f.current.canRetry = true;
  f.current.error = 'The saved session needs another check.';
  tree = f.render();
  assert.ok(byId(tree, 'account-retry'));
  assert.equal(byId(tree, 'account-status-error').props.message, f.current.error);
  f.h.host.unmount();
});

test('reset-session creation failure returns home with its own error and sign-out retains relevant account feedback', () => {
  const f = accountPage({ message: 'Old sign-in response' });
  f.controller.createResetSession = () => {
    throw Error('private failure');
  };
  let tree = f.render();
  byId(tree, 'account-sign-in').props.onPress();
  tree = f.render();
  find(tree, (node) => node.type === 'AccountCredentialsForm').props.onReset();
  tree = f.render();
  assert.ok(byId(tree, 'account-back'));
  assert.match(
    byId(tree, 'account-status-error').props.message,
    /local reset inbox is unavailable/,
  );
  assert.equal(byId(tree, 'account-transition-status'), null);
  f.h.host.unmount();
  const out = accountPage({
    user: { uid: 'A', email: 'a@example.test', displayName: 'A' },
    canSignOut: true,
    error: 'Saved operation needs recheck',
  });
  tree = out.render();
  byId(tree, 'account-sign-out').props.onPress();
  tree = out.render();
  assert.ok(byId(tree, 'account-sign-out-confirm'));
  assert.equal(byId(tree, 'account-status-error').props.message, 'Saved operation needs recheck');
  out.h.host.unmount();
});
function harness() {
  const host = createHookHost(),
    timers = new Map();
  let nextTimer = 0;
  host.react.useLayoutEffect = host.react.useEffect;
  host.react.useMemo = (factory, deps) => {
    const ref = host.react.useRef(null);
    if (!ref.current || deps.some((value, i) => !Object.is(value, ref.current.deps[i])))
      ref.current = { deps, value: factory() };
    return ref.current.value;
  };
  host.react.useSyncExternalStore = (subscribe, getSnapshot) => {
    host.react.useEffect(() => subscribe(() => {}), [subscribe]);
    return getSnapshot();
  };
  function load(name, imports = {}) {
    const source = ts.transpileModule(
      fs.readFileSync(path.join(__dirname, '../src/ui', name), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.React,
          esModuleInterop: true,
        },
      },
    ).outputText;
    const module = { exports: {} };
    const modules = {
      react: host.react,
      'react-native': { Text: 'Text', View: 'View', ActivityIndicator: 'ActivityIndicator' },
      './components': {
        Action: 'Action',
        RowAction: 'RowAction',
        Field: 'Field',
        Choice: 'Choice',
        FormError: 'FormError',
        Screen: 'Screen',
      },
      './theme': { ui: {}, colors: {} },
      '../core/model': model,
      ...imports,
    };
    vm.runInNewContext(source, {
      exports: module.exports,
      require(name) {
        if (!Object.hasOwn(modules, name)) throw Error(`Unexpected account UI dependency ${name}`);
        return modules[name];
      },
      setTimeout(callback) {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    });
    return module.exports;
  }
  const hooks = load('useAccountView.ts');
  return {
    host,
    hooks,
    load: (name, imports) => load(name, { './useAccountView': hooks, ...imports }),
    fireTimers() {
      for (const [id, callback] of timers) {
        timers.delete(id);
        callback();
      }
    },
    timers,
  };
}

test('financial access gate requires confirmed persistence and the exact active owner, including for guest', () => {
  const h = harness(),
    { AccountAccessGate, canShowAccountWallet } = h.load('AccountAccessGate.tsx');
  const child = { type: 'FinancialRecords', props: {} };
  assert.equal(canShowAccountWallet(state(), 'guest-wallet'), true);
  assert.equal(canShowAccountWallet(state({ provider: 'unconfigured' }), 'guest-wallet'), true);
  for (const current of [
    state({ persistence: 'unconfirmed' }),
    state({ phase: 'restoring' }),
    state({
      phase: 'wallet-unavailable',
      user: { uid: 'B', email: 'b@example.test', displayName: null },
    }),
    state({ activeOwnerToken: 'account-B' }),
  ]) {
    assert.equal(canShowAccountWallet(current, 'guest-wallet'), false);
    const tree = AccountAccessGate({
      state: current,
      renderedOwnerToken: 'guest-wallet',
      onRetry() {},
      children: child,
    });
    assert.equal(
      find(tree, (item) => item.type === 'FinancialRecords'),
      null,
    );
  }
});

test('view subscription never initializes or mutates Auth, and duplicate operations are guarded', async () => {
  const h = harness();
  let subscribes = 0,
    calls = 0;
  const controller = {
    getSnapshot: () => state(),
    subscribe() {
      subscribes++;
      return () => {};
    },
    initialize() {
      throw Error('UI must not initialize Auth');
    },
  };
  h.host.render(() => h.hooks.useAccountView(controller));
  assert.equal(subscribes, 1);
  const second = harness(),
    work = deferred();
  const render = () => second.host.render(() => second.hooks.useAccountOperation('owner-one'));
  const op = render(),
    pending = op.run(() => {
      calls++;
      return work.promise;
    });
  assert.equal(
    await op.run(() => {
      calls++;
      return work.promise;
    }),
    null,
  );
  assert.equal(calls, 1);
  work.resolve({ ok: false, pending: true, message: 'Saved session uncertain' });
  await pending;
  assert.equal(render().result.pending, true);
});

test('late Auth results cannot update a new owner view or report its operation as complete', async () => {
  const h = harness(),
    work = deferred();
  let token = 'owner-A';
  const render = () => h.host.render(() => h.hooks.useAccountOperation(token));
  const pending = render().run(() => work.promise);
  token = 'owner-B';
  render();
  work.resolve({ ok: true, pending: false, message: 'A signed in' });
  assert.equal(await pending, null);
  assert.equal(render().result, null);
  assert.equal(render().busy, false);
});

test('a retained account action cannot dispatch work into a replacement owner session', async () => {
  const h = harness();
  let token = 'owner-A',
    calls = 0;
  const render = () => h.host.render(() => h.hooks.useAccountOperation(token));
  const old = render();
  token = 'owner-B';
  render();
  assert.equal(
    await old.run(async () => {
      calls++;
      return { ok: true, pending: false, message: '' };
    }),
    null,
  );
  assert.equal(calls, 0);
});

test('registration sends exact password characters, trims email/name, and has no demographic defaults', async () => {
  const h = harness(),
    calls = [];
  const { AccountCredentialsForm } = h.load('AccountCredentialsForm.tsx');
  const controller = {
    async register(input) {
      calls.push(input);
      return { ok: false, pending: false, message: 'Synthetic validation response' };
    },
  };
  const current = state();
  const render = () =>
    h.host.render(() =>
      AccountCredentialsForm({
        mode: 'register',
        controller,
        state: current,
        onBack() {},
        onReset() {},
      }),
    );
  let tree = render();
  assert.equal(byId(tree, 'profile-birthdate'), null);
  assert.equal(byId(tree, 'profile-gender'), null);
  const password = '  synthetic test value  ';
  byId(tree, 'account-name').props.onChangeText('  Display name  ');
  tree = render();
  byId(tree, 'account-email').props.onChangeText('  synthetic@example.test  ');
  tree = render();
  byId(tree, 'account-password').props.onChangeText(password);
  tree = render();
  byId(tree, 'account-password-confirm').props.onChangeText(password);
  tree = render();
  byId(tree, 'account-submit').props.onPress();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].email, 'synthetic@example.test');
  assert.equal(calls[0].displayName, 'Display name');
  assert.equal(calls[0].password, password);
});

test('profile waits for saved extras, restores their actual values, and does not invent a birthday', () => {
  const h = harness(),
    { AccountProfileForm } = h.load('AccountProfileForm.tsx');
  const current = state({
    canEditProfile: true,
    canSaveLocalProfile: true,
    user: { uid: 'A', email: 'a@example.test', displayName: 'A' },
    profile: { phase: 'loading', extras: null, displayNamePending: false, error: '' },
  });
  const calls = [];
  const controller = {
    async saveLocalProfile(input) {
      calls.push(input);
      return { ok: true, pending: false, message: 'Saved' };
    },
  };
  const render = () =>
    h.host.render(() => AccountProfileForm({ controller, state: current, onBack() {} }));
  assert.equal(byId(render(), 'profile-birthdate'), null);
  current.profile = { phase: 'ready', extras: null, displayNamePending: false, error: '' };
  let tree = render();
  assert.equal(byId(tree, 'profile-birthdate').props.value, '');
  assert.equal(byId(tree, 'profile-gender-unset').props.selected, true);
  assert.equal(calls.length, 0);
  byId(tree, 'profile-birthdate').props.onChangeText('2099-01-01');
  tree = render();
  byId(tree, 'profile-save-local').props.onPress();
  tree = render();
  assert.match(byId(tree, 'profile-error').props.message, /no later than today/);
  assert.equal(calls.length, 0);
  current.profile = {
    phase: 'unavailable',
    extras: null,
    displayNamePending: false,
    error: 'Read uncertain',
  };
  render();
  current.profile = {
    phase: 'ready',
    extras: { gender: 'female', birthDate: '2000-01-02' },
    displayNamePending: false,
    error: '',
  };
  tree = render();
  assert.equal(byId(tree, 'profile-birthdate').props.value, '2000-01-02');
  assert.equal(byId(tree, 'profile-gender-female').props.selected, true);
});

test('local reset hides a previous address message after email edits and Strict Mode does not prematurely close its session', () => {
  const h = harness(),
    { LocalResetForm } = h.load('LocalResetForm.tsx');
  let closed = 0;
  const reset = {
    phase: 'verified',
    email: 'a@example.test',
    messageAvailable: true,
    message: 'Verified locally',
    error: '',
    busy: false,
    canRequest: true,
    canRefresh: true,
    canVerify: false,
    canConfirm: true,
  };
  const controller = {
    getSnapshot: () => reset,
    subscribe: () => () => {},
    close() {
      closed++;
    },
  };
  const render = () =>
    h.host.render(() =>
      LocalResetForm({ controller, viewToken: 'guest/reset', onBack() {}, onSignIn() {} }),
    );
  let tree = render();
  h.host.replayEffects();
  h.fireTimers();
  assert.equal(closed, 0);
  byId(tree, 'reset-email').props.onChangeText('a@example.test');
  tree = render();
  assert.ok(byId(tree, 'reset-message'));
  assert.ok(byId(tree, 'reset-password'));
  byId(tree, 'reset-email').props.onChangeText('b@example.test');
  tree = render();
  assert.equal(byId(tree, 'reset-message'), null);
  assert.equal(byId(tree, 'reset-password'), null);
  assert.equal(byId(tree, 'reset-open-message'), null);
  h.host.unmount();
  h.fireTimers();
  assert.equal(closed, 1);
});

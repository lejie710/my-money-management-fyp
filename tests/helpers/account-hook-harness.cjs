const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  ts = require('typescript');
const { createHookHost } = require('./hook-host.cjs');
const model = require('../../src/core/model'),
  storageCore = require('../../src/core/storage'),
  achievements = require('../../src/core/achievements'),
  commit = require('../../src/core/commitLedger'),
  identity = require('../../src/accounts/identity'),
  owner = require('../../src/reminders/store');
const clock = () => ({ today: '2026-10-18', nowMs: Date.UTC(2026, 9, 18, 4) });
const clone = (value) => JSON.parse(JSON.stringify(value));
function ledger(name = 'A', incarnation = 'shared-incarnation') {
  return model.createEmptyLedger({ name }, { clock: clock(), newIncarnationId: () => incarnation });
}
function store(initial = null) {
  let data = initial ? clone(initial) : null;
  const calls = { load: 0, read: 0, save: 0 };
  const faults = { beforeSave: null, afterSave: null, read: null };
  return {
    key: 'synthetic-store',
    calls,
    faults,
    get data() {
      return data ? clone(data) : null;
    },
    set data(value) {
      data = clone(value);
    },
    async load() {
      calls.load++;
      return data ? clone(data) : null;
    },
    async readCurrent() {
      calls.read++;
      if (faults.read) await faults.read();
      return data ? clone(data) : null;
    },
    async save(value) {
      calls.save++;
      if (faults.beforeSave) await faults.beforeSave();
      data = clone(value);
      if (faults.afterSave) await faults.afterSave();
      return clone(data);
    },
    async withRetainedPhotoReferences(work) {
      return work({ complete: true, references: [] });
    },
  };
}
function hostWithStores() {
  const host = createHookHost();
  host.react.useMemo = (factory, deps) => {
    const ref = host.react.useRef(null);
    if (!ref.current || deps.some((value, index) => !Object.is(value, ref.current.deps[index])))
      ref.current = { deps, value: factory() };
    return ref.current.value;
  };
  host.react.useSyncExternalStore = (subscribe, getSnapshot) => {
    host.react.useEffect(() => subscribe(() => {}), [subscribe]);
    return getSnapshot();
  };
  return host;
}
function loadSource(file, imports, extras = {}) {
  const text = fs.readFileSync(file, 'utf8'),
    source =
      file.endsWith('.ts') || file.endsWith('.tsx')
        ? ts.transpileModule(text, {
            fileName: file,
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2022,
              jsx: ts.JsxEmit.React,
              esModuleInterop: true,
            },
          }).outputText
        : text;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require(name) {
      if (!Object.hasOwn(imports, name)) throw Error(`Unexpected staged hook dependency ${name}`);
      return imports[name];
    },
    ...extras,
  });
  return module.exports;
}
function ledgerFixture({ initial = ledger(), defer = true, autoDefault = false } = {}) {
  let host = hostWithStores();
  const bytes = new Map(),
    storage = store(initial),
    namespace = 'account-hook-test';
  const asyncStorage = {
    async getItem(key) {
      return bytes.get(key) ?? null;
    },
    async setItem(key, value) {
      bytes.set(key, value);
    },
  };
  const runtime = loadSource(path.join(__dirname, '../../src/ui/ledgerRuntime.js'), {
    '../core/model': model,
    '../core/storage': storageCore,
    '../core/achievements': achievements,
    '../core/commitLedger': commit,
    '../reminders/store': owner,
    '../accounts/identity': identity,
  });
  const loadHook = () =>
    loadSource(
      path.join(__dirname, '../../src/ui/useLedger.ts'),
      {
        react: host.react,
        '@react-native-async-storage/async-storage': asyncStorage,
        '../core/model': model,
        '../core/storage': storageCore,
        '../core/achievements': achievements,
        '../verification/fixtures': {
          validateTestScenario: () => null,
          verificationClock: () => null,
          createVerificationLedger: () => {
            throw Error('No fixture scenario expected');
          },
        },
        '../accounts/identity': identity,
        './ledgerRuntime': runtime,
      },
      { process: { env: { EXPO_PUBLIC_TEST_DATA_NAMESPACE: namespace } }, console: { info() {} } },
    );
  let module = loadHook();
  const options = autoDefault
    ? {}
    : {
        runtime: {},
        deferInitialRestore: defer,
        initialStorage: storage,
        createInitialLedger: () => initial ?? ledger(),
        getClock: clock,
      };
  const render = () => host.render(() => module.useLedger(options));
  const family = module.localLedgerFamily;
  const target = (targetFamily, data, targetStorage) => ({
    family: targetFamily,
    ledger: data,
    storage: targetStorage,
    ownerToken: owner.encodeReminderOwner({
      ...targetFamily,
      incarnationId: data.wallet.incarnationId,
    }),
  });
  return {
    get host() {
      return host;
    },
    get module() {
      return module;
    },
    options,
    storage,
    bytes,
    family,
    render,
    target,
    remount() {
      if (autoDefault) throw Error('Remount fixture needs an explicit stable runtime.');
      host.unmount();
      host = hostWithStores();
      module = loadHook();
      return render();
    },
    async open() {
      if (defer && !autoDefault) await render().restore();
      else {
        render();
        await new Promise((resolve) => setImmediate(resolve));
      }
      return render();
    },
  };
}
module.exports = {
  hostWithStores,
  loadSource,
  ledgerFixture,
  ledger,
  store,
  clock,
  model,
  identity,
  owner,
  achievements,
};

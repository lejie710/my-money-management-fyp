const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduledNotificationInstant } = require('../src/reminders/notificationTiming');
const { encodeReminderOwner, notificationIdentifier } = require('../src/reminders/store');

const requested = Date.parse('2026-11-02T12:00:00.789Z');
const ownerToken = encodeReminderOwner({
  scope: { kind: 'test', namespace: 'normalization-only' },
  actor: { kind: 'local' },
  incarnationId: 'synthetic-wallet',
});
function request(trigger, changes = {}) {
  return {
    identifier: notificationIdentifier(ownerToken, 'manual-one', 1),
    content: {
      title: 'Synthetic reminder',
      body: 'No native scheduling occurs in this test.',
      data: {
        origin: 'mmm-reminders-v1',
        ownerToken,
        reminderId: 'manual-one',
        revision: 1,
        operationId: 'operation-one',
        kind: 'manual',
        requestedScheduledAtMs: requested,
        ...changes,
      },
    },
    trigger,
  };
}
const android = () =>
  request({
    type: 'date',
    repeats: false,
    value: requested,
    channelId: 'mmm-local-reminders',
    delivery: 'bestEffort',
  });
const ios = () =>
  request({
    class: 'UNTimeIntervalNotificationTrigger',
    type: 'timeInterval',
    repeats: false,
    seconds: 59.211,
  });

test('Android native date/value stays authoritative over requested metadata', () => {
  const native = android();
  assert.equal(scheduledNotificationInstant('android', native), requested);
  native.content.data.requestedScheduledAtMs = requested + 10000;
  assert.equal(scheduledNotificationInstant('android', native), requested);
  delete native.content.data.requestedScheduledAtMs;
  assert.equal(scheduledNotificationInstant('android', native), requested);
  native.trigger.value = requested + 30000;
  assert.equal(scheduledNotificationInstant('android', native), requested + 30000);
});

test('iOS native nonrepeating interval recovers original requested instant from strict owned metadata', () => {
  const native = ios(),
    before = JSON.stringify(native);
  assert.equal(scheduledNotificationInstant('ios', native), requested);
  assert.equal(JSON.stringify(native), before);
  // Interval is not a countdown; repeated reads must not shift the requested date.
  native.trigger.seconds = 0.125;
  assert.equal(scheduledNotificationInstant('ios', native), requested);
  native.trigger.seconds = 365 * 86400;
  assert.equal(scheduledNotificationInstant('ios', native), requested);
});

test('iOS missing or malformed original instant stays unknown rather than now plus seconds', () => {
  for (const invalid of [
    undefined,
    null,
    '',
    String(requested),
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const native = ios();
    native.content.data.requestedScheduledAtMs = invalid;
    assert.equal(scheduledNotificationInstant('ios', native), null, String(invalid));
  }
});

test('foreign origin and malformed ownership, identity, revision or operation metadata are rejected', () => {
  const corruptions = [
    { origin: 'another-app' },
    { origin: undefined },
    { ownerToken: 'foreign' },
    { ownerToken: JSON.stringify(['canonical', 'unexpected', 'local', null, 'wallet']) },
    { reminderId: '' },
    { reminderId: '../other' },
    { operationId: '' },
    { revision: 0 },
    { revision: 1.5 },
    { kind: 'unknown' },
    { kind: 'goal', eventKey: 'valid-but-not-a-manual-reminder' },
  ];
  for (const changes of corruptions)
    for (const platform of ['android', 'ios']) {
      const native = platform === 'android' ? android() : ios();
      Object.assign(native.content.data, changes);
      assert.equal(scheduledNotificationInstant(platform, native), null);
    }
  const native = ios();
  native.identifier = '';
  assert.equal(scheduledNotificationInstant('ios', native), null);
});

test('repeating, unknown, wrong-platform and malformed trigger shapes cannot use metadata fallback', () => {
  for (const repeats of [true, undefined, null, 'false', 0]) {
    const native = ios();
    native.trigger.repeats = repeats;
    assert.equal(scheduledNotificationInstant('ios', native), null);
  }
  for (const seconds of [undefined, null, '60', 0, -1, Infinity, NaN]) {
    const native = ios();
    native.trigger.seconds = seconds;
    assert.equal(scheduledNotificationInstant('ios', native), null);
  }
  for (const type of ['calendar', 'unknown', 'push', 'location', 'date', undefined]) {
    const native = ios();
    native.trigger.type = type;
    assert.equal(scheduledNotificationInstant('ios', native), null);
  }
  assert.equal(scheduledNotificationInstant('android', ios()), null);
  assert.equal(scheduledNotificationInstant('ios', android()), null);
  assert.equal(scheduledNotificationInstant('web', android()), null);
  for (const invalid of [
    null,
    undefined,
    [],
    {},
    { trigger: null },
    { trigger: [], content: {} },
  ]) {
    assert.equal(scheduledNotificationInstant('ios', invalid), null);
  }
});

test('Android invalid native timestamp is rejected even with valid requested metadata', () => {
  for (const value of [undefined, null, '1', 0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
    const native = android();
    native.trigger.value = value;
    assert.equal(scheduledNotificationInstant('android', native), null);
  }
  const native = android();
  native.trigger.repeats = true;
  assert.equal(scheduledNotificationInstant('android', native), null);
  native.trigger = { type: 'date', repeats: false, date: requested };
  assert.equal(scheduledNotificationInstant('android', native), null);
});

test('mocked adapter scheduling writes original timestamp and lists native-shaped Android/iOS requests', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/reminders/expoAdapter.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const platform of ['android', 'ios']) {
    let sent = null;
    const nativeRequests = [];
    const notifications = {
      AndroidImportance: { DEFAULT: 3 },
      AndroidNotificationVisibility: { PRIVATE: 0 },
      SchedulableTriggerInputTypes: { DATE: 'date' },
      async setNotificationChannelAsync() {},
      async scheduleNotificationAsync(input) {
        sent = input;
        nativeRequests.push({
          identifier: input.identifier,
          content: input.content,
          trigger: platform === 'android' ? android().trigger : ios().trigger,
        });
        return input.identifier;
      },
      async getAllScheduledNotificationsAsync() {
        return nativeRequests;
      },
    };
    const exports = {};
    class FixedDate extends Date {
      static now() {
        return requested - 60000;
      }
    }
    vm.runInNewContext(
      compiled,
      {
        exports,
        Date: FixedDate,
        require(name) {
          if (name === 'react-native') return { Platform: { OS: platform } };
          if (name === 'expo')
            return {
              isRunningInExpoGo: () => false,
              requireOptionalNativeModule: () => {
                throw new Error('Standalone must not probe optional channel provider.');
              },
            };
          if (name === './localNotifications') return notifications;
          if (name === './notificationTiming') return { scheduledNotificationInstant };
          throw new Error(`Unexpected adapter dependency: ${name}`);
        },
      },
      { filename: 'expoAdapter.mocked.cjs' },
    );
    const input = {
      identifier: android().identifier,
      title: 'Original title',
      body: 'Original body',
      scheduledAtMs: requested,
      data: { ...android().content.data },
    };
    delete input.data.requestedScheduledAtMs;
    const original = JSON.stringify(input);
    assert.equal(await exports.expoNotificationAdapter.schedule(input), input.identifier);
    assert.equal(JSON.stringify(input), original);
    assert.equal(sent.content.data.requestedScheduledAtMs, requested);
    assert.equal(sent.content.data.ownerToken, ownerToken);
    assert.equal(sent.content.title, input.title);
    assert.equal(sent.content.body, input.body);
    assert.deepEqual(JSON.parse(JSON.stringify(sent.trigger)), {
      type: 'date',
      date: requested,
      channelId: 'mmm-local-reminders',
      delivery: 'bestEffort',
    });
    const listed = await exports.expoNotificationAdapter.listScheduled();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].scheduledAtMs, requested);
    assert.equal(listed[0].data.ownerToken, ownerToken);
  }
});

function capabilityAdapter({ platform = 'android', expoGo = false, provider = null } = {}) {
  const fs = require('node:fs'),
    path = require('node:path'),
    vm = require('node:vm'),
    ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/reminders/expoAdapter.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [];
  const notifications = {
    AndroidImportance: { DEFAULT: 3, NONE: 0 },
    AndroidNotificationVisibility: { PRIVATE: 0 },
    IosAuthorizationStatus: { AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 },
    SchedulableTriggerInputTypes: { DATE: 'date' },
    async setNotificationChannelAsync(id, options) {
      calls.push(['set-channel', id, options]);
    },
    async getNotificationChannelAsync() {
      calls.push(['get-channel']);
      return { importance: 3 };
    },
    async getPermissionsAsync() {
      calls.push(['get-permission']);
      return { granted: true, status: 'granted', canAskAgain: true, ios: { status: 2 } };
    },
    async requestPermissionsAsync() {
      calls.push(['request-permission']);
      return { granted: true, status: 'granted', canAskAgain: true, ios: { status: 2 } };
    },
    async getAllScheduledNotificationsAsync() {
      calls.push(['list']);
      return [];
    },
    async cancelScheduledNotificationAsync(id) {
      calls.push(['cancel', id]);
    },
    async scheduleNotificationAsync(input) {
      calls.push(['schedule']);
      return input.identifier;
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    Date,
    require(name) {
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === 'expo')
        return {
          isRunningInExpoGo: () => expoGo,
          requireOptionalNativeModule(module) {
            calls.push(['probe', module]);
            return provider;
          },
        };
      if (name === './localNotifications') return notifications;
      if (name === './notificationTiming') return { scheduledNotificationInstant };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return { ...exports, calls };
}

test('known Android Expo Go channel-provider gap is unavailable and cannot call scheduling or Settings permissions', async () => {
  const fixture = capabilityAdapter({ expoGo: true, provider: null });
  const adapter = fixture.expoNotificationAdapter;
  assert.match(fixture.localReminderUnavailableReason(), /This preview cannot schedule reminders/);
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.getPermission())), {
    status: 'unavailable',
    canAskAgain: false,
    channelEnabled: null,
  });
  await assert.rejects(() => adapter.ensureChannel(), /installed Android app/);
  await assert.rejects(() => adapter.requestPermission(), /installed Android app/);
  await assert.rejects(
    () => adapter.schedule({ identifier: 'blocked', scheduledAtMs: Date.now() + 60000, data: {} }),
    /installed Android app/,
  );
  assert.ok(fixture.calls.every((call) => call[0] === 'probe'));
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.listScheduled())), []);
  await adapter.cancel('owned-existing');
  assert.deepEqual(fixture.calls.slice(-2), [['list'], ['cancel', 'owned-existing']]);
});

test('standalone Android never gates on optional provider exposure and keeps native local APIs', async () => {
  const fixture = capabilityAdapter({ expoGo: false, provider: null }),
    adapter = fixture.expoNotificationAdapter;
  assert.equal(fixture.localReminderUnavailableReason(), null);
  assert.equal((await adapter.getPermission()).status, 'granted');
  await adapter.ensureChannel();
  assert.equal(
    await adapter.schedule({
      identifier: 'standalone',
      scheduledAtMs: Date.now() + 60000,
      data: {},
    }),
    'standalone',
  );
  assert.equal(
    fixture.calls.some((call) => call[0] === 'probe'),
    false,
  );
  assert.equal(
    fixture.calls.some((call) => call[0] === 'schedule'),
    true,
  );
  assert.ok(
    fixture.calls
      .filter((call) => call[0] === 'set-channel')
      .every((call) => !Object.hasOwn(call[2], 'sound')),
  );
});

test('capable Android Expo Go and iOS continue using local notification APIs', async () => {
  for (const config of [
    { expoGo: true, provider: {} },
    { platform: 'ios', expoGo: true, provider: null },
  ]) {
    const fixture = capabilityAdapter(config);
    assert.equal(fixture.localReminderUnavailableReason(), null);
    assert.equal((await fixture.expoNotificationAdapter.getPermission()).status, 'granted');
    if (config.platform === 'ios')
      assert.equal(
        fixture.calls.some((call) => call[0] === 'probe'),
        false,
      );
  }
});

test('unavailable reminder screens remove Settings scheduling paths while keeping deletion and inspection', () => {
  const fs = require('node:fs'),
    path = require('node:path'),
    vm = require('node:vm'),
    ts = require('typescript');
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  };
  const native = {
    Text: 'Text',
    View: 'View',
    ActivityIndicator: 'ActivityIndicator',
    Switch: 'Switch',
    StyleSheet: { create: (value) => value },
    Linking: {
      openSettings() {
        throw Error('Settings must not be invoked');
      },
    },
  };
  function render(file, name, props) {
    const source = fs.readFileSync(path.join(__dirname, `../src/ui/${file}.tsx`), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
      },
    }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
      exports,
      Date,
      require(module) {
        if (module === 'react') return { ...react, default: react };
        if (module === 'react-native') return native;
        if (module === './components')
          return {
            Action: 'Action',
            Field: 'Field',
            FormError: 'FormError',
            Screen: 'Screen',
            Sheet: 'Sheet',
          };
        if (module === './ReminderEditor') return { ReminderEditor: 'ReminderEditor' };
        if (module === './reminderDisplay')
          return { deviceTimeZone: () => 'Test/Zone', reminderTime: () => 'Synthetic time' };
        if (module === './theme') return { colors: {}, ui: {} };
        if (module === '../reminders/expoAdapter')
          return {
            localReminderUnavailableReason: () =>
              'This preview cannot schedule reminders. Open the project’s installed Android app to use them.',
          };
        if (module === '../reminders/store') return require('../src/reminders/store');
        throw Error(`Unexpected UI dependency ${module}`);
      },
    });
    return exports[name](props);
  }
  const row = {
    id: 'one',
    revision: 1,
    title: 'Saved',
    body: 'Synthetic',
    scheduledAtMs: Date.now() + 60000,
    status: 'error',
    pendingAction: null,
    pendingDraft: null,
    message: null,
    canRetry: true,
    canEdit: true,
    canDelete: true,
  };
  const state = {
    ownerToken: 'test',
    loading: false,
    loadError: null,
    lastError: null,
    ownerPaused: false,
    cleanupPending: false,
    permission: { status: 'unavailable', canAskAgain: false, channelEnabled: null },
    reminders: [row, { ...row, id: 'deleting', pendingAction: 'delete', canEdit: false }],
    busyReminderIds: [],
    automatic: { budgets: false, goal: false, achievements: false },
    automaticNoticeErrors: [],
  };
  const coordinator = { ownerToken: 'test' };
  function nodes(tree) {
    return [
      tree,
      ...(Array.isArray(tree?.children)
        ? tree.children
            .flat(Infinity)
            .flatMap((child) => (child && typeof child === 'object' ? nodes(child) : []))
        : []),
    ];
  }
  const screen = nodes(
    render('RemindersScreen', 'RemindersScreen', {
      state,
      coordinator,
      sampleMode: false,
      getBaselineKeys: () => [],
      onBack: () => {},
    }),
  );
  const find = (id) => screen.find((node) => node.props?.testID === id);
  assert.equal(find('reminder-open-settings'), undefined);
  assert.equal(find('enable-reminder-permission'), undefined);
  assert.equal(find('add-reminder').props.disabled, true);
  assert.equal(find('edit-reminder-one').props.disabled, true);
  assert.equal(find('retry-reminder-one').props.disabled, true);
  assert.equal(find('retry-reminder-deleting').props.disabled, false);
  assert.equal(find('delete-reminder-one').props.disabled, false);
  assert.equal(find('refresh-reminders').props.disabled, false);
  const editor = nodes(
    render('ReminderEditor', 'ReminderEditor', {
      state,
      coordinator,
      reminder: row,
      onClose: () => {},
    }),
  );
  assert.equal(
    editor.some((node) => node.props?.testID === 'editor-open-settings'),
    false,
  );
  assert.equal(editor.find((node) => node.props?.testID === 'save-reminder').props.disabled, true);
  assert.equal(
    editor.find((node) => node.props?.testID === 'delete-reminder').props.disabled,
    false,
  );
});

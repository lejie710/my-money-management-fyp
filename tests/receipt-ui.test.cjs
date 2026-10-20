const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const { createHookHost } = require('./helpers/hook-host.cjs');
const { deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const model = require('../src/core/model');
const receipt = require('../src/core/receipt');
function ocr(lines = ['SHOP', 'DATE 2026-10-18', 'TOTAL RM12.50']) {
  return {
    version: 1,
    provider: 'windows-media-ocr',
    language: 'en-US',
    width: 1400,
    height: 2000,
    elapsedMs: 10,
    textAngle: null,
    words: lines.flatMap((text, index) =>
      text.split(' ').map((word, column) => ({
        text: word,
        bounds: {
          x: 10 + column * 130,
          y: 20 + index * 60,
          width: 120,
          height: 30,
        },
      })),
    ),
  };
}
function fixture(options = {}) {
  const host = createHookHost(),
    ledger = model.createEmptyLedger(),
    calls = {
      library: 0,
      camera: 0,
      read: 0,
      recognize: 0,
      stage: 0,
      closeDraft: 0,
      releases: [],
      saved: [],
      closed: 0,
    };
  host.react.useLayoutEffect = host.react.useEffect;
  let serial = 0;
  const capture = {
    cameraAvailable: true,
    async pickPhoto() {
      calls.library++;
      return options.pick
        ? options.pick()
        : {
            id: `receipt-${++serial}`,
            uri: 'file:///owned-receipt-cache/image.png',
          };
    },
    async takePhoto() {
      calls.camera++;
      return {
        id: `receipt-${++serial}`,
        uri: 'file:///owned-receipt-cache/camera.png',
      };
    },
    async readBytes(_image, { signal }) {
      calls.read++;
      calls.readSignal = signal;
      return new Uint8Array([1, 2, 3]);
    },
    async release(image) {
      calls.releases.push(image.id);
    },
  };
  const photos = {
    beginDraft: () => ({
      id: 'photo-draft',
      ownerIncarnationId: ledger.wallet.incarnationId,
    }),
    async stage() {
      calls.stage++;
      if (options.stage) return options.stage();
      return {
        id: 'photo-receipt',
        fileName: 'photo-receipt.png',
        ownerIncarnationId: ledger.wallet.incarnationId,
        mimeType: 'image/png',
        width: 10,
        height: 10,
        byteSize: 100,
      };
    },
    async closeDraft() {
      calls.closeDraft++;
      if (options.closeDraft) return options.closeDraft();
      return { pending: false };
    },
  };
  const binding = {
    isCurrent: options.isCurrent,
    attachLifecycle: options.attachLifecycle,
    onPhotoCleanupMessage: options.onPhotoCleanupMessage,
    sessionKey: 'test/local/receipt-session',
    capture,
    photos,
    today: '2026-10-18',
    client: options.noClient
      ? null
      : {
          async recognize(_bytes, { signal }) {
            calls.recognize++;
            calls.signal = signal;
            return options.recognize ? options.recognize() : ocr();
          },
        },
  };
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/ui/useReceiptCapture.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    AbortController,
    Uint8Array,
    require(name) {
      if (name === 'react') return host.react;
      if (name === '../core/model') return model;
      if (name === '../core/receipt') return receipt;
      if (name === './TransactionEditor') return { newId: () => 'transaction-reviewed-receipt' };
      throw Error(`Unexpected receipt UI dependency ${name}`);
    },
  });
  const props = {
    ledger,
    binding,
    async onSave(next) {
      calls.saved.push(next);
      return options.save ? options.save(next) : true;
    },
    onClose() {
      calls.closed++;
    },
  };
  const render = () => host.render(() => module.exports.useReceiptCapture(props));
  const reviewReady = async () => {
    await render().select('library');
    await render().recognize();
    render().update('categoryId', 'expense-other');
    render().setConfirmed(true);
    return render();
  };
  return { host, ledger, calls, binding, props, render, reviewReady };
}

test('selection and validated OCR result review never save automatically or invent a category', async () => {
  const f = fixture(),
    before = JSON.stringify(f.ledger);
  await f.render().select('library');
  assert.equal(f.calls.recognize, 0);
  assert.equal(f.calls.stage, 0);
  assert.equal(f.calls.saved.length, 0);
  await f.render().recognize();
  const view = f.render();
  assert.equal(view.phase, 'review');
  assert.equal(view.review.title, 'SHOP');
  assert.equal(view.review.date, '2026-10-18');
  assert.equal(view.review.amount, '12.50');
  assert.equal(view.review.categoryId, '');
  assert.equal(view.review.confirmed, false);
  assert.equal(view.keepPhoto, false);
  assert.equal(JSON.stringify(f.ledger), before);
  assert.equal(f.calls.saved.length, 0);
});

test('blank and ambiguous recognition leave missing fields blank instead of guessing today or a total', async () => {
  const blank = fixture({ recognize: async () => ocr([]) });
  await blank.render().select('library');
  await blank.render().recognize();
  const empty = blank.render();
  assert.equal(empty.phase, 'blank');
  assert.equal(empty.review.title, '');
  assert.equal(empty.review.date, '');
  assert.equal(empty.review.amount, '');
  await empty.confirm();
  assert.equal(blank.calls.saved.length, 0);
  const ambiguous = fixture({
    recognize: async () => ocr(['SHOP', 'DATE 03/04/2026', 'TOTAL RM12.50', 'TOTAL RM20.00']),
  });
  await ambiguous.render().select('library');
  await ambiguous.render().recognize();
  assert.equal(ambiguous.render().review.date, '');
  assert.equal(ambiguous.render().review.amount, '');
  assert.equal(ambiguous.render().candidate.date.candidates.length, 2);
});

test('cancellation aborts the request and ignores late recognized fields', async () => {
  const work = deferred(),
    f = fixture({ recognize: () => work.promise });
  await f.render().select('library');
  const pending = f.render().recognize();
  await flush();
  f.render().cancelRecognition();
  assert.equal(f.calls.signal.aborted, true);
  work.resolve(ocr());
  await pending;
  assert.equal(f.render().candidate, null);
  assert.equal(f.render().phase, 'selected');
  assert.equal(f.calls.saved.length, 0);
});

test('a late picked image after close is released without attaching or recognizing it', async () => {
  const pick = deferred(),
    f = fixture({ pick: () => pick.promise });
  const pending = f.render().select('library');
  assert.equal(f.render().close(), true);
  pick.resolve({
    id: 'late-selection',
    uri: 'file:///owned-receipt-cache/late.png',
  });
  await pending;
  await flush();
  assert.deepEqual(f.calls.releases, ['late-selection']);
  assert.equal(f.calls.recognize, 0);
  assert.equal(f.calls.saved.length, 0);
});

test('known foreign and unsupported currencies cannot be relabelled by manually entering a wallet amount', async () => {
  for (const currency of ['USD', 'SGD', 'USD $']) {
    const f = fixture({
      recognize: async () => ocr(['SHOP', 'DATE 2026-10-18', `TOTAL ${currency}12.50`]),
    });
    await f.reviewReady();
    f.render().update('amount', '12.50');
    f.render().setKeepPhoto(true);
    f.render().setConfirmed(true);
    await f.render().confirm();
    assert.equal(f.calls.stage, 0);
    assert.equal(f.calls.saved.length, 0);
    assert.ok(f.render().error);
  }
});

test('explicit confirmation saves an ordinary expense only, and any field edit clears acknowledgement', async () => {
  const f = fixture();
  await f.reviewReady();
  f.render().update('title', 'Reviewed vendor');
  assert.equal(f.render().review.confirmed, false);
  await f.render().confirm();
  assert.equal(f.calls.saved.length, 0);
  f.render().setConfirmed(true);
  await f.render().confirm();
  assert.equal(f.calls.saved.length, 1);
  const transaction = f.calls.saved[0].transactions[0];
  assert.equal(transaction.type, 'expense');
  assert.equal(transaction.amountMinor, 1250);
  assert.equal(transaction.title, 'Reviewed vendor');
  assert.equal(transaction.categoryId, 'expense-other');
  assert.equal(Object.hasOwn(transaction, 'origin'), false);
  assert.equal(Object.hasOwn(transaction, 'ocr'), false);
  assert.equal(f.calls.stage, 0);
  assert.equal(f.calls.closed, 1);
});

test('photo copies happen only after validated Confirm and a failed save retries the same pinned copy', async () => {
  let attempt = 0;
  const f = fixture({ save: async () => ++attempt > 1 });
  await f.reviewReady();
  f.render().setKeepPhoto(true);
  f.render().setConfirmed(true);
  assert.equal(f.calls.stage, 0);
  await f.render().confirm();
  assert.equal(f.calls.stage, 1);
  assert.equal(f.calls.closeDraft, 0);
  assert.equal(f.render().phase, 'review');
  await f.render().confirm();
  await flush();
  assert.equal(f.calls.stage, 1);
  assert.equal(f.calls.saved.length, 2);
  assert.equal(f.calls.saved[1].transactions[0].context.photo.id, 'photo-receipt');
  assert.equal(f.calls.closeDraft, 1);
  assert.equal(f.calls.releases.length, 1);
});

test('duplicate confirmation is blocked and temporary image release waits for owned-copy cleanup during unmount', async () => {
  const save = deferred(),
    cleanup = deferred();
  const f = fixture({
    save: () => save.promise,
    closeDraft: () => cleanup.promise,
  });
  await f.reviewReady();
  f.render().setKeepPhoto(true);
  f.render().setConfirmed(true);
  const first = f.render().confirm();
  await flush();
  await f.render().confirm();
  assert.equal(f.calls.saved.length, 1);
  save.resolve(true);
  await first;
  f.host.unmount();
  await flush();
  assert.equal(f.calls.releases.length, 0);
  cleanup.resolve({ pending: false });
  await flush();
  assert.equal(f.calls.closeDraft, 1);
  assert.equal(f.calls.releases.length, 1);
});

test('unconfigured recognition and picker cancellation preserve the selection without creating guesses', async () => {
  const f = fixture({ noClient: true });
  await f.render().select('camera');
  assert.equal(f.calls.camera, 1);
  await f.render().recognize();
  assert.equal(f.calls.read, 0);
  assert.equal(f.render().candidate, null);
  assert.ok(f.render().error);
  const cancelled = fixture({ pick: async () => null });
  await cancelled.render().select('library');
  assert.equal(cancelled.render().phase, 'empty');
  assert.equal(cancelled.calls.saved.length, 0);
});

test('failed recognition retry restores the prior editable review and preserves the user corrections', async () => {
  let calls = 0;
  const f = fixture({
    recognize: async () => {
      if (++calls === 1) return ocr();
      throw new Error('Synthetic unavailable service');
    },
  });
  await f.reviewReady();
  f.render().update('title', 'Manually corrected vendor');
  f.render().update('amount', '13.25');
  f.render().setConfirmed(true);
  await f.render().recognize();
  const view = f.render();
  assert.equal(view.phase, 'review');
  assert.equal(view.review.title, 'Manually corrected vendor');
  assert.equal(view.review.amount, '13.25');
  assert.equal(view.review.confirmed, true);
  assert.ok(view.error);
  assert.equal(f.calls.saved.length, 0);
  await view.confirm();
  assert.equal(f.calls.saved[0].transactions[0].amountMinor, 1325);
});

test('stale field and acknowledgement callbacks cannot edit while replacement recognition or native selection is pending', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture({
    recognize: async () => (++calls === 1 ? ocr() : pending.promise),
  });
  await f.reviewReady();
  const old = f.render(),
    work = old.recognize();
  await flush();
  old.update('amount', '999');
  old.setConfirmed(false);
  old.setKeepPhoto(true);
  assert.equal(f.render().review.amount, '12.50');
  assert.equal(f.render().review.confirmed, true);
  assert.equal(f.render().keepPhoto, false);
  pending.resolve(ocr(['SHOP', 'DATE 2026-10-18', 'TOTAL RM20.00']));
  await work;
  assert.equal(f.render().review.amount, '20.00');
  assert.equal(f.render().review.confirmed, false);
  assert.equal(f.calls.saved.length, 0);
  const stale = f.render(),
    selection = stale.select('library');
  stale.update('title', 'Stale selection edit');
  stale.setConfirmed(true);
  assert.equal(f.render().review.title, 'SHOP');
  assert.equal(f.render().review.confirmed, false);
  await selection;
});

test('owner-session replacement suppresses late OCR even when two actors have the same incarnation string', async () => {
  const pending = deferred(),
    f = fixture({ recognize: () => pending.promise });
  await f.render().select('library');
  const work = f.render().recognize();
  await flush();
  f.binding.sessionKey = 'test/firebase/B/same-incarnation/new-receipt';
  f.render();
  pending.resolve(ocr());
  await work;
  assert.equal(f.render().candidate, null);
  assert.equal(f.render().phase, 'empty');
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.releases.length, 1);
});

test('Strict Mode cleanup replay invalidates the old selection and closes its source only once', async () => {
  const f = fixture();
  await f.reviewReady();
  f.host.replayEffects();
  await flush();
  const view = f.render();
  assert.equal(view.phase, 'empty');
  assert.equal(view.candidate, null);
  assert.equal(view.review.confirmed, false);
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.releases.length, 1);
  f.host.unmount();
  await flush();
  assert.equal(f.calls.releases.length, 1);
});

test('callbacks captured by an old owner session cannot edit, close, recognize or confirm into its replacement', async () => {
  const f = fixture();
  await f.reviewReady();
  const old = f.render();
  f.binding.sessionKey = 'test/firebase/B/replacement';
  f.render();
  old.update('title', 'Old owner title');
  old.setConfirmed(true);
  old.setKeepPhoto(true);
  await old.recognize();
  await old.confirm();
  assert.equal(old.close(), false);
  const current = f.render();
  assert.equal(current.review.title, '');
  assert.equal(current.review.confirmed, false);
  assert.equal(current.keepPhoto, false);
  assert.equal(current.phase, 'empty');
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.recognize, 1);
});

test('future receipt provenance receives the explicit selected capture ID only at confirmed save', async () => {
  const f = fixture(),
    origins = [];
  f.props.prepareReceiptOrigin = (transaction, captureId) => {
    origins.push({ transaction, captureId });
    return transaction;
  };
  await f.reviewReady();
  assert.equal(origins.length, 0);
  const selected = f.render().image.id;
  await f.render().confirm();
  assert.equal(origins.length, 1);
  assert.equal(origins[0].captureId, selected);
  assert.notEqual(origins[0].captureId, origins[0].transaction.id);
  assert.equal(Object.hasOwn(origins[0].transaction, 'ocr'), false);
  assert.equal(f.calls.saved.length, 1);
});

test('root close aborts active OCR synchronously and a settled result cannot revive the closed draft', async () => {
  const pending = deferred();
  let closeFromRoot = null;
  const f = fixture({
    recognize: () => pending.promise,
    attachLifecycle(close) {
      closeFromRoot = close;
      return () => {
        closeFromRoot = null;
      };
    },
  });
  await f.render().select('library');
  const work = f.render().recognize();
  await flush();
  const closing = closeFromRoot();
  assert.equal(f.calls.signal.aborted, true);
  pending.resolve(ocr());
  await work;
  await closing;
  assert.equal(f.render().candidate, null);
  await f.render().confirm();
  assert.equal(f.calls.saved.length, 0);
  assert.equal(f.calls.releases.length, 1);
  f.host.unmount();
});

test('root owner/currentness guard rejects recognition completion even before the child has rerendered', async () => {
  const pending = deferred();
  let current = true;
  const f = fixture({ recognize: () => pending.promise, isCurrent: () => current });
  await f.render().select('library');
  const old = f.render(),
    work = old.recognize();
  await flush();
  current = false;
  pending.resolve(ocr());
  await work;
  assert.equal(f.render().candidate, null);
  old.update('title', 'stale');
  old.setConfirmed(true);
  await old.confirm();
  assert.equal(f.calls.saved.length, 0);
  assert.equal(old.close(), false);
  f.host.unmount();
  await flush();
});

function cloudOcr() {
  const value = ocr();
  return {
    ...value,
    provider: 'google-cloud-vision',
    detectedLanguages: [{ languageCode: 'en-US', confidence: null }],
    pageConfidence: null,
    geometry: 'axis-aligned-envelope-with-original-polygon',
    words: value.words.map((word) => {
      const { x, y, width, height } = word.bounds;
      return {
        ...word,
        confidence: null,
        detectedLanguages: [],
        polygon: [
          { x, y },
          { x: x + width, y },
          { x: x + width, y: y + height },
          { x, y: y + height },
        ],
      };
    }),
  };
}
const cloudProvider = {
  engine: 'google-cloud-vision',
  processing: 'cloud',
  maxImageBytes: 6291456,
};

test('cloud recognition still requires chosen category and explicit confirmation before ordinary expense save', async () => {
  const f = fixture({ recognize: async () => cloudOcr() });
  f.binding.provider = cloudProvider;
  await f.render().select('library');
  assert.equal(f.calls.recognize, 0);
  await f.render().recognize();
  assert.equal(f.render().candidate.provider, 'google-cloud-vision');
  assert.equal(f.render().review.confirmed, false);
  assert.equal(f.calls.saved.length, 0);
  f.render().update('categoryId', 'expense-food');
  f.render().setConfirmed(true);
  await f.render().confirm();
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.calls.saved[0].transactions[0].amountMinor, 1250);
  assert.equal(f.calls.saved[0].transactions[0].type, 'expense');
  f.host.unmount();
});

test('changing the OCR provider retires its image/review session and ignores the old provider response', async () => {
  const pending = deferred(),
    f = fixture({ recognize: () => pending.promise });
  f.binding.provider = cloudProvider;
  await f.render().select('library');
  const recognizing = f.render().recognize();
  await flush();
  f.binding.provider = {
    engine: 'windows-media-ocr',
    processing: 'local',
    maxImageBytes: 10485760,
  };
  f.render();
  assert.equal(f.calls.signal.aborted, true);
  pending.resolve(cloudOcr());
  await recognizing;
  assert.equal(f.render().phase, 'empty');
  assert.equal(f.render().candidate, null);
  assert.equal(f.calls.saved.length, 0);
  f.host.unmount();
});

test('a configured cloud capture refuses local-provider output without producing review guesses', async () => {
  const f = fixture();
  f.binding.provider = cloudProvider;
  await f.render().select('library');
  await f.render().recognize();
  assert.equal(f.render().candidate, null);
  assert.match(f.render().error, /provider changed/);
  assert.equal(f.calls.saved.length, 0);
  f.host.unmount();
});

function renderedReceipt(f, cloudAccount) {
  const { loadSource } = require('./helpers/account-hook-harness.cjs');
  const screenHost = createHookHost(),
    reviewHost = createHookHost();
  const native = {
    Text: 'Text',
    View: 'View',
    Image: 'Image',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    StyleSheet: { create: (value) => value },
  };
  const components = {
    Action: 'Action',
    Field: 'Field',
    Choice: 'Choice',
    FormError: 'FormError',
    Sheet: 'Sheet',
  };
  const theme = require('./helpers/theme-stub.cjs').themeStub;
  const review = loadSource(path.join(__dirname, '../src/ui/ReceiptReviewFields.tsx'), {
    react: reviewHost.react,
    'react-native': native,
    '../core/model': model,
    './components': components,
    './theme': theme,
  });
  const screen = loadSource(path.join(__dirname, '../src/ui/ReceiptCaptureSheet.tsx'), {
    react: screenHost.react,
    'react-native': native,
    './components': components,
    './theme': theme,
    './ReceiptReviewFields': review,
    './useReceiptCapture': { useReceiptCapture: () => f.render() },
  });
  const nodes = (value) =>
    !value || typeof value !== 'object'
      ? []
      : Array.isArray(value)
        ? value.flatMap(nodes)
        : [value, ...nodes(value.props?.children)];
  const text = (value) =>
    value == null
      ? ''
      : Array.isArray(value)
        ? value.map(text).join('')
        : typeof value === 'object'
          ? text(value.props?.children)
          : String(value);
  return {
    nodes,
    text,
    find: (tree, id) => nodes(tree).find((node) => node.props?.testID === id),
    render() {
      const outer = screen.ReceiptCaptureSheet({
        ...f.props,
        cloudAccount,
        saveError: '',
        onManualEntry() {},
      });
      const tree = screenHost.render(() => outer.type(outer.props));
      const fields = nodes(tree).find((node) => node.type === review.ReceiptReviewFields);
      return [
        tree,
        fields ? reviewHost.render(() => review.ReceiptReviewFields(fields.props)) : null,
      ];
    },
    unmount() {
      screenHost.unmount();
      reviewHost.unmount();
    },
  };
}

for (const cloudAccount of [false, true]) {
  test(`Vision recognition in a ${cloudAccount ? 'cloud' : 'guest'} wallet keeps photo retention separate from explicit financial confirmation`, async () => {
    const f = fixture({ recognize: async () => cloudOcr() });
    f.binding.provider = cloudProvider;
    const ui = renderedReceipt(f, cloudAccount);
    let tree = ui.render();
    const disclosure = ui.find(tree, 'receipt-storage-disclosure');
    if (cloudAccount) {
      assert.match(ui.text(disclosure), /Saving confirms the expense in Firebase/);
      assert.match(ui.text(disclosure), /If you choose to keep the receipt photo/);
      assert.doesNotMatch(ui.text(disclosure), /saved on this device/);
    } else {
      assert.match(ui.text(disclosure), /saved on this device/);
      assert.doesNotMatch(ui.text(disclosure), /Firebase/);
    }
    assert.equal(f.calls.recognize, 0);
    assert.equal(f.calls.stage, 0);
    assert.equal(f.calls.saved.length, 0);
    ui.find(tree, 'receipt-pick-image').props.onPress();
    await flush();
    tree = ui.render();
    assert.equal(f.calls.recognize, 0);
    assert.equal(f.calls.stage, 0);
    assert.equal(f.calls.saved.length, 0);
    ui.find(tree, 'receipt-recognize').props.onPress();
    await flush();
    tree = ui.render();
    assert.equal(f.calls.recognize, 1);
    assert.equal(f.calls.stage, 0);
    assert.equal(f.calls.saved.length, 0);
    assert.equal(ui.find(tree, 'receipt-keep-photo').props.accessibilityState.checked, false);
    assert.equal(ui.find(tree, 'receipt-save-expense').props.disabled, true);
    assert.match(ui.text(tree), /No transaction has been saved/);
    const all = ui.nodes(tree);
    assert.ok(
      all.indexOf(ui.find(tree, 'receipt-storage-disclosure')) <
        all.indexOf(ui.find(tree, 'receipt-save-expense')),
    );
    ui.find(tree, 'receipt-keep-photo').props.onPress();
    tree = ui.render();
    assert.equal(ui.find(tree, 'receipt-keep-photo').props.accessibilityState.checked, true);
    assert.equal(f.calls.stage, 0);
    assert.equal(f.calls.saved.length, 0);
    // Recognition alone never chooses the permanent attachment policy: undo the choice,
    // then confirm a reviewed expense without keeping any photo in either storage mode.
    ui.find(tree, 'receipt-keep-photo').props.onPress();
    tree = ui.render();
    ui.find(tree, 'receipt-category-expense-food').props.onPress();
    tree = ui.render();
    ui.find(tree, 'receipt-confirm-fields').props.onPress();
    tree = ui.render();
    assert.equal(ui.find(tree, 'receipt-save-expense').props.disabled, false);
    assert.equal(f.calls.saved.length, 0);
    ui.find(tree, 'receipt-save-expense').props.onPress();
    await flush();
    assert.equal(f.calls.saved.length, 1);
    assert.equal(f.calls.saved[0].transactions[0].amountMinor, 1250);
    assert.equal(f.calls.saved[0].transactions[0].context?.photo ?? null, null);
    assert.equal(f.calls.stage, 0);
    ui.unmount();
    f.host.unmount();
    await flush();
  });
}

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { hostWithStores, loadSource } = require('./helpers/account-hook-harness.cjs');
const core = require('../src/core/model');
const grounding = require('../src/assistant/grounding');
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
const native = {
  Text: 'Text',
  View: 'View',
  Image: 'Image',
  Switch: 'Switch',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value) => value },
};
const ui = { colors: {}, ui: {} };
const components = { Action: 'Action', Field: 'Field', FormError: 'FormError', Sheet: 'Sheet' };

test('OpenAI destination and selected-data disclosure are visible before the explicit Ask action', () => {
  const host = hostWithStores();
  let asks = 0;
  const ledger = core.createEmptyLedger();
  const context = grounding.buildAssistantContext(ledger, {
    startDate: '2026-10-01',
    endDate: '2026-10-31',
  });
  const state = {
    configured: true,
    turns: [],
    include: {},
    question: 'Explain income.',
    busy: false,
    canAsk: true,
    context,
    startDraft: '2026-10-01',
    endDraft: '2026-10-31',
    ask: () => {
      asks++;
    },
    message: '',
    retryQuestion: null,
  };
  const screen = loadSource(path.join(__dirname, '../src/ui/AssistantPanel.tsx'), {
    react: host.react,
    'react-native': native,
    './theme': ui,
    './components': components,
    './useAssistant': { useAssistant: () => state },
  });
  const tree = host.render(() =>
    screen.AssistantPanel({
      ledger,
      provider: { engine: 'openai', processing: 'cloud', model: 'synthetic-model' },
    }),
  );
  const all = nodes(tree),
    disclosure = all.findIndex((node) => node.props?.testID === 'assistant-provider-disclosure'),
    action = all.findIndex((node) => node.props?.testID === 'assistant-ask');
  assert.ok(disclosure >= 0 && disclosure < action);
  assert.match(text(all[disclosure]), /OpenAI/);
  assert.match(
    text(all[disclosure]),
    /fact rows and your question leave the device only when you ask/,
  );
  assert.equal(all[action].props.label, 'Ask OpenAI');
  assert.equal(asks, 0);
  all[action].props.onPress();
  assert.equal(asks, 1);
  assert.ok(!text(tree).includes('The model runs on the connected Windows computer'));
  host.unmount();
});

test('Vision upload destination and six-MiB limit precede recognition while manual entry remains available', () => {
  const host = hostWithStores();
  let recognizes = 0,
    manual = 0;
  const draft = {
    phase: 'selected',
    image: { id: 'image-one', uri: 'file:///owned/image.png' },
    candidate: null,
    recognize: () => {
      recognizes++;
    },
    close: () => true,
  };
  const screen = loadSource(path.join(__dirname, '../src/ui/ReceiptCaptureSheet.tsx'), {
    react: host.react,
    'react-native': native,
    './theme': ui,
    './components': components,
    './ReceiptReviewFields': { ReceiptReviewFields: 'ReceiptReviewFields' },
    './useReceiptCapture': { useReceiptCapture: () => draft },
  });
  const outer = screen.ReceiptCaptureSheet({
    ledger: core.createEmptyLedger(),
    binding: {
      sessionKey: 'capture',
      client: {},
      capture: { cameraAvailable: true },
      provider: { engine: 'google-cloud-vision', processing: 'cloud', maxImageBytes: 6291456 },
    },
    onClose() {},
    onManualEntry() {
      manual++;
    },
  });
  const tree = host.render(() => outer.type(outer.props)),
    all = nodes(tree);
  const disclosure = all.findIndex((node) => node.props?.testID === 'receipt-provider-disclosure'),
    action = all.findIndex((node) => node.props?.testID === 'receipt-recognize');
  assert.ok(disclosure >= 0 && disclosure < action);
  assert.match(text(all[disclosure]), /Google Cloud Vision/);
  assert.match(text(all[disclosure]), /6 MiB/);
  assert.equal(all[action].props.label, 'Recognize with Google Vision');
  assert.equal(recognizes, 0);
  all[action].props.onPress();
  assert.equal(recognizes, 1);
  all.find((node) => node.props?.testID === 'receipt-manual-entry').props.onPress();
  assert.equal(manual, 1);
  assert.ok(!text(tree).includes('No cloud OCR'));
  host.unmount();
});

const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const e = require('../src/core/exports'),
  m = require('../src/core/model');
const { createVerificationLedger } = require('../src/verification/fixtures');
const { inspectImageHeader } = require('../src/attachments/imageHeader');
const now = Date.parse('2026-10-18T12:00:00Z');
const identity = {
  clock: { today: '2026-10-18', nowMs: now },
  newIncarnationId: () => 'private-wallet-owner',
};
function fresh(currency = 'MYR') {
  return m.createEmptyLedger({ currency, name: 'Everyday wallet' }, identity);
}
function add(ledger, options = {}) {
  const transaction = {
    id: options.id ?? 'private-transaction-id',
    walletId: ledger.wallet.id,
    type: options.type ?? 'expense',
    title: options.title ?? 'Lunch',
    categoryId:
      options.categoryId ??
      { income: 'income-salary', expense: 'expense-food', debt: 'debt-loan' }[
        options.type ?? 'expense'
      ],
    date: options.date ?? '2026-10-17',
    amountMinor: options.amountMinor ?? 1234,
  };
  return m.saveTransaction(ledger, transaction);
}
function withContext(ledger, patch) {
  const tx = ledger.transactions[0];
  return m.saveTransaction(ledger, m.patchTransactionContext(tx, patch, ledger), true);
}
function samplePhoto() {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png'));
  const info = inspectImageHeader(new Uint8Array(bytes));
  return {
    photo: {
      id: 'photo-private-id',
      ownerIncarnationId: 'private-wallet-owner',
      fileName: 'photo-private-id.png',
      ...info,
    },
    image: {
      status: 'ready',
      dataUrl: `data:${info.mimeType};base64,${bytes.toString('base64')}`,
      ...info,
    },
  };
}
const snapshot = (ledger, selection = {}) =>
  e.createTransactionExportSnapshot(ledger, ledger.transactions[0].id, selection, now);
const clone = (value) => JSON.parse(JSON.stringify(value));

test('October report captures the shared independent reconciliation fixture without private IDs or hidden fields', () => {
  const ledger = createVerificationLedger('pdf-test', 'report-reconciliation');
  ledger.uid = 'private-account-uid';
  ledger.tokens = { auth: 'private-auth-token' };
  const result = e.createReportExportSnapshot(ledger, '2026-10-01', '2026-10-31', now);
  assert.deepEqual(
    [
      result.openingMinor,
      result.incomeMinor,
      result.expenseMinor,
      result.debtMinor,
      result.outflowMinor,
      result.netMinor,
      result.closingMinor,
      result.currentBalanceMinor,
    ],
    [75000, 200000, 25000, 30000, 55000, 145000, 220000, 268000],
  );
  assert.equal(result.transactionCount, 5);
  assert.equal(result.monthly.length, 1);
  assert.equal(result.monthly[0].netMinor, 145000);
  assert.equal(result.mode, 'sample');
  const serialized = JSON.stringify(result);
  for (const hidden of [
    'private-account-uid',
    'private-auth-token',
    'report-oct',
    'categoryId',
    'walletId',
    'incarnationId',
  ])
    assert.equal(serialized.includes(hidden), false);
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.categoryBreakdown) &&
      Object.isFrozen(result.monthly[0]),
  );
});

test('report HTML prints all reconciled values, selected bounds, separate later balance, and sample label', () => {
  const ledger = createVerificationLedger('pdf-test', 'report-reconciliation');
  const html = e.buildReportHtml(
    e.createReportExportSnapshot(ledger, '2026-10-01', '2026-10-31', now),
  );
  for (const value of [
    'RM750.00',
    'RM2,000.00',
    'RM250.00',
    'RM300.00',
    'RM550.00',
    'RM1,450.00',
    'RM2,200.00',
    'RM2,680.00',
    '2026-10-01',
    '2026-10-31',
    'Sample data',
    'including later and future entries',
  ])
    assert.ok(html.includes(value), value);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<meta charset="UTF-8">/);
  assert.match(html, /@page\{size:A4;margin:17mm\}/);
  assert.match(html, /table-header-group/);
  assert.equal(/<(script|iframe|link)\b/i.test(html), false);
  assert.equal(/(?:src|href)="https?:/i.test(html), false);
  assert.equal(/position:\s*fixed/.test(html), false);
});

test('partial, inactive, empty and debt-only reports retain exact balances and no invented activity', () => {
  const ledger = createVerificationLedger('pdf-test', 'report-reconciliation');
  const partial = e.createReportExportSnapshot(ledger, '2026-10-15', '2026-10-31', now);
  assert.equal(partial.openingMinor, 275000);
  assert.equal(partial.netMinor, -55000);
  assert.equal(partial.monthly[0].isPartialPeriod, true);
  assert.match(e.buildReportHtml(partial), /\(partial\)/);
  const empty = e.createReportExportSnapshot(fresh(), '2026-01-01', '2026-01-31', now);
  assert.equal(empty.hasActivity, false);
  assert.equal(empty.categoryBreakdown.length, 0);
  assert.match(e.buildReportHtml(empty), /No recorded activity/);
  const inactive = e.createReportExportSnapshot(ledger, '2027-01-01', '2027-01-31', now);
  assert.equal(inactive.openingMinor, 268000);
  assert.equal(inactive.closingMinor, 268000);
  assert.equal(inactive.netMinor, 0);
  const debt = e.createReportExportSnapshot(
    add(fresh(), { type: 'debt', amountMinor: 500 }),
    '2026-10-01',
    '2026-10-31',
    now,
  );
  assert.equal(debt.outflowMinor, 500);
  assert.equal(debt.netMinor, -500);
  assert.equal(debt.categoryBreakdown[0].type, 'debt');
  assert.match(e.buildReportHtml(debt), /Debt payment/);
});

test('report chart labels its latest12 subset while numeric monthly table retains the complete accepted range', () => {
  const report = e.createReportExportSnapshot(add(fresh()), '2025-01-01', '2026-10-31', now),
    html = e.buildReportHtml(report);
  assert.equal(report.monthly.length, 22);
  assert.match(html, /latest 12 months/);
  assert.ok(html.includes('2025-01'));
  assert.ok(html.includes('2026-10'));
  assert.equal((html.match(/class="track"/g) || []).length, 12);
  assert.match(html, /full selected range/);
});

test('report category and month limits refuse oversized output rather than silently dropping rows', () => {
  const base = fresh(),
    categories = Array.from({ length: 501 }, (_, i) => ({
      id: `cat-${i}`,
      name: `Category ${i}`,
      type: 'expense',
      isDefault: false,
    }));
  const transactions = categories.map((category, i) => ({
    id: `row-${i}`,
    walletId: base.wallet.id,
    title: 'Expense',
    type: 'expense',
    categoryId: category.id,
    date: '2026-10-01',
    amountMinor: 1,
  }));
  const ledger = {
    ...base,
    wallet: { ...base.wallet, hasTransactionHistory: true },
    categories: [...base.categories, ...categories],
    transactions,
  };
  assert.throws(
    () => e.createReportExportSnapshot(ledger, '2026-10-01', '2026-10-31', now),
    /500 category/,
  );
  const accepted = e.createReportExportSnapshot(
    { ...ledger, transactions: transactions.slice(0, 500) },
    '2026-10-01',
    '2026-10-31',
    now,
  );
  assert.equal(accepted.categoryBreakdown.length, 500);
  assert.ok(e.buildReportHtml(accepted).includes('Category 499'));
  assert.equal(
    e.createReportExportSnapshot(base, '2020-01-01', '2029-12-31', now).monthly.length,
    120,
  );
  assert.throws(
    () => e.createReportExportSnapshot(base, '2020-01-01', '2030-01-01', now),
    /120 calendar months/,
  );
});

test('source and snapshots are detached from later amount, date, category, wallet and context edits', () => {
  let ledger = withContext(add(fresh()), {
    notes: 'Captured notes',
    withPerson: { name: 'Alex', source: 'contacts' },
    location: { label: 'Penang', source: 'device' },
  });
  const raw = JSON.stringify(ledger),
    source = e.captureTransactionExportSource(ledger, ledger.transactions[0].id, now),
    first = e.selectTransactionExportSnapshot(source);
  assert.equal(JSON.stringify(ledger), raw);
  assert.ok(Object.isFrozen(source.context));
  ledger.transactions[0].title = 'Later title';
  ledger.transactions[0].date = '2026-11-02';
  ledger.transactions[0].amountMinor = 99999;
  ledger.transactions[0].context.notes = 'Later notes';
  ledger.wallet.name = 'Later wallet';
  ledger.categories.find((c) => c.id === 'expense-food').name = 'Later category';
  const selected = e.selectTransactionExportSnapshot(source, {
    notes: true,
    withPerson: true,
    location: true,
  });
  assert.equal(selected.title, 'Lunch');
  assert.equal(selected.date, '2026-10-17');
  assert.equal(selected.amountMinor, 1234);
  assert.equal(selected.walletName, 'Everyday wallet');
  assert.equal(selected.categoryName, 'Food & beverages');
  assert.equal(selected.details.notes, 'Captured notes');
  assert.equal(selected.createdAtMs, now);
  assert.deepEqual(first.details, {});
  assert.throws(() => e.buildTransactionHtml(source), /snapshot/);
});

test('default transaction exports omit all optional context and unknown credential/source metadata', () => {
  const asset = samplePhoto();
  const ledger = withContext(add(fresh()), {
    notes: 'PRIVATE NOTES',
    withPerson: { name: 'PRIVATE PERSON', source: 'contacts' },
    location: { label: 'PRIVATE PLACE', source: 'device' },
    photo: asset.photo,
  });
  ledger.transactions[0].apiToken = 'SECRET TOKEN';
  ledger.transactions[0].userId = 'PRIVATE UID';
  ledger.transactions[0].imageUrl = 'https://example.invalid/secret-image';
  ledger.transactions[0].coordinates = { latitude: 1, longitude: 2 };
  const result = snapshot(ledger),
    html = e.buildTransactionHtml(result),
    qr = e.buildTransactionQr(result);
  assert.deepEqual(result.selection, e.DEFAULT_CONTEXT_SELECTION);
  assert.deepEqual(result.details, {});
  assert.equal(result.attachment, null);
  for (const output of [JSON.stringify(result), html, qr.payload])
    for (const hidden of [
      'PRIVATE NOTES',
      'PRIVATE PERSON',
      'PRIVATE PLACE',
      'SECRET TOKEN',
      'PRIVATE UID',
      'secret-image',
      'latitude',
      'private-transaction-id',
      'private-wallet-owner',
      'photo-private-id',
    ])
      assert.equal(output.includes(hidden), false, hidden);
  assert.match(html, /Optional details: none selected/);
});

test('each context opt-in includes only its own data and absent selected details remain explicit', () => {
  const ledger = withContext(add(fresh()), {
    notes: 'Note text',
    withPerson: { name: 'Person text', source: 'contacts' },
    location: { label: 'Place text', source: 'device' },
  });
  for (const [key, value] of [
    ['notes', 'Note text'],
    ['withPerson', 'Person text'],
    ['location', 'Place text'],
  ]) {
    const result = snapshot(ledger, { [key]: true });
    assert.deepEqual(Object.keys(result.details), [key]);
    assert.ok(e.buildTransactionHtml(result).includes(value));
  }
  const missing = e.buildTransactionHtml(
    snapshot(add(fresh()), {
      notes: true,
      withPerson: true,
      location: true,
      photo: true,
    }),
  );
  for (const text of [
    'No notes were recorded.',
    'No person name was recorded.',
    'No place label was recorded.',
    'No photo was recorded.',
  ])
    assert.ok(missing.includes(text));
});

test('hostile title/wallet/category/notes/person/place text is escaped without becoming markup or resource loads', () => {
  const hostile = `<&> "quotes" 'apostrophe' <img src="https://example.invalid/x" onerror="bad()">`;
  let ledger = add(fresh(), { title: '<script>unsafe()</script> & "Lunch"' });
  ledger = m.updateWallet(ledger, { name: '<Wallet> & "name"' });
  ledger = m.renameCategory(ledger, 'expense-food', '<Food> & "x"');
  ledger = withContext(ledger, {
    notes: hostile,
    withPerson: { name: '<Alex> & "person"', source: 'manual' },
    location: { label: '<Place> & "address"', source: 'manual' },
  });
  const html = e.buildTransactionHtml(
    snapshot(ledger, { notes: true, withPerson: true, location: true }),
  );
  assert.ok(html.includes('&lt;script&gt;unsafe()&lt;/script&gt;'));
  assert.ok(html.includes('&lt;Wallet&gt; &amp; &quot;name&quot;'));
  assert.ok(html.includes('&#39;apostrophe&#39;'));
  assert.equal(/<script\b|<img\b|<iframe\b/i.test(html), false);
  const report = e.buildReportHtml(
    e.createReportExportSnapshot(ledger, '2026-10-01', '2026-10-31', now),
  );
  assert.ok(report.includes('&lt;Food&gt; &amp; &quot;x&quot;'));
  assert.equal(/<Food>/.test(report), false);
});

test('selected photo uses checked inline bytes; private reference fields never enter HTML or QR', () => {
  const asset = samplePhoto(),
    ledger = withContext(add(fresh()), { photo: asset.photo }),
    result = snapshot(ledger, { photo: true });
  const html = e.buildTransactionHtml(result, asset.image);
  assert.ok(html.includes('<img src="data:image/png;base64,'));
  assert.match(html, /max-height:310pt/);
  for (const hidden of ['photo-private-id', 'private-wallet-owner', 'file:///', 'content://'])
    assert.equal(html.includes(hidden), false);
  const qr = e.buildTransactionQr(result);
  assert.equal(qr.ok, true);
  assert.equal(qr.payload.includes('photo'), false);
  assert.equal(qr.payload.includes('private'), false);
  assert.equal(result.attachment.id, 'photo-private-id');
  assert.ok(Object.isFrozen(result.attachment));
});

test('missing photo is explicit; unexpected, wrong, unsafe or corrupt image data is rejected', () => {
  const asset = samplePhoto(),
    ledger = withContext(add(fresh()), { photo: asset.photo }),
    selected = snapshot(ledger, { photo: true });
  assert.throws(() => e.buildTransactionHtml(selected), /Prepare/);
  assert.match(
    e.buildTransactionHtml(selected, {
      status: 'unavailable',
      reason: 'missing',
    }),
    /unavailable \(missing\); it was omitted/,
  );
  assert.match(
    e.buildTransactionHtml(selected, {
      status: 'unavailable',
      reason: 'unreadable',
    }),
    /unreadable/,
  );
  assert.throws(() => e.buildTransactionHtml(snapshot(ledger), asset.image), /not selected/);
  assert.throws(
    () => e.buildTransactionHtml(snapshot(add(fresh()), { photo: true }), asset.image),
    /No photo reference/,
  );
  for (const change of [
    { dataUrl: 'file:///private/photo.png' },
    { dataUrl: 'https://example.invalid/photo.png' },
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { mimeType: 'image/svg+xml' },
    { byteSize: 0 },
    { byteSize: 10485761 },
    { width: asset.image.width + 1 },
    { dataUrl: 'data:image/png;base64,%%%=' },
    { dataUrl: 'data:image/png;base64,AAAA' },
    { dataUrl: 'data:image/png;base64,AA=A' },
  ])
    assert.throws(() => e.buildTransactionHtml(selected, { ...asset.image, ...change }));
  assert.throws(() =>
    e.buildTransactionHtml(selected, {
      status: 'unavailable',
      reason: 'file:///secret',
    }),
  );
});

test('photo payload size and canonical base64 padding are checked before a renderer is invoked', () => {
  const asset = samplePhoto(),
    selected = snapshot(withContext(add(fresh()), { photo: asset.photo }), {
      photo: true,
    });
  for (const payload of ['A'.repeat(Math.ceil(10485760 / 3) * 4 + 4), 'AB==', 'AAB=', 'AAA', ''])
    assert.throws(() =>
      e.buildTransactionHtml(selected, {
        ...asset.image,
        dataUrl: `data:image/png;base64,${payload}`,
      }),
    );
});

test('QR keeps exact MYR/JPY units, uses actual title/date and excludes wallet/report identity', () => {
  for (const currency of ['MYR', 'JPY']) {
    const ledger = add(fresh(currency), {
        amountMinor: 1234,
        title: 'Actual title',
        date: '2024-02-29',
      }),
      result = e.buildTransactionQr(snapshot(ledger));
    assert.equal(result.ok, true);
    assert.equal(result.summary.title, 'Actual title');
    assert.equal(result.summary.date, '2024-02-29');
    assert.equal(result.summary.amountMinor, 1234);
    assert.equal(result.summary.fractionDigits, currency === 'JPY' ? 0 : 2);
    assert.deepEqual(Object.keys(result.summary), [
      'kind',
      'version',
      'title',
      'type',
      'currency',
      'amountMinor',
      'fractionDigits',
      'date',
      'category',
    ]);
    assert.equal(result.payload.includes('Everyday wallet'), false);
  }
});

test('QR detail selection is separate from PDF choice and cannot expose uncaptured fields', () => {
  const ledger = withContext(add(fresh()), {
      notes: 'PDF note',
      withPerson: { name: 'Selected name', source: 'manual' },
      location: { label: 'Selected place', source: 'manual' },
    }),
    full = snapshot(ledger, { notes: true, withPerson: true, location: true });
  assert.equal(e.buildTransactionQr(full).summary.details, undefined);
  assert.deepEqual(e.buildTransactionQr(full, { withPerson: true }).summary.details, {
    withPerson: 'Selected name',
  });
  assert.throws(() => e.buildTransactionQr(snapshot(ledger), { notes: true }), /not captured/);
  assert.throws(() => e.buildTransactionQr(full, { photo: true }), /true\/false/);
});

test('ASCII JSON QR serialization round-trips multilingual/emoji text with exact UTF8 byte count', () => {
  let ledger = add(fresh(), { title: '午餐 Café ☕ 🧾' });
  ledger = m.renameCategory(ledger, 'expense-food', '食物 & café');
  ledger = withContext(ledger, { notes: 'Line1\n第二行 🧑‍💻' });
  const result = e.buildTransactionQr(snapshot(ledger, { notes: true }), {
    notes: true,
  });
  assert.equal(result.ok, true);
  assert.match(result.payload, /\\u/);
  assert.equal(/[^\x00-\x7f]/.test(result.payload), false);
  assert.deepEqual(JSON.parse(result.payload), result.summary);
  assert.equal(JSON.parse(result.payload).title, '午餐 Café ☕ 🧾');
  assert.equal(result.byteLength, Buffer.byteLength(result.payload, 'utf8'));
  for (const value of ['ASCII', 'é', '汉字', '🧾', 'a🧾é汉', '\ud800', '\udc00'])
    assert.equal(e.utf8ByteLength(value), Buffer.byteLength(value, 'utf8'));
});

test('maximum normal mandatory model fields fit QR without truncation', () => {
  let ledger = add(fresh(), {
    title: '字'.repeat(80),
    amountMinor: 999999999,
    date: '2100-12-31',
  });
  ledger = m.renameCategory(ledger, 'expense-food', '字'.repeat(40));
  const qr = e.buildTransactionQr(snapshot(ledger));
  assert.equal(qr.ok, true);
  assert.equal(qr.byteLength, 892);
  assert.equal(qr.summary.title.length, 80);
  assert.equal(qr.summary.category.length, 40);
  assert.equal(qr.summary.amountMinor, 999999999);
});

test('QR accepts exactly1024bytes and rejects1025 without returning a partial payload or truncated details', () => {
  const base = add(fresh()),
    one = snapshot(withContext(base, { notes: 'x' }), { notes: true }),
    length = e.buildTransactionQr(one, { notes: true }).byteLength;
  const count = 1 + 1024 - length;
  const exact = e.buildTransactionQr(
    snapshot(withContext(base, { notes: 'x'.repeat(count) }), { notes: true }),
    { notes: true },
  );
  assert.equal(exact.ok, true);
  assert.equal(exact.byteLength, 1024);
  assert.equal(JSON.parse(exact.payload).details.notes.length, count);
  const over = e.buildTransactionQr(
    snapshot(withContext(base, { notes: 'x'.repeat(count + 1) }), {
      notes: true,
    }),
    { notes: true },
  );
  assert.deepEqual(over, {
    ok: false,
    reason: 'too-large',
    byteLength: 1025,
    maxBytes: 1024,
  });
  assert.equal(Object.hasOwn(over, 'payload'), false);
  const full = snapshot(withContext(base, { notes: 'x'.repeat(2000) }), {
    notes: true,
  });
  assert.equal(e.buildTransactionQr(full, { notes: true }).ok, false);
  assert.equal(e.buildTransactionQr(full).ok, true);
});

test('JPY printable amounts remain whole yen and debt remains a separately named transaction type', () => {
  const ledger = add(fresh('JPY'), { type: 'debt', amountMinor: 1234 });
  const html = e.buildTransactionHtml(snapshot(ledger));
  assert.ok(html.includes('¥1,234'));
  assert.equal(html.includes('¥1,234.00'), false);
  assert.ok(html.includes('Debt payment'));
});

test('invalid time/range/transaction/currency/options and tampered snapshot reconciliation fail explicitly', () => {
  const ledger = add(fresh());
  for (const time of [NaN, Infinity, -1, 0.5, 8640000000000001])
    assert.throws(() =>
      e.createTransactionExportSnapshot(ledger, ledger.transactions[0].id, {}, time),
    );
  assert.throws(() => e.createReportExportSnapshot(ledger, '2026-10-31', '2026-10-01', now));
  assert.throws(() => e.createReportExportSnapshot(ledger, '2026-02-30', '2026-03-01', now));
  assert.throws(() => e.createTransactionExportSnapshot(ledger, 'missing', {}, now));
  for (const selection of [null, { notes: 'yes' }, { photo: 1 }, { apiToken: true }])
    assert.throws(() => snapshot(ledger, selection));
  const tx = clone(snapshot(ledger));
  delete tx.currency;
  assert.throws(() => e.buildTransactionHtml(tx));
  for (const change of [
    { amountMinor: 0 },
    { amountMinor: 1.2 },
    { date: '2026-02-30' },
    { currency: 'XXX' },
    { details: { notes: 'hidden' } },
  ])
    assert.throws(() => e.buildTransactionQr({ ...snapshot(ledger), ...change }));
  const report = e.createReportExportSnapshot(ledger, '2026-10-01', '2026-10-31', now);
  for (const changed of [
    { ...report, closingMinor: 1 },
    { ...report, incomeMinor: NaN },
    { ...report, categoryBreakdown: [] },
    { ...report, monthly: [{ ...report.monthly[0], netMinor: 0 }] },
    { ...report, monthly: [{ ...report.monthly[0], startDate: '2026-10-02' }] },
  ])
    assert.throws(() => e.buildReportHtml(changed));
});

test('export calls are deterministic and leave all financial/planning/context/achievement bytes unchanged', () => {
  let ledger = withContext(add(fresh()), { notes: 'Stable' });
  ledger = m.saveBudget(
    ledger,
    m.budgetFromDraft(
      {
        categoryId: 'expense-food',
        amount: '100',
        period: 'month',
        anchorDate: '2026-10-01',
      },
      'budget',
      ledger,
    ),
  );
  ledger = m.saveGoal(ledger, m.goalFromDraft({ kind: 'home', amount: '1000' }, 'goal', ledger));
  const raw = JSON.stringify(ledger);
  const tx = snapshot(ledger, { notes: true }),
    report = e.createReportExportSnapshot(ledger, '2026-10-01', '2026-10-31', now);
  assert.equal(e.buildTransactionHtml(tx), e.buildTransactionHtml(tx));
  assert.equal(e.buildReportHtml(report), e.buildReportHtml(report));
  assert.deepEqual(
    e.buildTransactionQr(tx, { notes: true }),
    e.buildTransactionQr(tx, { notes: true }),
  );
  assert.equal(JSON.stringify(ledger), raw);
});

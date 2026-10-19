const {
  validateLedger,
  validDate,
  currencyInfo,
  formatMoney,
  MAX_AMOUNT_MINOR,
  MAX_TRANSACTIONS,
  TRANSACTION_TYPES,
} = require('./model');
const { periodReport, monthlySeries } = require('./reports');
const {
  contextForTransaction,
  validateTransactionContext,
  validatePhotoRef,
  validatePhotoInspection,
  MAX_PHOTO_BYTES,
  MAX_NOTES_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  MAX_PLACE_LABEL_LENGTH,
} = require('./transactionContext');
const { inspectImageHeader } = require('../attachments/imageHeader');

const DEFAULT_CONTEXT_SELECTION = Object.freeze({
  notes: false,
  withPerson: false,
  location: false,
  photo: false,
});
const MAX_QR_UTF8_BYTES = 1024,
  MAX_EXPORT_CATEGORY_ROWS = 500,
  MAX_EXPORT_MONTHS = 120,
  MAX_EXPORT_HTML_BYTES = 20 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const types = { income: 'Income', expense: 'Expense', debt: 'Debt payment' };

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function text(value, maximum, empty = false) {
  return (
    typeof value === 'string' &&
    value.length <= maximum &&
    (empty || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}
function money(value, nonnegative = false) {
  return Number.isSafeInteger(value) && (!nonnegative || value >= 0);
}
function safeAdd(a, b) {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new Error('Export money exceeds the exact-integer range.');
  return sum;
}
function clock(now) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000)
    throw new Error('A valid export creation time is required.');
  return now;
}
function monthOrdinal(date) {
  const [year, month] = date.split('-').map(Number);
  return year * 12 + month - 1;
}
function monthEnd(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}
function range(start, end) {
  if (!validDate(start) || !validDate(end) || start > end)
    throw new Error('Choose a valid export range in chronological order.');
  const count = monthOrdinal(end) - monthOrdinal(start) + 1;
  if (count > MAX_EXPORT_MONTHS)
    throw new Error('Choose a smaller report range of at most 120 calendar months.');
  return count;
}

function escapeHtml(value) {
  if (typeof value !== 'string') throw new Error('HTML text must be a string.');
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}
function utf8ByteLength(value) {
  if (typeof value !== 'string') throw new Error('UTF-8 length requires a string.');
  let size = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 128) size++;
    else if (unit < 2048) size += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      size += 4;
      i++;
    } else size += 3;
  }
  return size;
}

function selectFlags(value = {}, photoAllowed = true) {
  const allowed = photoAllowed
    ? ['notes', 'withPerson', 'location', 'photo']
    : ['notes', 'withPerson', 'location'];
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key) || typeof value[key] !== 'boolean')
  )
    throw new Error('Choose explicit true/false export options.');
  const result = {};
  for (const key of allowed) result[key] = value[key] ?? false;
  return result;
}
function copyPhoto(value) {
  if (value === null) return null;
  const p = validatePhotoRef(value);
  return {
    id: p.id,
    ownerIncarnationId: p.ownerIncarnationId,
    fileName: p.fileName,
    mimeType: p.mimeType,
    width: p.width,
    height: p.height,
    byteSize: p.byteSize,
  };
}
function base(ledger, nowMs) {
  return {
    version: 1,
    createdAtMs: clock(nowMs),
    mode: ledger.mode,
    walletName: ledger.wallet.name,
    currency: ledger.wallet.currency,
  };
}
function assertBase(snapshot, kind) {
  if (
    !object(snapshot) ||
    snapshot.kind !== kind ||
    snapshot.version !== 1 ||
    !['sample', 'local'].includes(snapshot.mode) ||
    !text(snapshot.walletName, 80) ||
    typeof snapshot.currency !== 'string'
  )
    throw new Error('The export snapshot is invalid.');
  clock(snapshot.createdAtMs);
  currencyInfo(snapshot.currency);
}
function assertTransactionFields(snapshot) {
  if (
    !text(snapshot.title, 80) ||
    !text(snapshot.categoryName, 40) ||
    !TRANSACTION_TYPES.includes(snapshot.type) ||
    !validDate(snapshot.date) ||
    !money(snapshot.amountMinor, true) ||
    snapshot.amountMinor < 1 ||
    snapshot.amountMinor > MAX_AMOUNT_MINOR
  )
    throw new Error('The transaction export contains invalid recorded values.');
}

function createReportExportSnapshot(ledger, startDate, endDate, nowMs) {
  validateLedger(ledger);
  range(startDate, endDate);
  const report = periodReport(ledger, startDate, endDate);
  if (report.categoryBreakdown.length > MAX_EXPORT_CATEGORY_ROWS)
    throw new Error('Choose a smaller report range with at most 500 category rows.');
  const snapshot = {
    ...base(ledger, nowMs),
    kind: 'report',
    startDate,
    endDate,
    openingMinor: report.openingMinor,
    incomeMinor: report.incomeMinor,
    expenseMinor: report.expenseMinor,
    debtMinor: report.debtMinor,
    outflowMinor: report.outflowMinor,
    netMinor: report.netMinor,
    closingMinor: report.closingMinor,
    currentBalanceMinor: report.currentBalanceMinor,
    transactionCount: report.transactionCount,
    hasActivity: report.hasActivity,
    categoryBreakdown: report.categoryBreakdown.map((row) => ({
      categoryName: row.categoryName,
      type: row.type,
      amountMinor: row.amountMinor,
      typeTotalMinor: row.typeTotalMinor,
      shareOfType: row.shareOfType,
      transactionCount: row.transactionCount,
    })),
    monthly: monthlySeries(ledger, startDate, endDate).map((row) => ({
      month: row.month,
      startDate: row.startDate,
      endDate: row.endDate,
      netMinor: row.netMinor,
      isPartialPeriod: row.isPartialPeriod,
    })),
  };
  assertReport(snapshot);
  return freeze(snapshot);
}

function captureTransactionExportSource(ledger, transactionId, nowMs) {
  validateLedger(ledger);
  const transaction = ledger.transactions.find((item) => item.id === transactionId);
  if (!transaction) throw new Error('This transaction no longer exists.');
  const category = ledger.categories.find((item) => item.id === transaction.categoryId);
  const context = contextForTransaction(transaction);
  const source = {
    ...base(ledger, nowMs),
    kind: 'transaction-export-source',
    title: transaction.title,
    type: transaction.type,
    date: transaction.date,
    amountMinor: transaction.amountMinor,
    categoryName: category.name,
    context: {
      notes: context.notes,
      photo: copyPhoto(context.photo),
      withPerson: context.withPerson
        ? { name: context.withPerson.name, source: context.withPerson.source }
        : null,
      location: context.location
        ? { label: context.location.label, source: context.location.source }
        : null,
    },
  };
  assertBase(source, 'transaction-export-source');
  assertTransactionFields(source);
  validateTransactionContext(source.context);
  return freeze(source);
}

function selectTransactionExportSnapshot(source, selection = {}) {
  assertBase(source, 'transaction-export-source');
  assertTransactionFields(source);
  validateTransactionContext(source.context);
  const chosen = selectFlags(selection),
    details = {};
  if (chosen.notes) details.notes = source.context.notes;
  if (chosen.withPerson) details.withPerson = source.context.withPerson?.name ?? null;
  if (chosen.location) details.location = source.context.location?.label ?? null;
  const snapshot = {
    kind: 'transaction',
    version: 1,
    createdAtMs: source.createdAtMs,
    mode: source.mode,
    walletName: source.walletName,
    currency: source.currency,
    title: source.title,
    type: source.type,
    date: source.date,
    amountMinor: source.amountMinor,
    categoryName: source.categoryName,
    selection: chosen,
    details,
    attachment: chosen.photo ? copyPhoto(source.context.photo) : null,
  };
  assertTransaction(snapshot);
  return freeze(snapshot);
}
function createTransactionExportSnapshot(
  ledger,
  transactionId,
  selection = {},
  nowMs = Date.now(),
) {
  return selectTransactionExportSnapshot(
    captureTransactionExportSource(ledger, transactionId, nowMs),
    selection,
  );
}

function assertTransaction(snapshot) {
  assertBase(snapshot, 'transaction');
  assertTransactionFields(snapshot);
  if (
    !object(snapshot.selection) ||
    !Object.keys(DEFAULT_CONTEXT_SELECTION).every((key) => own(snapshot.selection, key))
  )
    throw new Error('The export context selection is incomplete.');
  const selected = selectFlags(snapshot.selection);
  if (
    !object(snapshot.details) ||
    Object.keys(snapshot.details).some((key) => !['notes', 'withPerson', 'location'].includes(key))
  )
    throw new Error('The transaction export detail fields are invalid.');
  for (const [key, limit] of [
    ['notes', MAX_NOTES_LENGTH],
    ['withPerson', MAX_PERSON_NAME_LENGTH],
    ['location', MAX_PLACE_LABEL_LENGTH],
  ]) {
    if (!selected[key]) {
      if (own(snapshot.details, key))
        throw new Error('An unselected optional detail cannot be exported.');
    } else if (
      !own(snapshot.details, key) ||
      (key === 'notes'
        ? !text(snapshot.details[key], limit, true)
        : snapshot.details[key] !== null && !text(snapshot.details[key], limit))
    )
      throw new Error('A selected export detail is invalid.');
  }
  if (snapshot.attachment !== null) {
    if (!selected.photo) throw new Error('An unselected photo cannot be exported.');
    validatePhotoRef(snapshot.attachment);
  }
}

function assertReport(snapshot) {
  assertBase(snapshot, 'report');
  const months = range(snapshot.startDate, snapshot.endDate);
  for (const key of [
    'openingMinor',
    'incomeMinor',
    'expenseMinor',
    'debtMinor',
    'outflowMinor',
    'netMinor',
    'closingMinor',
    'currentBalanceMinor',
  ])
    if (
      !money(
        snapshot[key],
        ['incomeMinor', 'expenseMinor', 'debtMinor', 'outflowMinor'].includes(key),
      )
    )
      throw new Error('The report contains invalid money values.');
  if (
    snapshot.outflowMinor !== safeAdd(snapshot.expenseMinor, snapshot.debtMinor) ||
    snapshot.netMinor !== safeAdd(snapshot.incomeMinor, -snapshot.outflowMinor) ||
    snapshot.closingMinor !== safeAdd(snapshot.openingMinor, snapshot.netMinor)
  )
    throw new Error('The report snapshot does not reconcile.');
  if (
    !Number.isInteger(snapshot.transactionCount) ||
    snapshot.transactionCount < 0 ||
    snapshot.transactionCount > MAX_TRANSACTIONS ||
    snapshot.hasActivity !== snapshot.transactionCount > 0 ||
    !Array.isArray(snapshot.categoryBreakdown) ||
    snapshot.categoryBreakdown.length > MAX_EXPORT_CATEGORY_ROWS ||
    !Array.isArray(snapshot.monthly) ||
    snapshot.monthly.length !== months
  )
    throw new Error('The report rows or activity counts are invalid.');
  const sums = { income: 0, expense: 0, debt: 0 };
  let count = 0;
  for (const row of snapshot.categoryBreakdown) {
    if (
      !object(row) ||
      !text(row.categoryName, 40) ||
      !TRANSACTION_TYPES.includes(row.type) ||
      !money(row.amountMinor, true) ||
      row.amountMinor === 0 ||
      row.typeTotalMinor !== snapshot[`${row.type}Minor`] ||
      row.shareOfType !== row.amountMinor / row.typeTotalMinor ||
      !Number.isInteger(row.transactionCount) ||
      row.transactionCount < 1 ||
      row.transactionCount > MAX_TRANSACTIONS
    )
      throw new Error('The category breakdown is invalid.');
    sums[row.type] = safeAdd(sums[row.type], row.amountMinor);
    count += row.transactionCount;
  }
  if (
    count !== snapshot.transactionCount ||
    TRANSACTION_TYPES.some((type) => sums[type] !== snapshot[`${type}Minor`])
  )
    throw new Error('The category totals do not reconcile with this report.');
  let net = 0;
  for (let i = 0; i < snapshot.monthly.length; i++) {
    const row = snapshot.monthly[i];
    if (
      !object(row) ||
      typeof row.month !== 'string' ||
      !validDate(`${row.month}-01`) ||
      monthOrdinal(row.month) !== monthOrdinal(snapshot.startDate) + i ||
      !money(row.netMinor)
    )
      throw new Error('The monthly report rows are invalid.');
    const start = i === 0 ? snapshot.startDate : `${row.month}-01`,
      end = i === snapshot.monthly.length - 1 ? snapshot.endDate : monthEnd(row.month);
    if (
      row.startDate !== start ||
      row.endDate !== end ||
      row.isPartialPeriod !== (start !== `${row.month}-01` || end !== monthEnd(row.month))
    )
      throw new Error('The monthly range boundaries are invalid.');
    net = safeAdd(net, row.netMinor);
  }
  if (net !== snapshot.netMinor)
    throw new Error('Monthly net values do not reconcile with the selected period.');
}

const CSS = `@page{size:A4;margin:17mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:11pt;line-height:1.45;color:#25222e;background:#fff;margin:0}h1{font-size:23pt;line-height:1.2;margin:0 0 8pt;color:#57358f}h2{font-size:14pt;margin:20pt 0 8pt;break-after:avoid}p{margin:6pt 0}.muted{color:#595362}.sample{font-weight:bold;color:#57358f}.summary{width:100%;border-collapse:collapse;margin-top:14pt}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th,td{padding:7pt 6pt;border-bottom:1px solid #ddd6e5;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}th{text-align:left;background:#f0ebf6}tr{break-inside:avoid;page-break-inside:avoid}.number{text-align:right}.notes{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.photo{break-inside:avoid;margin:12pt 0}.photo img{display:block;max-width:100%;max-height:310pt;width:auto;height:auto;margin:auto}.chart-block{break-inside:avoid;page-break-inside:avoid}.chart th:first-child{width:20%}.chart th:last-child{width:24%}.track{width:100%;height:13pt;position:relative;background:#faf8fc}.zero{position:absolute;left:50%;top:0;height:100%;border-left:1px solid #706a77}.bar{position:absolute;top:2pt;height:9pt}.positive{background:#268660}.negative{background:#8550b4}.footer{margin-top:22pt;padding-top:8pt;border-top:1px solid #ddd6e5;color:#595362;font-size:9pt}`;
function documentHtml(title, snapshot, body) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(snapshot.walletName)}</p>${snapshot.mode === 'sample' ? '<p class="sample">Sample data</p>' : ''}<p class="muted">Created ${escapeHtml(new Date(snapshot.createdAtMs).toISOString())}</p>${body}<p class="footer">MyMoneyManagement · Snapshot of recorded data. This export does not change your records.</p></body></html>`;
  if (utf8ByteLength(html) > MAX_EXPORT_HTML_BYTES)
    throw new Error('This export is too large. Select fewer details or a smaller report range.');
  return html;
}
function moneyText(value, currency) {
  return escapeHtml(formatMoney(value, currency));
}
function summaryRows(rows, currency) {
  return `<table class="summary"><tbody>${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td class="number">${moneyText(value, currency)}</td></tr>`).join('')}</tbody></table>`;
}

function buildReportHtml(snapshot) {
  assertReport(snapshot);
  const currency = snapshot.currency;
  let body = `<p>Inclusive period: ${escapeHtml(snapshot.startDate)} to ${escapeHtml(snapshot.endDate)} · ${snapshot.transactionCount} recorded transactions · ${escapeHtml(currency)}</p>`;
  body += summaryRows(
    [
      ['Opening balance', snapshot.openingMinor],
      ['Income', snapshot.incomeMinor],
      ['Expenses', snapshot.expenseMinor],
      ['Debt payments', snapshot.debtMinor],
      ['Total outflow', snapshot.outflowMinor],
      ['Net for selected period', snapshot.netMinor],
      ['Closing balance through selected end date', snapshot.closingMinor],
      ['All-record balance, including later and future entries', snapshot.currentBalanceMinor],
    ],
    currency,
  );
  body += '<h2>Category breakdown</h2>';
  body += snapshot.categoryBreakdown.length
    ? `<table><thead><tr><th>Category / type</th><th class="number">Recorded amount</th><th class="number">Share within type</th><th class="number">Entries</th></tr></thead><tbody>${snapshot.categoryBreakdown.map((row) => `<tr><td>${escapeHtml(row.categoryName)}<br><span class="muted">${types[row.type]}</span></td><td class="number">${moneyText(row.amountMinor, currency)}</td><td class="number">${(row.shareOfType * 100).toFixed(2)}%</td><td class="number">${row.transactionCount}</td></tr>`).join('')}</tbody></table>`
    : '<p>No recorded activity in this period. Earlier balances are carried forward.</p>';
  const chart = snapshot.monthly.slice(-12),
    max = Math.max(1, ...chart.map((row) => Math.abs(row.netMinor)));
  body += `<section class="chart-block"><h2>Monthly net</h2><p class="muted">${snapshot.monthly.length > 12 ? 'Chart shows the latest 12 months in this selected range. The full numeric table follows.' : 'Chart shows the selected calendar months.'} Partial edge months use only the selected dates. The center line is zero.</p><table class="chart"><thead><tr><th>Month</th><th>Net around zero</th><th class="number">Net amount</th></tr></thead><tbody>${chart
    .map((row) => {
      const width = ((Math.abs(row.netMinor) / max) * 50).toFixed(4);
      return `<tr><td>${row.month}${row.isPartialPeriod ? ' (partial)' : ''}</td><td><div class="track"><span class="zero"></span><span class="bar ${row.netMinor < 0 ? 'negative' : 'positive'}" style="${row.netMinor < 0 ? 'right' : 'left'}:50%;width:${width}%"></span></div></td><td class="number">${moneyText(row.netMinor, currency)}</td></tr>`;
    })
    .join('')}</tbody></table></section>`;
  body += `<h2>Monthly values for the full selected range</h2><table><thead><tr><th>Month</th><th>Included dates</th><th class="number">Net amount</th></tr></thead><tbody>${snapshot.monthly.map((row) => `<tr><td>${row.month}${row.isPartialPeriod ? ' (partial)' : ''}</td><td>${row.startDate} to ${row.endDate}</td><td class="number">${moneyText(row.netMinor, currency)}</td></tr>`).join('')}</tbody></table>`;
  return documentHtml('Recorded financial report', snapshot, body);
}

function decodeBase64(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error('The prepared photo encoding is invalid.');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0,
    length = (value.length / 4) * 3 - padding;
  if (length < 1 || length > MAX_PHOTO_BYTES) throw new Error('The prepared photo is too large.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
    bytes = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = alphabet.indexOf(value[i]),
      b = alphabet.indexOf(value[i + 1]),
      cc = value[i + 2] === '=' ? 0 : alphabet.indexOf(value[i + 2]),
      d = value[i + 3] === '=' ? 0 : alphabet.indexOf(value[i + 3]);
    const bits = a * 262144 + b * 4096 + cc * 64 + d;
    bytes[offset++] = (bits >>> 16) & 255;
    if (offset < length) bytes[offset++] = (bits >>> 8) & 255;
    if (offset < length) bytes[offset++] = bits & 255;
  }
  if (
    (padding === 2 && (alphabet.indexOf(value[value.length - 3]) & 15) !== 0) ||
    (padding === 1 && (alphabet.indexOf(value[value.length - 2]) & 3) !== 0)
  )
    throw new Error('The prepared photo has noncanonical base64 padding.');
  return bytes;
}

function imageMarkup(snapshot, image) {
  if (!snapshot.selection.photo) {
    if (image !== undefined) throw new Error('A photo was not selected for this export.');
    return '';
  }
  if (!snapshot.attachment) {
    if (image !== undefined) throw new Error('No photo reference was captured for this export.');
    return '<h2>Photo</h2><p>No photo was recorded.</p>';
  }
  if (!object(image))
    throw new Error(
      'Prepare the selected photo or explicitly report it unavailable before exporting.',
    );
  if (image.status === 'unavailable') {
    if (!['missing', 'unreadable'].includes(image.reason))
      throw new Error('The photo omission status is invalid.');
    return `<h2>Photo</h2><p>Selected photo unavailable (${image.reason}); it was omitted from this PDF.</p>`;
  }
  if (image.status !== 'ready') throw new Error('The prepared photo status is invalid.');
  validatePhotoInspection(image);
  const prefix = `data:${image.mimeType};base64,`;
  if (typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(prefix))
    throw new Error('Only an inline supported photo can be included.');
  const bytes = decodeBase64(image.dataUrl.slice(prefix.length)),
    actual = inspectImageHeader(bytes);
  if (
    ['mimeType', 'width', 'height', 'byteSize'].some(
      (key) => actual[key] !== image[key] || image[key] !== snapshot.attachment[key],
    )
  )
    throw new Error('The prepared photo does not match the captured photo metadata.');
  return `<h2>Photo</h2><div class="photo"><img src="${image.dataUrl}" alt="Selected transaction photo"></div>`;
}

function buildTransactionHtml(snapshot, image) {
  assertTransaction(snapshot);
  let body = `<h2>${escapeHtml(snapshot.title)}</h2><p>${types[snapshot.type]} · ${escapeHtml(snapshot.date)} · ${escapeHtml(snapshot.categoryName)}</p>${summaryRows([['Recorded amount', snapshot.amountMinor]], snapshot.currency)}`;
  const included = ['notes', 'withPerson', 'location', 'photo'].filter(
    (key) => snapshot.selection[key],
  );
  body += `<p class="muted">Optional details: ${included.length ? included.map((key) => ({ notes: 'notes', withPerson: 'person name', location: 'place label', photo: 'photo' })[key]).join(', ') : 'none selected'}.</p>`;
  if (snapshot.selection.notes)
    body += `<h2>Notes</h2><div class="notes">${snapshot.details.notes ? escapeHtml(snapshot.details.notes) : 'No notes were recorded.'}</div>`;
  if (snapshot.selection.withPerson)
    body += `<h2>Person</h2><p>${snapshot.details.withPerson ? escapeHtml(snapshot.details.withPerson) : 'No person name was recorded.'}</p>`;
  if (snapshot.selection.location)
    body += `<h2>Place</h2><p>${snapshot.details.location ? escapeHtml(snapshot.details.location) : 'No place label was recorded.'}</p>`;
  body += imageMarkup(snapshot, image);
  return documentHtml('Recorded transaction', snapshot, body);
}

function buildTransactionQr(snapshot, selection = {}) {
  assertTransaction(snapshot);
  const selected = selectFlags(selection, false);
  const summary = {
    kind: 'mymoney.transaction-summary',
    version: 1,
    title: snapshot.title,
    type: snapshot.type,
    currency: snapshot.currency,
    amountMinor: snapshot.amountMinor,
    fractionDigits: currencyInfo(snapshot.currency).decimals,
    date: snapshot.date,
    category: snapshot.categoryName,
  };
  const details = {};
  for (const key of ['notes', 'withPerson', 'location'])
    if (selected[key]) {
      if (!snapshot.selection[key])
        throw new Error(
          'This optional detail was not captured. Select it explicitly before creating a QR.',
        );
      if (snapshot.details[key]) details[key] = snapshot.details[key];
    }
  if (Object.keys(details).length) summary.details = details;
  const payload = JSON.stringify(summary).replace(
      /[^\x00-\x7f]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    byteLength = utf8ByteLength(payload);
  if (byteLength > MAX_QR_UTF8_BYTES)
    return freeze({
      ok: false,
      reason: 'too-large',
      byteLength,
      maxBytes: MAX_QR_UTF8_BYTES,
    });
  return freeze({
    ok: true,
    payload,
    byteLength,
    maxBytes: MAX_QR_UTF8_BYTES,
    summary: freeze(summary),
  });
}

module.exports = {
  DEFAULT_CONTEXT_SELECTION,
  MAX_QR_UTF8_BYTES,
  MAX_EXPORT_CATEGORY_ROWS,
  MAX_EXPORT_MONTHS,
  MAX_EXPORT_HTML_BYTES,
  createReportExportSnapshot,
  captureTransactionExportSource,
  selectTransactionExportSnapshot,
  createTransactionExportSnapshot,
  buildReportHtml,
  buildTransactionHtml,
  buildTransactionQr,
  escapeHtml,
  utf8ByteLength,
};

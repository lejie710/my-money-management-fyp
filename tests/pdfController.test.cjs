const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPdfController,
  PdfExportError,
  MAX_PDF_BYTES,
  MAX_PDF_CACHE_BYTES,
  MAX_PDF_FILES,
  PDF_RETENTION_MS,
} = require('../src/exports/pdfController');
const {
  isPdfHeader,
  readPdfEnvelope,
  isPdfXrefStart,
  PDF_TAIL_SCAN_BYTES,
  validatePdfFileName,
  validateCacheUri,
  photoDataUrl,
} = require('../src/exports/pdfBytes');
const { inspectImageHeader } = require('../src/attachments/imageHeader');
const fs = require('node:fs');
const path = require('node:path');
let sequence = 0;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const snapshot = () => ({
  kind: 'report',
  title: 'Synthetic private title',
  details: { notes: 'Synthetic private note' },
});
function fixture() {
  const raw = new Map(),
    files = new Map(),
    calls = [];
  let now = 1800000000000,
    ids = 0,
    prints = 0,
    active = true;
  const owner = {
    scope: { kind: 'test', namespace: 'pdf-stage-' + ++sequence },
    actor: { kind: 'local' },
    incarnationId: 'wallet-a',
  };
  const storage = {
    async getItem(key) {
      return raw.get(key) ?? null;
    },
    async setItem(key, value) {
      raw.set(key, value);
    },
  };
  const adapter = {
    async printHtml(html) {
      calls.push(['print', html]);
      const uri = 'file:///cache/Print/' + ++prints + '.pdf';
      files.set(uri, { byteSize: 128, pdfHeaderValid: true });
      return { uri, numberOfPages: 2 };
    },
    async inspectPdf(uri) {
      return files.has(uri) ? { ...files.get(uri) } : null;
    },
    uriFor(name) {
      return 'file:///cache/pdf-exports/' + validatePdfFileName(name);
    },
    async retainOwnedPdf(uri, name) {
      calls.push(['retain', name]);
      const target = this.uriFor(name);
      if (files.has(target)) throw new PdfExportError('TARGET_EXISTS', 'Exists');
      files.set(target, files.get(uri));
      files.delete(uri);
    },
    async removeOwned(name) {
      calls.push(['delete', name]);
      files.delete(this.uriFor(name));
    },
    async cacheUsage() {
      const list = [...files].filter(([uri]) => uri.startsWith('file:///cache/pdf-exports/'));
      return {
        count: list.length,
        byteSize: list.reduce((sum, [, info]) => sum + info.byteSize, 0),
      };
    },
    async sharingAvailable() {
      calls.push(['available']);
      return true;
    },
    async sharePdf(uri) {
      calls.push(['share', uri]);
    },
    async previewPdf(uri) {
      calls.push(['preview', uri]);
    },
  };
  const options = {
    owner,
    storage,
    adapter,
    now: () => now,
    newId: () => 'fixture-' + ++ids,
    isCurrent: () => active,
    buildHtml(value, image) {
      return '<html>' + value.title + (image ? '|image' : '') + '</html>';
    },
  };
  const controller = createPdfController(options);
  return {
    owner,
    options,
    storage,
    adapter,
    controller,
    raw,
    files,
    calls,
    state: () => JSON.parse(raw.get(controller.journalKey)),
    setNow: (value) => {
      now = value;
    },
    now: () => now,
    setActive: (value) => {
      active = value;
    },
    count: (type) => calls.filter((call) => call[0] === type).length,
  };
}
const errorCode = (code) => (error) => error instanceof PdfExportError && error.code === code;

test('creation validates and registers an immutable PDF without sharing or storing its contents', async () => {
  const f = fixture(),
    input = snapshot(),
    pending = f.controller.prepare(input);
  input.title = 'Later edit';
  const { artifact } = await pending;
  assert.equal(f.calls[0][1], '<html>Synthetic private title</html>');
  assert.equal(artifact.pageCount, 2);
  assert.equal(artifact.byteSize, 128);
  assert.ok(Object.isFrozen(artifact));
  assert.equal(f.count('share'), 0);
  assert.equal(f.count('preview'), 0);
  assert.equal(f.state().entries[0].phase, 'ready');
  const serialized = f.raw.get(f.controller.journalKey);
  assert.ok(!serialized.includes('Synthetic private'));
  assert.ok(!serialized.includes('<html>'));
  assert.ok(!serialized.includes('file:///'));
});

test('write rejection before reservation prevents every native print effect', async () => {
  const f = fixture();
  f.storage.setItem = async () => {
    throw Error('storage offline');
  };
  await assert.rejects(f.controller.prepare(snapshot()), errorCode('CACHE_SAVE'));
  assert.equal(f.count('print'), 0);
});

test('write-then-throw is resolved by exact readback without duplicate print or sharing', async () => {
  const f = fixture();
  f.storage.setItem = async (key, value) => {
    f.raw.set(key, value);
    throw Error('after durable write');
  };
  const { artifact } = await f.controller.prepare(snapshot());
  assert.equal(f.count('print'), 1);
  assert.equal(f.state().entries.length, 1);
  assert.deepEqual(await f.controller.share(artifact), { status: 'requested' });
  assert.equal(f.count('share'), 1);
});

test('unknown reservation write/read outcome stops effects until a later validated read', async () => {
  const f = fixture();
  let unreadable = false;
  f.storage.setItem = async (key, value) => {
    f.raw.set(key, value);
    unreadable = true;
    throw Error();
  };
  f.storage.getItem = async (key) => {
    if (unreadable) throw Error();
    return f.raw.get(key) ?? null;
  };
  await assert.rejects(f.controller.prepare(snapshot()), errorCode('CACHE_UNCERTAIN'));
  assert.equal(f.count('print'), 0);
  assert.equal(f.state().entries[0].phase, 'reserved');
});

test('a known journal disappearing is not reset from cached assumptions', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  f.raw.delete(f.controller.journalKey);
  await assert.rejects(f.controller.share(artifact), errorCode('CACHE_UNCERTAIN'));
  assert.equal(f.count('share'), 0);
  assert.equal(f.files.has(artifact.uri), true);
});

test('print rejection and invalid PDF headers, sizes or page counts cannot return success', async () => {
  for (const kind of [
    'reject',
    'header',
    'oversize',
    'empty',
    'header-only',
    'zero-pages',
    'fraction-pages',
    'too-many-pages',
  ]) {
    const f = fixture(),
      native = f.adapter.printHtml;
    f.adapter.printHtml = async (html) => {
      if (kind === 'reject') throw Error('native failed');
      const printed = await native.call(f.adapter, html);
      if (kind === 'header') f.files.get(printed.uri).pdfHeaderValid = false;
      if (kind === 'oversize') f.files.get(printed.uri).byteSize = MAX_PDF_BYTES + 1;
      if (kind === 'empty') f.files.get(printed.uri).byteSize = 0;
      if (kind === 'header-only') f.files.get(printed.uri).byteSize = 8;
      if (kind === 'zero-pages') printed.numberOfPages = 0;
      if (kind === 'fraction-pages') printed.numberOfPages = 1.5;
      if (kind === 'too-many-pages') printed.numberOfPages = 501;
      return printed;
    };
    await assert.rejects(f.controller.prepare(snapshot()));
    assert.equal(f.count('retain'), 0);
    assert.equal(f.count('share'), 0);
    assert.equal(f.state().entries[0].phase, 'reserved');
  }
});

test('known unavailable Print capability releases its reservation without fabricating a file', async () => {
  const f = fixture();
  f.adapter.printHtml = async () => {
    throw new PdfExportError('PRINT_UNAVAILABLE', 'Open updated app');
  };
  await assert.rejects(f.controller.prepare(snapshot()), errorCode('PRINT_UNAVAILABLE'));
  assert.equal(f.state().entries.length, 0);
});

test('retained move-then-throw adopts only the verified target; failed or altered targets remain failures', async () => {
  const f = fixture(),
    move = f.adapter.retainOwnedPdf;
  f.adapter.retainOwnedPdf = async (...args) => {
    await move.apply(f.adapter, args);
    throw Error('after move');
  };
  const { artifact } = await f.controller.prepare(snapshot());
  assert.equal(f.files.has(artifact.uri), true);
  assert.equal(f.state().entries[0].phase, 'ready');
  for (const mode of ['none', 'changed']) {
    const bad = fixture();
    bad.adapter.retainOwnedPdf = async (uri, name) => {
      if (mode === 'changed')
        bad.files.set(bad.adapter.uriFor(name), { byteSize: 999, pdfHeaderValid: true });
      throw Error();
    };
    await assert.rejects(bad.controller.prepare(snapshot()), errorCode('RETAIN_FAILED'));
    assert.equal(bad.state().entries[0].phase, 'copying');
  }
});

test('failed final registration preserves copying intent; recovery adopts it without reprinting', async () => {
  const f = fixture();
  let writes = 0;
  f.storage.setItem = async (key, value) => {
    if (++writes === 3) throw Error('final write failed');
    f.raw.set(key, value);
  };
  await assert.rejects(f.controller.prepare(snapshot()), errorCode('CACHE_SAVE'));
  assert.equal(f.state().entries[0].phase, 'copying');
  await f.controller.prune();
  assert.equal(f.state().entries[0].phase, 'ready');
  assert.equal(f.count('print'), 1);
});

test('pre-existing targets and forged artifact paths are not adopted, shared or deleted', async () => {
  const f = fixture(),
    uri = f.adapter.uriFor('report-fixture-1.pdf');
  f.files.set(uri, { byteSize: 128, pdfHeaderValid: true });
  await assert.rejects(f.controller.prepare(snapshot()), errorCode('TARGET_EXISTS'));
  assert.equal(f.count('print'), 0);
  await f.controller.prune();
  assert.equal(f.files.has(uri), true);
  assert.equal(f.count('delete'), 0);
  const good = fixture(),
    { artifact } = await good.controller.prepare(snapshot());
  await assert.rejects(
    good.controller.share({ ...artifact, uri: 'file:///private/arbitrary.pdf' }),
    errorCode('ARTIFACT_UNAVAILABLE'),
  );
  assert.equal(good.count('share'), 0);
});

test('duplicate submission is refused and close during native print retains metadata but suppresses the result', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred(),
    native = f.adapter.printHtml;
  f.adapter.printHtml = async (html) => {
    entered.resolve();
    await gate.promise;
    return native.call(f.adapter, html);
  };
  const preparing = f.controller.prepare(snapshot());
  await entered.promise;
  await assert.rejects(f.controller.prepare(snapshot()), errorCode('BUSY'));
  f.controller.close();
  gate.resolve();
  await assert.rejects(preparing, errorCode('STALE'));
  assert.equal(f.state().entries[0].phase, 'ready');
  assert.equal(f.count('share'), 0);
});

test('owner changes during print cannot expose the old artifact; a new incarnation cannot share it', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  const other = createPdfController({
    ...f.options,
    owner: { ...f.owner, incarnationId: 'wallet-b' },
  });
  await assert.rejects(other.share(artifact), errorCode('ARTIFACT_UNAVAILABLE'));
  assert.equal(f.count('share'), 0);
  f.setActive(false);
  await assert.rejects(f.controller.prepare(snapshot()), errorCode('STALE'));
  const changed = fixture(),
    print = changed.adapter.printHtml;
  changed.adapter.printHtml = async (html) => {
    const result = await print.call(changed.adapter, html);
    changed.setActive(false);
    return result;
  };
  await assert.rejects(changed.controller.prepare(snapshot()), errorCode('STALE'));
  assert.equal(changed.state().entries[0].phase, 'ready');
  assert.equal(changed.count('share'), 0);
});

test('same-family replacement binding drains old native work before reading and writing its journal', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred(),
    native = f.adapter.printHtml;
  let first = true;
  f.adapter.printHtml = async (html) => {
    if (first) {
      first = false;
      entered.resolve();
      await gate.promise;
    }
    return native.call(f.adapter, html);
  };
  const old = f.controller.prepare(snapshot());
  await entered.promise;
  f.controller.close();
  const next = createPdfController(f.options),
    newJob = next.prepare(snapshot());
  gate.resolve();
  await assert.rejects(old, errorCode('STALE'));
  await newJob;
  assert.equal(f.state().entries.length, 2);
  assert.equal(f.count('print'), 2);
});

test('missing cache files offer regeneration rather than automatic printing or sharing', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  f.files.delete(artifact.uri);
  await assert.rejects(f.controller.share(artifact), errorCode('ARTIFACT_UNAVAILABLE'));
  assert.equal(f.count('print'), 1);
  assert.equal(f.count('share'), 0);
  assert.equal(f.state().entries.length, 0);
});

test('unavailable sharing retains the PDF and a void native completion means requested, never sent', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  f.adapter.sharingAvailable = async () => false;
  assert.deepEqual(await f.controller.share(artifact), { status: 'unavailable' });
  assert.equal(f.count('share'), 0);
  assert.ok(f.files.has(artifact.uri));
  f.adapter.sharingAvailable = async () => true;
  assert.deepEqual(await f.controller.share(artifact), { status: 'requested' });
  assert.equal(f.count('print'), 1);
  assert.deepEqual(await f.controller.preview(artifact), { status: 'requested' });
  assert.equal(f.count('preview'), 1);
});

test('share-then-throw preserves the file for seven days after that request, even after close', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  f.setNow(f.now() + 8 * 24 * 60 * 60 * 1000);
  const shareTime = f.now();
  f.adapter.sharePdf = async (uri) => {
    f.calls.push(['share', uri]);
    assert.equal(f.state().entries[0].retainUntilMs, shareTime + PDF_RETENTION_MS);
    throw Error('after share sheet opened');
  };
  await assert.rejects(f.controller.share(artifact), errorCode('ACTION_UNCERTAIN'));
  f.controller.close();
  const next = createPdfController(f.options);
  f.setNow(shareTime + PDF_RETENTION_MS);
  assert.equal((await next.prune()).deleted, 0);
  f.setNow(f.now() + 1);
  assert.equal((await next.prune()).deleted, 1);
});

test('retention write failure prevents a share effect; owner change while checking availability also blocks it', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  f.setNow(f.now() + 1000);
  f.storage.setItem = async () => {
    throw Error();
  };
  await assert.rejects(f.controller.share(artifact), errorCode('CACHE_SAVE'));
  assert.equal(f.count('share'), 0);
  const other = fixture(),
    ready = await other.controller.prepare(snapshot());
  other.adapter.sharingAvailable = async () => {
    other.setActive(false);
    return true;
  };
  await assert.rejects(other.controller.share(ready.artifact), errorCode('STALE'));
  assert.equal(other.count('share'), 0);
});

test('share captures its artifact before awaiting; later caller mutations cannot redirect the native URI', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot()),
    gate = deferred(),
    entered = deferred();
  f.adapter.sharingAvailable = async () => {
    entered.resolve();
    await gate.promise;
    return true;
  };
  const mutable = { ...artifact },
    sharing = f.controller.share(mutable);
  await entered.promise;
  mutable.uri = 'file:///other.pdf';
  gate.resolve();
  assert.deepEqual(await sharing, { status: 'requested' });
  assert.equal(f.calls.find((c) => c[0] === 'share')[1], artifact.uri);
});

test('cleanup deletes only expired registered files and resolves delete-then-throw without recreating them', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  const unknown = f.adapter.uriFor('report-unregistered.pdf');
  f.files.set(unknown, { byteSize: 10, pdfHeaderValid: true });
  f.setNow(f.now() + PDF_RETENTION_MS + 1);
  const remove = f.adapter.removeOwned;
  f.adapter.removeOwned = async (name) => {
    await remove.call(f.adapter, name);
    throw Error('after delete');
  };
  const result = await f.controller.prune();
  assert.equal(result.deleted, 1);
  assert.equal(f.files.has(artifact.uri), false);
  assert.equal(f.files.has(unknown), true);
  assert.equal(f.state().entries.length, 0);
});

test('an explicit queued share pins an old file against concurrent-binding cleanup', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  f.setNow(f.now() + PDF_RETENTION_MS + 1);
  const gate = deferred(),
    entered = deferred(),
    inspect = f.adapter.inspectPdf;
  let once = true;
  f.adapter.inspectPdf = async (uri) => {
    if (once) {
      once = false;
      entered.resolve();
      await gate.promise;
    }
    return inspect.call(f.adapter, uri);
  };
  const cleanup = f.controller.prune();
  await entered.promise;
  const other = createPdfController(f.options),
    sharing = other.share(artifact);
  gate.resolve();
  assert.equal((await cleanup).deleted, 0);
  assert.deepEqual(await sharing, { status: 'requested' });
  assert.equal(f.count('delete'), 0);
});

test('count and byte caps do not evict recent PDFs to make a new export', async () => {
  for (const usage of [
    { count: MAX_PDF_FILES, byteSize: 1 },
    { count: 1, byteSize: MAX_PDF_CACHE_BYTES - MAX_PDF_BYTES + 1 },
  ]) {
    const f = fixture();
    f.adapter.cacheUsage = async () => usage;
    await assert.rejects(f.controller.prepare(snapshot()), errorCode('CACHE_FULL'));
    assert.equal(f.count('print'), 0);
    assert.equal(f.count('delete'), 0);
  }
});

test('oversized HTML fails before reservation and native rendering', async () => {
  const f = fixture(),
    c = createPdfController({ ...f.options, buildHtml: () => 'x'.repeat(20 * 1024 * 1024 + 1) });
  await assert.rejects(c.prepare(snapshot()), errorCode('HTML_TOO_LARGE'));
  assert.equal(f.count('print'), 0);
  assert.equal(f.raw.size, 0);
});

test('delete failure before effect keeps the registered file and reports pending cleanup', async () => {
  const f = fixture(),
    { artifact } = await f.controller.prepare(snapshot());
  f.setNow(f.now() + PDF_RETENTION_MS + 1);
  const before = f.raw.get(f.controller.journalKey),
    remove = f.adapter.removeOwned;
  f.adapter.removeOwned = async () => {
    throw Error('before effect');
  };
  assert.deepEqual(await f.controller.prune(), { deleted: 0, retained: 1, pending: true });
  assert.equal(f.raw.get(f.controller.journalKey), before);
  assert.equal(f.files.has(artifact.uri), true);
  f.adapter.removeOwned = remove;
  assert.equal((await f.controller.prune()).deleted, 1);
});

test('corrupt, foreign and future journal envelopes are retained and cannot trigger effects', async () => {
  for (const bytes of [
    '{bad',
    JSON.stringify({ version: 2, familyToken: 'bad', entries: [] }),
    JSON.stringify({ version: 1, familyToken: 'wrong', entries: [] }),
  ]) {
    const f = fixture();
    f.raw.set(f.controller.journalKey, bytes);
    await assert.rejects(f.controller.prepare(snapshot()));
    assert.equal(f.raw.get(f.controller.journalKey), bytes);
    assert.equal(f.count('print'), 0);
    assert.equal(f.count('delete'), 0);
  }
});

test('photo read completion after close cannot start Print, and missing images carry an explicit warning', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred();
  const c = createPdfController({
    ...f.options,
    prepareImage: async () => {
      entered.resolve();
      await gate.promise;
      return { image: { status: 'unavailable', reason: 'missing' }, warning: 'Photo omitted' };
    },
  });
  const source = { ...snapshot(), kind: 'transaction', attachment: { id: 'synthetic' } };
  const job = c.prepare(source);
  await entered.promise;
  c.close();
  gate.resolve();
  await assert.rejects(job, errorCode('STALE'));
  assert.equal(f.count('print'), 0);
  const next = createPdfController({
    ...f.options,
    prepareImage: async () => ({
      image: { status: 'unavailable', reason: 'missing' },
      warning: 'Photo omitted',
    }),
  });
  const ready = await next.prepare(source);
  assert.equal(ready.warning, 'Photo omitted');
  assert.equal(ready.artifact.kind, 'transaction');
});

test('header/path checks reject arbitrary URIs and encoded traversal; actual synthetic PNG bytes round-trip through inline base64', () => {
  assert.equal(isPdfHeader(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(isPdfHeader(Buffer.from('not pdf!')), false);
  assert.equal(isPdfHeader(Buffer.from('%PDF-xxx')), false);
  assert.equal(isPdfHeader(Buffer.from('%PDF-1.7')), false);
  const root = 'file:///cache/',
    owned = 'file:///cache/pdf-exports/';
  assert.equal(
    validateCacheUri('file:///cache/Print/id.pdf', root, owned),
    'file:///cache/Print/id.pdf',
  );
  for (const uri of [
    'https://example.com/a.pdf',
    'content://a/b',
    'file:///cache-other/a.pdf',
    'file:///cache/../private.pdf',
    'file:///cache/%2e%2e/private.pdf',
    'file:///cache/%252e%252e/private.pdf',
    'file:///cache/a%2fb.pdf',
    'file:///cache/a.pdf?x=1',
    'file:///cache/pdf-exports/report-id.pdf',
  ])
    assert.throws(() => validateCacheUri(uri, root, owned));
  for (const name of [
    '../x.pdf',
    'report-id.pdf/extra',
    'report-id.PDF',
    'report-id%2f.pdf',
    'user title.pdf',
  ])
    assert.throws(() => validatePdfFileName(name));
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/images/receipt-a.png')),
    info = inspectImageHeader(bytes),
    uri = photoDataUrl(bytes, info);
  assert.equal(uri, 'data:image/png;base64,' + bytes.toString('base64'));
  assert.throws(() => photoDataUrl(bytes, { ...info, byteSize: info.byteSize + 1 }));
});

test('bounded PDF envelope rejects header-only, truncated EOF, invalid versions and out-of-file xref pointers', () => {
  let source = '%PDF-1.7\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] >>\nendobj\n',
  ];
  const offsets = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(source));
    source += object;
  }
  const xrefOffset = Buffer.byteLength(source);
  source +=
    'xref\n0 4\n0000000000 65535 f \n' +
    offsets.map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n' +
    xrefOffset +
    '\n%%EOF\n';
  const bytes = Buffer.from(source);
  const inspect = (value) =>
    readPdfEnvelope(
      value.subarray(0, 16),
      value.subarray(Math.max(0, value.length - PDF_TAIL_SCAN_BYTES)),
      value.length,
    );
  assert.deepEqual(inspect(bytes), { xrefOffset });
  assert.equal(isPdfXrefStart(bytes.subarray(xrefOffset)), true);
  const eofEnd = bytes.lastIndexOf(Buffer.from('%%EOF')) + 5;
  for (let length = 0; length < eofEnd; length++)
    assert.equal(inspect(bytes.subarray(0, length)), null);
  for (const replacement of ['0', String(bytes.length + 100), '9999999999'])
    assert.equal(
      inspect(Buffer.from(source.replace('startxref\n' + xrefOffset, 'startxref\n' + replacement))),
      null,
    );
  assert.equal(inspect(Buffer.from(source.replace('%PDF-1.7', '%PDF-xxx'))), null);
  assert.equal(inspect(Buffer.from(source + 'unexpected trailing content')), null);
  assert.equal(isPdfXrefStart(Buffer.from('not an xref table')), false);
});

test('bounded xref check permits the standard cross-reference stream prefix without claiming to parse its stream', () => {
  assert.equal(isPdfHeader(Buffer.from('%PDF-2.0\n')), true);
  assert.equal(isPdfHeader(Buffer.from('%PDF-2.1\n')), false);
  assert.equal(
    isPdfXrefStart(Buffer.from('7 0 obj\n<< /Type /XRef /Size 8 /W [1 2 1] >>\nstream\n')),
    true,
  );
  assert.equal(isPdfXrefStart(Buffer.from('7 0 obj\n<< /Type /Page >>\n')), false);
});

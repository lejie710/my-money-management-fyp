const { encodeReminderOwner, decodeReminderOwner } = require('../reminders/store');
const { MAX_EXPORT_HTML_BYTES, utf8ByteLength } = require('../core/exports');
const MIN_PDF_BYTES = 64;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PDF_CACHE_BYTES = 100 * 1024 * 1024;
const MAX_PDF_FILES = 20;
const MAX_PDF_PAGES = 500;
const PDF_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// The native export directory and Print/share surfaces are shared across owners.
let queue = Promise.resolve();
const knownJournals = new Set();
const pins = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
class PdfExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfExportError';
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new PdfExportError(code, message);
};
const exactKeys = (value, keys) =>
  object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validInstant = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - PDF_RETENTION_MS;
const validSize = (value) =>
  Number.isSafeInteger(value) && value >= MIN_PDF_BYTES && value <= MAX_PDF_BYTES;
const validPages = (value) => Number.isInteger(value) && value > 0 && value <= MAX_PDF_PAGES;
const familyOf = (owner) =>
  encodeReminderOwner({
    ...decodeReminderOwner(encodeReminderOwner(owner)),
    incarnationId: 'pdf-family',
  });
const pdfJournalKey = (owner) => '@mymoney/pdf/v1/' + familyOf(owner);
function exclusive(work) {
  const task = queue.then(work, work);
  queue = task.catch(() => {});
  return task;
}
function pin(id) {
  pins.set(id, (pins.get(id) || 0) + 1);
  return () => {
    const left = (pins.get(id) || 1) - 1;
    if (left) pins.set(id, left);
    else pins.delete(id);
  };
}
function validateEnvelope(value, family) {
  if (
    !exactKeys(value, ['version', 'familyToken', 'entries']) ||
    value.version !== 1 ||
    value.familyToken !== family ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_PDF_FILES
  )
    fail('CACHE_INVALID', 'PDF ownership records could not be read. Existing files were kept.');
  const ids = new Set();
  for (const entry of value.entries) {
    if (
      !exactKeys(entry, [
        'id',
        'ownerToken',
        'kind',
        'fileName',
        'createdAtMs',
        'retainUntilMs',
        'phase',
        'byteSize',
        'pageCount',
      ]) ||
      !['report', 'transaction'].includes(entry.kind) ||
      typeof entry.id !== 'string' ||
      !new RegExp('^' + entry.kind + '-[a-z0-9][a-z0-9-]{0,70}$').test(entry.id) ||
      entry.fileName !== entry.id + '.pdf' ||
      ids.has(entry.id) ||
      !validInstant(entry.createdAtMs) ||
      !Number.isSafeInteger(entry.retainUntilMs) ||
      entry.retainUntilMs < entry.createdAtMs + PDF_RETENTION_MS ||
      !['reserved', 'copying', 'ready'].includes(entry.phase)
    )
      fail('CACHE_INVALID', 'PDF ownership records are invalid. Existing files were kept.');
    try {
      if (familyOf(decodeReminderOwner(entry.ownerToken)) !== family) throw Error();
    } catch {
      fail('CACHE_INVALID', 'PDF ownership records belong to another storage scope.');
    }
    if (
      entry.phase === 'reserved'
        ? entry.byteSize !== null || entry.pageCount !== null
        : !validSize(entry.byteSize) || !validPages(entry.pageCount)
    )
      fail('CACHE_INVALID', 'PDF ownership records contain invalid file details.');
    ids.add(entry.id);
  }
  return value;
}

function createPdfController(options) {
  const ownerToken = encodeReminderOwner(options.owner),
    family = familyOf(options.owner),
    journalKey = pdfJournalKey(options.owner);
  const { adapter, storage } = options;
  let closed = false,
    generation = 0,
    busy = false;
  function now() {
    const value = options.now();
    if (!validInstant(value))
      fail('CLOCK_INVALID', 'The device date could not be used for this export.');
    return value;
  }
  function current(job) {
    let active = false;
    try {
      active = options.isCurrent() === true;
    } catch {}
    if (closed || job !== generation || !active)
      fail('STALE', 'This export panel is no longer active. Open it again to continue.');
  }
  async function load() {
    let raw;
    try {
      raw = await storage.getItem(journalKey);
    } catch {
      fail(
        'CACHE_UNAVAILABLE',
        'PDF ownership records are unavailable. Try again; existing files were kept.',
      );
    }
    if (raw === null) {
      if (knownJournals.has(journalKey))
        fail('CACHE_UNCERTAIN', 'PDF ownership records disappeared. Existing files were kept.');
      return { version: 1, familyToken: family, entries: [] };
    }
    try {
      const state = validateEnvelope(JSON.parse(raw), family);
      knownJournals.add(journalKey);
      return state;
    } catch (error) {
      if (error instanceof PdfExportError) throw error;
      fail('CACHE_INVALID', 'PDF ownership records could not be read. Existing files were kept.');
    }
  }
  async function persist(state) {
    validateEnvelope(state, family);
    const bytes = JSON.stringify(state);
    try {
      await storage.setItem(journalKey, bytes);
      knownJournals.add(journalKey);
    } catch {
      let actual;
      try {
        actual = await storage.getItem(journalKey);
      } catch {
        fail(
          'CACHE_UNCERTAIN',
          'The PDF registration outcome could not be confirmed. Existing files were kept.',
        );
      }
      if (actual === bytes) {
        knownJournals.add(journalKey);
        return;
      }
      if (actual === null && knownJournals.has(journalKey))
        fail(
          'CACHE_UNCERTAIN',
          'PDF ownership records disappeared during saving. Existing files were kept.',
        );
      if (actual !== null) {
        try {
          validateEnvelope(JSON.parse(actual), family);
          knownJournals.add(journalKey);
        } catch {
          fail('CACHE_UNCERTAIN', 'PDF ownership records need recovery. Existing files were kept.');
        }
      }
      fail(
        'CACHE_SAVE',
        'The PDF could not be registered safely. Try again; existing files were kept.',
      );
    }
  }
  const uriFor = (entry) => adapter.uriFor(entry.fileName);
  function usable(inspection, expected) {
    return (
      inspection !== null &&
      inspection.pdfHeaderValid === true &&
      validSize(inspection.byteSize) &&
      (!expected || inspection.byteSize === expected.byteSize)
    );
  }
  const artifactFor = (entry) =>
    freeze({
      id: entry.id,
      ownerToken: entry.ownerToken,
      kind: entry.kind,
      fileName: entry.fileName,
      uri: uriFor(entry),
      byteSize: entry.byteSize,
      pageCount: entry.pageCount,
      createdAtMs: entry.createdAtMs,
    });
  async function inspectOwned(entry) {
    try {
      return await adapter.inspectPdf(uriFor(entry));
    } catch {
      fail('FILE_UNAVAILABLE', 'The saved PDF could not be checked. Existing files were kept.');
    }
  }
  async function recover(state) {
    const kept = [];
    let changed = false;
    for (const entry of state.entries) {
      const inspected = await inspectOwned(entry);
      if (!inspected && entry.phase === 'ready') {
        changed = true;
        continue;
      }
      if (entry.phase === 'copying' && usable(inspected, entry)) {
        kept.push({ ...entry, phase: 'ready' });
        changed = true;
      } else kept.push(entry);
    }
    if (changed) {
      state = { ...state, entries: kept };
      await persist(state);
    }
    return state;
  }
  async function pruneState(state, job) {
    let deleted = 0,
      pending = false;
    const stamp = now();
    for (const entry of [...state.entries]) {
      if (entry.retainUntilMs >= stamp || pins.has(entry.id)) continue;
      current(job);
      let inspected;
      try {
        inspected = await inspectOwned(entry);
      } catch {
        pending = true;
        continue;
      }
      // A reservation alone never establishes ownership of an unexpectedly existing file.
      if (inspected && (entry.phase === 'reserved' || !usable(inspected, entry))) {
        pending = true;
        continue;
      }
      if (pins.has(entry.id)) continue;
      if (inspected) {
        current(job);
        try {
          await adapter.removeOwned(entry.fileName);
        } catch {
          /* Resolve delete-then-throw by inspecting the exact registered file. */
        }
        try {
          if (await inspectOwned(entry)) {
            pending = true;
            continue;
          }
        } catch {
          pending = true;
          continue;
        }
        deleted++;
      }
      state = { ...state, entries: state.entries.filter((item) => item.id !== entry.id) };
      await persist(state);
    }
    return { state, result: { deleted, retained: state.entries.length, pending } };
  }
  function submit(work, artifact) {
    if (busy)
      return Promise.reject(new PdfExportError('BUSY', 'An export action is already in progress.'));
    const job = generation;
    try {
      current(job);
    } catch (error) {
      return Promise.reject(error);
    }
    busy = true;
    const unpin = artifact && typeof artifact.id === 'string' ? pin(artifact.id) : () => {};
    return exclusive(() => work(job)).finally(() => {
      unpin();
      busy = false;
    });
  }
  async function checkSpace(state) {
    let usage;
    try {
      usage = await adapter.cacheUsage();
    } catch {
      fail('CACHE_UNAVAILABLE', 'PDF cache space could not be checked. Try again.');
    }
    if (
      !usage ||
      !Number.isSafeInteger(usage.count) ||
      usage.count < 0 ||
      !Number.isSafeInteger(usage.byteSize) ||
      usage.byteSize < 0
    )
      fail('CACHE_UNAVAILABLE', 'PDF cache space could not be checked. Try again.');
    const readyBytes = state.entries
      .filter((e) => e.phase === 'ready')
      .reduce((sum, e) => sum + e.byteSize, 0);
    const reserved = state.entries.filter((e) => e.phase !== 'ready').length * MAX_PDF_BYTES;
    if (
      Math.max(usage.count, state.entries.length) >= MAX_PDF_FILES ||
      Math.max(usage.byteSize, readyBytes) + reserved + MAX_PDF_BYTES > MAX_PDF_CACHE_BYTES
    )
      fail(
        'CACHE_FULL',
        'The PDF cache has reached its file or space limit. Existing files were kept.',
      );
  }
  async function prepareWork(snapshot, job) {
    current(job);
    let state = await recover(await load());
    const cleanup = await pruneState(state, job);
    state = cleanup.state;
    current(job);
    let image,
      warning = cleanup.result.pending ? 'Some old PDFs could not be cleared yet.' : undefined;
    if (snapshot.kind === 'transaction' && snapshot.attachment) {
      if (!options.prepareImage)
        fail(
          'IMAGE_UNAVAILABLE',
          'Photo preparation is unavailable. Deselect the photo or try again.',
        );
      const prepared = await options.prepareImage(snapshot);
      image = prepared.image;
      if (prepared.warning) warning = [warning, prepared.warning].filter(Boolean).join(' ');
    }
    current(job);
    const html = options.buildHtml(snapshot, image);
    if (typeof html !== 'string' || !html.trim())
      fail('INVALID_HTML', 'The PDF content could not be prepared.');
    if (utf8ByteLength(html) > MAX_EXPORT_HTML_BYTES)
      fail(
        'HTML_TOO_LARGE',
        'The PDF content is too large. Choose a smaller report or fewer optional details.',
      );
    await checkSpace(state);
    current(job);
    const token = options.newId();
    if (typeof token !== 'string' || !/^[a-z0-9][a-z0-9-]{0,70}$/.test(token))
      fail('ID_INVALID', 'A safe PDF filename could not be created.');
    const id = snapshot.kind + '-' + token,
      fileName = id + '.pdf',
      stamp = now();
    if (
      state.entries.some((e) => e.id === id) ||
      (await adapter.inspectPdf(adapter.uriFor(fileName)))
    )
      fail('TARGET_EXISTS', 'This PDF filename is already in use. Try again.');
    let entry = {
      id,
      fileName,
      ownerToken,
      kind: snapshot.kind,
      createdAtMs: stamp,
      retainUntilMs: stamp + PDF_RETENTION_MS,
      phase: 'reserved',
      byteSize: null,
      pageCount: null,
    };
    state = { ...state, entries: [...state.entries, entry] };
    await persist(state);
    let printed;
    try {
      current(job);
      printed = await adapter.printHtml(html);
    } catch (error) {
      if (error?.code === 'STALE' || error?.code === 'PRINT_UNAVAILABLE') {
        state = { ...state, entries: state.entries.filter((e) => e.id !== id) };
        await persist(state);
        throw error;
      }
      fail(
        'PRINT_FAILED',
        'PDF creation did not finish. Its outcome is uncertain; no file was shared.',
      );
    }
    if (!printed || !validPages(printed.numberOfPages))
      fail('INVALID_PDF', 'The generated PDF did not report a valid page count.');
    let inspected;
    try {
      inspected = await adapter.inspectPdf(printed.uri);
    } catch {
      fail('INVALID_PDF', 'The generated PDF could not be checked.');
    }
    if (!usable(inspected))
      fail('INVALID_PDF', 'The generated PDF is missing, invalid or exceeds 25 MiB.');
    entry = {
      ...entry,
      phase: 'copying',
      byteSize: inspected.byteSize,
      pageCount: printed.numberOfPages,
    };
    state = { ...state, entries: state.entries.map((e) => (e.id === id ? entry : e)) };
    await persist(state);
    try {
      await adapter.retainOwnedPdf(printed.uri, fileName);
    } catch (error) {
      if (error?.code === 'TARGET_EXISTS') {
        state = { ...state, entries: state.entries.filter((e) => e.id !== id) };
        await persist(state);
        throw error;
      }
      // A move/copy may have completed before rejecting. Only adopt the exact registered target.
      if (!usable(await inspectOwned(entry), entry))
        fail('RETAIN_FAILED', 'The PDF could not be retained safely. Existing files were kept.');
    }
    if (!usable(await inspectOwned(entry), entry))
      fail('RETAIN_FAILED', 'The retained PDF could not be verified. Try creating it again.');
    entry = { ...entry, phase: 'ready' };
    state = { ...state, entries: state.entries.map((e) => (e.id === id ? entry : e)) };
    await persist(state);
    current(job);
    return { artifact: artifactFor(entry), ...(warning ? { warning } : {}) };
  }
  async function actionWork(artifact, action, job) {
    current(job);
    let state = await recover(await load());
    const entry = state.entries.find(
      (e) => e.id === artifact?.id && e.ownerToken === ownerToken && e.phase === 'ready',
    );
    if (
      !entry ||
      !exactKeys(artifact, [
        'id',
        'ownerToken',
        'kind',
        'fileName',
        'uri',
        'byteSize',
        'pageCount',
        'createdAtMs',
      ]) ||
      Object.entries(artifactFor(entry)).some(([key, value]) => artifact[key] !== value)
    )
      fail(
        'ARTIFACT_UNAVAILABLE',
        'This PDF is no longer available in the current wallet. Create it again.',
      );
    if (!usable(await inspectOwned(entry), entry))
      fail('ARTIFACT_UNAVAILABLE', 'The cached PDF is missing or changed. Create it again.');
    current(job);
    if (action === 'share') {
      let available;
      try {
        available = await adapter.sharingAvailable();
      } catch {
        fail(
          'SHARE_UNAVAILABLE',
          'Sharing availability could not be checked. Your PDF is still ready.',
        );
      }
      current(job);
      if (!available) return { status: 'unavailable' };
    } else if (!adapter.previewPdf) return { status: 'unavailable' };
    const retained = {
      ...entry,
      retainUntilMs: Math.max(entry.retainUntilMs, now() + PDF_RETENTION_MS),
    };
    state = { ...state, entries: state.entries.map((e) => (e.id === entry.id ? retained : e)) };
    await persist(state);
    current(job);
    try {
      if (action === 'share') await adapter.sharePdf(uriFor(entry));
      else await adapter.previewPdf(uriFor(entry));
    } catch (error) {
      if (error?.code === 'PRINT_UNAVAILABLE') {
        current(job);
        return { status: 'unavailable' };
      }
      fail(
        'ACTION_UNCERTAIN',
        'The sharing or print outcome could not be confirmed. Your PDF was kept for a deliberate retry.',
      );
    }
    current(job);
    return { status: 'requested' };
  }
  function capturedAction(artifact, action) {
    let captured;
    try {
      captured = freeze(clone(artifact));
    } catch {
      return Promise.reject(
        new PdfExportError(
          'ARTIFACT_UNAVAILABLE',
          'This PDF reference could not be read. Create it again.',
        ),
      );
    }
    return submit((job) => actionWork(captured, action, job), captured);
  }
  return {
    ownerToken,
    journalKey,
    prepare(snapshot) {
      let captured;
      try {
        captured = freeze(clone(snapshot));
        if (!captured || !['report', 'transaction'].includes(captured.kind))
          fail('SNAPSHOT_INVALID', 'Choose a supported PDF export.');
      } catch (error) {
        return Promise.reject(
          error instanceof PdfExportError
            ? error
            : new PdfExportError('SNAPSHOT_INVALID', 'The export snapshot could not be read.'),
        );
      }
      return submit((job) => prepareWork(captured, job));
    },
    share: (artifact) => capturedAction(artifact, 'share'),
    preview: (artifact) => capturedAction(artifact, 'preview'),
    prune: () =>
      submit(async (job) => {
        current(job);
        const state = await recover(await load());
        const result = (await pruneState(state, job)).result;
        current(job);
        return result;
      }),
    close() {
      closed = true;
      generation += 1;
    },
  };
}
module.exports = {
  createPdfController,
  pdfJournalKey,
  PdfExportError,
  MAX_PDF_BYTES,
  MIN_PDF_BYTES,
  MAX_PDF_CACHE_BYTES,
  MAX_PDF_FILES,
  MAX_PDF_PAGES,
  PDF_RETENTION_MS,
};

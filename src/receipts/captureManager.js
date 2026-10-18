const {
  encodeReminderOwner,
  decodeReminderOwner,
} = require("../reminders/store");
const {
  inspectImageHeader,
  MAX_PHOTO_BYTES,
} = require("../attachments/imageHeader");
const {
  validatePhotoInspection,
} = require("../core/transactionContext");

const MAX_RECEIPT_CAPTURES = 8;
let queue = Promise.resolve();
const knownJournals = new Set(),
  activeSessions = new Map(),
  pinned = new Set();
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) =>
  object(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const safeId = (v) =>
  typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,70}$/.test(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
class ReceiptCaptureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReceiptCaptureError";
    this.code = code;
  }
}
function fail(code, message) {
  throw new ReceiptCaptureError(code, message);
}
const safeFailure = (error) =>
  error instanceof ReceiptCaptureError
    ? error
    : new ReceiptCaptureError(
        "CAPTURE_UNAVAILABLE",
        "The receipt image operation could not be confirmed. Retry cleanup or choose the image again.",
      );
function exclusive(work) {
  const result = queue.then(work, work);
  queue = result.catch(() => {});
  return result;
}
function receiptCaptureFamilyToken(owner) {
  return encodeReminderOwner({
    ...decodeReminderOwner(encodeReminderOwner(owner)),
    incarnationId: "receipt-family",
  });
}
const receiptCaptureJournalKey = (owner) =>
  "@mymoney/receipt-captures/v1/" + receiptCaptureFamilyToken(owner);
const pinKey = (family, id) => JSON.stringify([family, id]);
const sessionToken = (owner, session) => JSON.stringify([owner, session]);
function validateJournal(value, family) {
  if (
    !exact(value, ["version", "familyToken", "entries"]) ||
    value.version !== 1 ||
    value.familyToken !== family ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_RECEIPT_CAPTURES
  )
    fail(
      "JOURNAL_INVALID",
      "Temporary receipt ownership records are unavailable. Existing files were retained.",
    );
  const ids = new Set();
  for (const entry of value.entries) {
    if (
      !exact(entry, [
        "id",
        "fileName",
        "ownerToken",
        "sessionKey",
        "phase",
        "inspection",
      ]) ||
      !safeId(entry.id) ||
      entry.fileName !== `receipt-${entry.id}.image` ||
      ids.has(entry.id) ||
      !["copying", "ready", "delete"].includes(entry.phase) ||
      typeof entry.sessionKey !== "string" ||
      !entry.sessionKey ||
      entry.sessionKey.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(entry.sessionKey)
    )
      fail(
        "JOURNAL_INVALID",
        "Temporary receipt ownership records are invalid. Existing files were retained.",
      );
    try {
      if (
        receiptCaptureFamilyToken(decodeReminderOwner(entry.ownerToken)) !==
        family
      )
        throw Error();
      validatePhotoInspection(entry.inspection);
      if (!exact(entry.inspection, ["mimeType", "width", "height", "byteSize"]))
        throw Error();
    } catch {
      fail(
        "JOURNAL_INVALID",
        "Temporary receipt records belong to an invalid owner or image.",
      );
    }
    ids.add(entry.id);
  }
  return value;
}
const sameInspection = (a, b) =>
  ["mimeType", "width", "height", "byteSize"].every((key) => a[key] === b[key]);
function checkedBytes(bytes, expected) {
  const actual = inspectImageHeader(bytes);
  if (expected && !sameInspection(actual, expected))
    fail(
      "IMAGE_CHANGED",
      "The temporary receipt image changed. Choose it again.",
    );
  return actual;
}
function createReceiptCaptureManager(options) {
  const ownerToken = encodeReminderOwner(options.owner),
    familyToken = receiptCaptureFamilyToken(options.owner);
  const journalKey = receiptCaptureJournalKey(options.owner),
    { files, storage, picker } = options;
  const sessionKey = options.sessionKey;
  if (
    typeof sessionKey !== "string" ||
    !sessionKey ||
    sessionKey.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(sessionKey)
  )
    fail("SESSION_INVALID", "An explicit receipt capture session is required.");
  const ownerSession = sessionToken(ownerToken, sessionKey),
    handles = new Map();
  const knownOwned = new Set(),
    abandonedIds = new Set(),
    refusedTargets = new Set();
  activeSessions.set(ownerSession, (activeSessions.get(ownerSession) || 0) + 1);
  let closed = false,
    selecting = false,
    closeTask = null;
  function current() {
    let active = false;
    try {
      active = options.isCurrent() === true;
    } catch {}
    if (closed || !active)
      fail(
        "STALE",
        "This receipt session is no longer active. Open receipt capture again.",
      );
  }
  async function load() {
    let raw;
    try {
      raw = await storage.getItem(journalKey);
    } catch {
      fail(
        "JOURNAL_UNAVAILABLE",
        "Temporary receipt ownership could not be read. Retry cleanup before selecting again.",
      );
    }
    if (raw === null) {
      if (knownJournals.has(journalKey))
        fail(
          "JOURNAL_UNCERTAIN",
          "Temporary receipt ownership records disappeared. Existing files were retained.",
        );
      return { version: 1, familyToken, entries: [] };
    }
    try {
      const value = validateJournal(JSON.parse(raw), familyToken);
      knownJournals.add(journalKey);
      return value;
    } catch {
      fail(
        "JOURNAL_INVALID",
        "Temporary receipt ownership records could not be validated. Existing files were retained.",
      );
    }
  }
  async function persist(state) {
    validateJournal(state, familyToken);
    const raw = JSON.stringify(state);
    try {
      await storage.setItem(journalKey, raw);
      knownJournals.add(journalKey);
    } catch {
      let actual;
      try {
        actual = await storage.getItem(journalKey);
      } catch {
        fail(
          "JOURNAL_UNCERTAIN",
          "The temporary receipt registration outcome is unknown. Retry cleanup; existing files were retained.",
        );
      }
      if (actual === raw) {
        knownJournals.add(journalKey);
        return;
      }
      if (actual !== null) {
        try {
          validateJournal(JSON.parse(actual), familyToken);
          knownJournals.add(journalKey);
        } catch {
          fail(
            "JOURNAL_UNCERTAIN",
            "Temporary receipt ownership needs recovery. Existing files were retained.",
          );
        }
      } else if (knownJournals.has(journalKey))
        fail(
          "JOURNAL_UNCERTAIN",
          "Temporary receipt ownership records disappeared while saving. Existing files were retained.",
        );
      fail(
        "JOURNAL_SAVE",
        "The temporary receipt registration could not be saved. Retry cleanup before selecting again.",
      );
    }
  }
  function registered(image, allowReleased = false) {
    if (!exact(image, ["id", "uri"]))
      fail(
        "SELECTION_INVALID",
        "Use the temporary receipt selected by this session.",
      );
    const handle = handles.get(image.id);
    if (
      !handle ||
      handle.selection.uri !== image.uri ||
      (!allowReleased && handle.released)
    )
      fail(
        "SELECTION_INVALID",
        "This receipt image belongs to another or closed selection.",
      );
    return handle;
  }
  function entryFor(state, handle) {
    const entry = state.entries.find((item) => item.id === handle.selection.id);
    if (
      !entry ||
      entry.ownerToken !== ownerToken ||
      entry.sessionKey !== sessionKey ||
      files.uriFor(entry.fileName) !== handle.selection.uri ||
      !sameInspection(entry.inspection, handle.inspection)
    )
      fail(
        "JOURNAL_UNCERTAIN",
        "This temporary receipt no longer has confirmed ownership. Existing files were retained.",
      );
    return entry;
  }
  async function cleanupEntry(state, entry) {
    if (pinned.has(pinKey(familyToken, entry.id)))
      return { state, deleted: false, pending: true };
    if (refusedTargets.has(entry.id))
      return { state, deleted: false, pending: true };
    // A pre-write intent is not proof that an existing target was created by us.
    // After a process interruption, retain such files rather than guessing ownership.
    if (entry.phase === "copying" && !knownOwned.has(entry.id)) {
      try {
        if (await files.statOwned(entry.fileName))
          return { state, deleted: false, pending: true };
      } catch {
        return { state, deleted: false, pending: true };
      }
    }
    if (entry.phase !== "delete") {
      entry = { ...entry, phase: "delete" };
      state = {
        ...state,
        entries: state.entries.map((item) =>
          item.id === entry.id ? entry : item,
        ),
      };
      await persist(state);
    }
    // Only a validated ready snapshot or a confirmed creation in this process
    // reaches deletion. Provider and unregistered paths are never passed here.
    try {
      const before = await files.statOwned(entry.fileName);
      if (before !== null) {
        if (
          !Number.isSafeInteger(before.byteSize) ||
          before.byteSize < 0 ||
          before.byteSize > MAX_PHOTO_BYTES
        )
          return { state, deleted: false, pending: true };
        try {
          await files.removeOwned(entry.fileName);
        } catch {}
        if (await files.statOwned(entry.fileName))
          return { state, deleted: false, pending: true };
      }
    } catch {
      return { state, deleted: false, pending: true };
    }
    const next = {
      ...state,
      entries: state.entries.filter((item) => item.id !== entry.id),
    };
    await persist(next);
    return { state: next, deleted: true, pending: false };
  }
  async function releaseWork(handle) {
    if (handle.complete) return;
    let state = await load();
    const entry = state.entries.find((item) => item.id === handle.selection.id);
    if (!entry) {
      // A prior delete may have committed before its caller observed success.
      if ((await files.statOwned(handle.fileName)) === null) {
        pinned.delete(pinKey(familyToken, handle.selection.id));
        handle.complete = true;
        return;
      }
      fail(
        "CLEANUP_PENDING",
        "Temporary receipt cleanup is unconfirmed. The unregistered file was retained.",
      );
    }
    entryFor(state, handle);
    pinned.delete(pinKey(familyToken, entry.id));
    const outcome = await cleanupEntry(state, entry);
    if (outcome.pending)
      fail(
        "CLEANUP_PENDING",
        "The temporary receipt image needs a cleanup retry.",
      );
    handle.complete = true;
  }
  async function selectWork(kind) {
    current();
    let state = await load();
    if (state.entries.length >= MAX_RECEIPT_CAPTURES)
      fail(
        "CACHE_FULL",
        "Temporary receipt storage is full. Close unused receipt panels and retry cleanup.",
      );
    current();
    const source = await picker.pick(kind);
    current();
    if (source === null) return null;
    const captured = await files.readSource(source.uri);
    current();
    const inspection = checkedBytes(captured.bytes);
    validatePhotoInspection(captured.inspection);
    if (!sameInspection(captured.inspection, inspection))
      fail(
        "IMAGE_INVALID",
        "The selected receipt dimensions could not be confirmed.",
      );
    const id = options.newId();
    if (!safeId(id))
      fail("ID_INVALID", "A safe temporary receipt name could not be created.");
    const fileName = `receipt-${id}.image`;
    if (
      state.entries.some((item) => item.id === id) ||
      (await files.statOwned(fileName))
    )
      fail(
        "TARGET_EXISTS",
        "This temporary receipt name already exists. Choose the image again.",
      );
    let entry = {
      id,
      fileName,
      ownerToken,
      sessionKey,
      phase: "copying",
      inspection: { ...inspection },
    };
    state = { ...state, entries: [...state.entries, entry] };
    try {
      await persist(state);
    } catch (error) {
      abandonedIds.add(id);
      throw error;
    }
    let wrote = false;
    try {
      current();
      try {
        await files.writeOwned(fileName, captured.bytes);
        wrote = true;
        knownOwned.add(id);
      } catch (error) {
        if (error?.code === "TARGET_EXISTS") {
          refusedTargets.add(id);
          // Native refusal before writing never authorizes deletion of that existing file.
          state = {
            ...state,
            entries: state.entries.filter((item) => item.id !== id),
          };
          await persist(state);
          throw error;
        }
        if (
          error instanceof ReceiptCaptureError &&
          error.code === "OWNED_WRITE_FAILED"
        ) {
          knownOwned.add(id);
        } else {
          // Only the native adapter's explicit successful-create proof allows
          // inspection/adoption after a rejected write. Matching bytes alone do
          // not prove ownership of a target whose exclusive creation failed.
          throw error;
        }
      }
      const actual = await files.readOwned(fileName);
      checkedBytes(actual.bytes, inspection);
      if (
        !sameInspection(actual.inspection, inspection) ||
        actual.bytes.length !== captured.bytes.length ||
        actual.bytes.some((byte, index) => byte !== captured.bytes[index])
      )
        fail(
          "IMAGE_CHANGED",
          "The temporary receipt copy could not be confirmed. Choose it again.",
        );
      knownOwned.add(id);
      entry = { ...entry, phase: "ready" };
      state = {
        ...state,
        entries: state.entries.map((item) => (item.id === id ? entry : item)),
      };
      await persist(state);
      current();
      const selection = Object.freeze({ id, uri: files.uriFor(fileName) });
      const handle = {
        selection,
        fileName,
        inspection,
        released: false,
        complete: false,
      };
      handles.set(id, handle);
      pinned.add(pinKey(familyToken, id));
      return selection;
    } catch (error) {
      abandonedIds.add(id);
      if (!refusedTargets.has(id)) {
        // Reload after any ambiguous save rather than replacing unknown journal bytes.
        try {
          const actual = await load(),
            registeredEntry = actual.entries.find((item) => item.id === id);
          if (
            registeredEntry &&
            registeredEntry.ownerToken === ownerToken &&
            registeredEntry.sessionKey === sessionKey
          )
            await cleanupEntry(actual, registeredEntry);
        } catch {}
      }
      if (error?.code) throw error;
      fail(
        "CAPTURE_FAILED",
        wrote
          ? "The temporary receipt could not be validated. Retry cleanup, then choose it again."
          : "The temporary receipt copy could not be confirmed. Retry cleanup, then choose it again.",
      );
    }
  }
  async function retryWork() {
    let deleted = 0,
      pending =
        closed &&
        [...handles.values()].some(
          (handle) => !handle.released && !handle.complete,
        );
    const attempted = new Set();
    for (const handle of handles.values()) {
      if (!handle.released || handle.complete) continue;
      attempted.add(handle.selection.id);
      try {
        await releaseWork(handle);
        deleted++;
      } catch {
        pending = true;
      }
    }
    let state = await load();
    for (const entry of [...state.entries]) {
      const active = activeSessions.has(
        sessionToken(entry.ownerToken, entry.sessionKey),
      );
      if (attempted.has(entry.id)) continue;
      if (
        pinned.has(pinKey(familyToken, entry.id)) ||
        (active && entry.phase !== "delete" && !abandonedIds.has(entry.id))
      )
        continue;
      const outcome = await cleanupEntry(state, entry);
      state = outcome.state;
      deleted += outcome.deleted ? 1 : 0;
      pending ||= outcome.pending;
    }
    return {
      deleted,
      retained: state.entries.length,
      pending,
      message: pending
        ? "Some temporary receipt images still need a cleanup retry."
        : "Temporary receipt cleanup checked.",
    };
  }
  function select(kind) {
    if (selecting)
      return Promise.reject(
        Object.assign(
          new Error("A receipt selection is already in progress."),
          { code: "BUSY" },
        ),
      );
    try {
      current();
    } catch (error) {
      return Promise.reject(error);
    }
    if (kind === "camera" && !picker.cameraAvailable)
      return Promise.reject(
        Object.assign(
          new Error(
            "Camera capture is unavailable. Choose a receipt image instead.",
          ),
          { code: "CAMERA_UNAVAILABLE" },
        ),
      );
    selecting = true;
    return exclusive(() => selectWork(kind))
      .catch((error) => {
        throw safeFailure(error);
      })
      .finally(() => {
        selecting = false;
      });
  }
  return {
    ownerToken,
    sessionKey,
    familyToken,
    journalKey,
    cameraAvailable: picker.cameraAvailable,
    pickPhoto: () => select("library"),
    takePhoto: () => select("camera"),
    readBytes(image, { signal }) {
      let handle;
      try {
        current();
        handle = registered(image);
      } catch (error) {
        return Promise.reject(error);
      }
      const abort = () => {
        if (signal.aborted)
          fail("ABORTED", "Stopped reading this receipt image.");
      };
      return exclusive(async () => {
        current();
        abort();
        // A release request rejects later reads; already queued reads are drained before deletion.
        if (handle.complete)
          fail("SELECTION_INVALID", "This receipt image has been released.");
        const entry = entryFor(await load(), handle);
        if (entry.phase !== "ready")
          fail("SELECTION_INVALID", "This receipt image is no longer ready.");
        const actual = await files.readOwned(entry.fileName);
        abort();
        current();
        checkedBytes(actual.bytes, entry.inspection);
        if (!sameInspection(actual.inspection, entry.inspection))
          fail("IMAGE_CHANGED", "The temporary receipt image changed.");
        return new Uint8Array(actual.bytes);
      }).catch((error) => {
        throw safeFailure(error);
      });
    },
    release(image) {
      let handle;
      try {
        handle = registered(image, true);
      } catch (error) {
        return Promise.reject(error);
      }
      handle.released = true;
      return exclusive(() => releaseWork(handle)).catch((error) => {
        throw safeFailure(error);
      });
    },
    retryCleanup: () =>
      exclusive(retryWork).catch((error) => {
        throw safeFailure(error);
      }),
    close() {
      if (closeTask) return closeTask;
      closed = true;
      // A published URI may still be inside PhotoManager.stage. Only UI release,
      // ordered after closeDraft, can retire that pin; closing this service alone
      // cannot prove that an external reader has drained.
      closeTask = exclusive(async () => {
        const left = (activeSessions.get(ownerSession) || 1) - 1;
        if (left) activeSessions.set(ownerSession, left);
        else activeSessions.delete(ownerSession);
        return retryWork();
      }).catch((error) => {
        throw safeFailure(error);
      });
      return closeTask;
    },
  };
}
module.exports = {
  createReceiptCaptureManager,
  receiptCaptureFamilyToken,
  receiptCaptureJournalKey,
  MAX_RECEIPT_CAPTURES,
  ReceiptCaptureError,
};

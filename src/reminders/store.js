// Reminder persistence is deliberately separate from every financial-ledger key.
const MAX_REMINDER_TITLE_LENGTH = 80;
const MAX_REMINDER_BODY_LENGTH = 240;
const MAX_MANUAL_REMINDERS = 100;
const MAX_REMINDER_DELAY_SECONDS = 31536000;
const ORIGIN = 'mmm-reminders-v1';
const MAX_EVENT_KEYS = 20000;
const OPERATION_STAGES = ['prepared', 'candidate-scheduled', 'switching', 'rollback', 'deleting'];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
}
function boundedToken(value, maximum = 2048) {
  return text(value, maximum) && !/[\u0000-\u001f]/.test(value);
}
function sameKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function validateScope(scope) {
  if (sameKeys(scope, ['kind']) && scope.kind === 'canonical') return;
  if (
    sameKeys(scope, ['kind', 'namespace']) &&
    scope.kind === 'test' &&
    boundedToken(scope.namespace, 128)
  )
    return;
  throw new Error('Choose a valid canonical or isolated test reminder scope.');
}

function encodeReminderOwner(owner) {
  if (!sameKeys(owner, ['scope', 'actor', 'incarnationId']) || !identifier(owner.incarnationId)) {
    throw new Error('The reminder owner requires a valid wallet incarnation.');
  }
  validateScope(owner.scope);
  const actor = owner.actor;
  if (
    !(sameKeys(actor, ['kind']) && actor.kind === 'local') &&
    !(sameKeys(actor, ['kind', 'uid']) && actor.kind === 'firebase' && boundedToken(actor.uid, 128))
  ) {
    throw new Error('Choose a valid local or account reminder owner.');
  }
  return JSON.stringify([
    owner.scope.kind,
    owner.scope.kind === 'test' ? owner.scope.namespace : null,
    actor.kind,
    actor.kind === 'firebase' ? actor.uid : null,
    owner.incarnationId,
  ]);
}

function decodeReminderOwner(token) {
  if (!boundedToken(token)) throw new Error('The reminder owner token is invalid.');
  let values;
  try {
    values = JSON.parse(token);
  } catch {
    throw new Error('The reminder owner token is invalid.');
  }
  if (!Array.isArray(values) || values.length !== 5)
    throw new Error('The reminder owner token is invalid.');
  const [scopeKind, namespace, actorKind, uid, incarnationId] = values;
  if (
    (scopeKind === 'canonical' && namespace !== null) ||
    (actorKind === 'local' && uid !== null)
  ) {
    throw new Error('The reminder owner token has unexpected context fields.');
  }
  const owner = {
    scope: scopeKind === 'canonical' ? { kind: scopeKind } : { kind: scopeKind, namespace },
    actor: actorKind === 'local' ? { kind: actorKind } : { kind: actorKind, uid },
    incarnationId,
  };
  if (encodeReminderOwner(owner) !== token)
    throw new Error('The reminder owner token is not canonical.');
  return owner;
}

function sameReminderScope(left, right) {
  validateScope(left);
  validateScope(right);
  return (
    left.kind === right.kind && (left.kind === 'canonical' || left.namespace === right.namespace)
  );
}
function reminderStorageKey(owner) {
  return `@mymoney/reminders/v1/${encodeURIComponent(encodeReminderOwner(owner))}`;
}

function parseReminderDelay(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (input.length > 32 || !/^\d+$/.test(input)) {
    throw new Error('Enter a whole number of seconds from 1 to 31,536,000 (365 days).');
  }
  const seconds = Number(input);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_REMINDER_DELAY_SECONDS) {
    throw new Error('Reminder delay must be from 1 to 31,536,000 seconds (365 days).');
  }
  return seconds;
}

function validateDraft(draft, now, checkFuture = true) {
  const title = typeof draft?.title === 'string' ? draft.title.trim() : '';
  const body = typeof draft?.body === 'string' ? draft.body.trim() : '';
  if (!text(title, MAX_REMINDER_TITLE_LENGTH))
    throw new Error('Enter a reminder title of 1 to 80 characters.');
  if (!text(body, MAX_REMINDER_BODY_LENGTH))
    throw new Error('Enter a reminder message of 1 to 240 characters.');
  const scheduledAtMs = draft?.scheduledAtMs;
  if (
    !Number.isSafeInteger(scheduledAtMs) ||
    scheduledAtMs <= 0 ||
    scheduledAtMs > 8640000000000000
  ) {
    throw new Error('Choose a valid reminder time.');
  }
  if (
    checkFuture &&
    (!Number.isSafeInteger(now) ||
      scheduledAtMs <= now ||
      scheduledAtMs - now > MAX_REMINDER_DELAY_SECONDS * 1000)
  ) {
    throw new Error('Choose a reminder time in the future and within the next 365 days.');
  }
  return { title, body, scheduledAtMs };
}

function validatePreferences(value) {
  if (
    !object(value) ||
    !['budgets', 'goal', 'achievements'].every((key) => typeof value[key] === 'boolean')
  ) {
    throw new Error('Notification preferences must specify budgets, goal, and achievements.');
  }
  return { budgets: value.budgets, goal: value.goal, achievements: value.achievements };
}
function validateEventKeys(keys) {
  if (
    !Array.isArray(keys) ||
    keys.length > MAX_EVENT_KEYS * 2 ||
    !keys.every((key) => boundedToken(key, 1024))
  ) {
    throw new Error('The local notification event history is invalid or too large.');
  }
  const unique = [...new Set(keys)];
  if (unique.length > MAX_EVENT_KEYS)
    throw new Error('The local notification event history is invalid or too large.');
  return unique;
}
function validateNotice(value) {
  if (
    !object(value) ||
    !boundedToken(value.key, 1024) ||
    !['budget', 'goal', 'achievement'].includes(value.kind) ||
    !text(value.title, MAX_REMINDER_TITLE_LENGTH) ||
    !text(value.body, MAX_REMINDER_BODY_LENGTH) ||
    !Number.isSafeInteger(value.occurredAtMs) ||
    value.occurredAtMs < 0
  ) {
    throw new Error('The automatic notification contains invalid details.');
  }
  return {
    key: value.key,
    kind: value.kind,
    title: value.title.trim(),
    body: value.body.trim(),
    occurredAtMs: value.occurredAtMs,
  };
}
function nativeId(value) {
  return boundedToken(value, 8192);
}

function validateRecord(record) {
  if (
    !object(record) ||
    !identifier(record.id) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.enabled !== 'boolean' ||
    !['scheduled', 'paused', 'elapsed', 'needs-attention'].includes(record.status) ||
    !(record.notificationId === null || nativeId(record.notificationId))
  )
    throw new Error('Invalid saved reminder.');
  validateDraft(record, 0, false);
  if (record.status === 'scheduled' && record.notificationId === null)
    throw new Error('A scheduled reminder is missing its native identifier.');
}

function validateState(value, ownerToken) {
  const invalid = () => {
    throw new Error('Saved reminders have an unsupported, corrupt, or mismatched-owner format.');
  };
  if (
    !object(value) ||
    value.version !== 1 ||
    encodeReminderOwner(value.owner) !== ownerToken ||
    typeof value.ownerPaused !== 'boolean' ||
    typeof value.cleanupPending !== 'boolean' ||
    !Array.isArray(value.reminders) ||
    value.reminders.length > MAX_MANUAL_REMINDERS ||
    !Array.isArray(value.operations) ||
    value.operations.length > 200 ||
    !Array.isArray(value.automaticNoticeErrors) ||
    value.automaticNoticeErrors.length > 100
  )
    invalid();
  try {
    value.reminders.forEach(validateRecord);
    validatePreferences(value.automatic);
    if (validateEventKeys(value.observedEventKeys).length !== value.observedEventKeys.length)
      invalid();
    if (
      new Set(value.reminders.map((item) => item.id)).size !== value.reminders.length ||
      new Set(value.operations.map((item) => item.id)).size !== value.operations.length ||
      new Set(value.operations.map((item) => item.reminderId)).size !== value.operations.length
    )
      invalid();
    for (const operation of value.operations) {
      if (
        !object(operation) ||
        !identifier(operation.id) ||
        !identifier(operation.reminderId) ||
        !['create', 'edit', 'delete', 'notice'].includes(operation.kind) ||
        !OPERATION_STAGES.includes(operation.stage) ||
        !Array.isArray(operation.knownNativeIds) ||
        operation.knownNativeIds.length > 100 ||
        !operation.knownNativeIds.every(nativeId) ||
        new Set(operation.knownNativeIds).size !== operation.knownNativeIds.length ||
        !(operation.candidateIdentifier === null || nativeId(operation.candidateIdentifier)) ||
        !(operation.error === null || text(operation.error, 2000))
      )
        invalid();
      if (operation.previous !== null) {
        validateRecord(operation.previous);
        if (operation.previous.id !== operation.reminderId) invalid();
      }
      if (operation.proposed !== null) {
        validateRecord(operation.proposed);
        if (operation.proposed.id !== operation.reminderId) invalid();
      }
      const existing = value.reminders.find((item) => item.id === operation.reminderId);
      if (
        operation.kind === 'create' &&
        (existing ||
          operation.previous !== null ||
          !operation.proposed ||
          !operation.candidateIdentifier)
      )
        invalid();
      if (
        operation.kind === 'edit' &&
        (!existing ||
          !operation.previous ||
          !operation.proposed ||
          operation.previous.revision !== existing.revision ||
          operation.proposed.revision !== existing.revision + 1 ||
          !operation.candidateIdentifier)
      )
        invalid();
      if (
        operation.kind === 'delete' &&
        (operation.stage !== 'deleting' || operation.proposed !== null)
      )
        invalid();
      if (operation.kind === 'notice') {
        if (
          existing ||
          operation.previous !== null ||
          operation.proposed !== null ||
          !operation.candidateIdentifier
        )
          invalid();
        validateNotice(operation.notice);
        if (!value.observedEventKeys.includes(operation.notice.key)) invalid();
      }
    }
    for (const entry of value.automaticNoticeErrors) {
      if (
        !object(entry) ||
        !boundedToken(entry.key, 1024) ||
        !['budget', 'goal', 'achievement'].includes(entry.kind) ||
        !text(entry.message, 2000)
      )
        invalid();
    }
  } catch {
    invalid();
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function emptyState(owner) {
  return {
    version: 1,
    owner: clone(owner),
    ownerPaused: false,
    cleanupPending: false,
    reminders: [],
    operations: [],
    automatic: { budgets: false, goal: false, achievements: false },
    observedEventKeys: [],
    automaticNoticeErrors: [],
  };
}

function createReminderStore(adapter, owner) {
  const ownerToken = encodeReminderOwner(owner);
  const key = reminderStorageKey(owner);
  if (!adapter || typeof adapter.getItem !== 'function' || typeof adapter.setItem !== 'function')
    throw new Error('Reminder storage is unavailable.');
  return Object.freeze({
    key,
    ownerToken,
    empty: () => emptyState(decodeReminderOwner(ownerToken)),
    async load() {
      const bytes = await adapter.getItem(key);
      if (bytes === null) return null;
      return validateState(JSON.parse(bytes), ownerToken);
    },
    async save(next) {
      validateState(next, ownerToken);
      await adapter.setItem(key, JSON.stringify(next));
    },
  });
}

function notificationIdentifier(ownerToken, reminderId, revision) {
  return `mmm-r1:${encodeURIComponent(ownerToken)}:${reminderId}:${revision}`;
}

function parseNotificationOwner(request) {
  const data = request?.data;
  if (
    !nativeId(request?.identifier) ||
    !object(data) ||
    data.origin !== ORIGIN ||
    !identifier(data.reminderId) ||
    !identifier(data.operationId) ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 1 ||
    !['manual', 'budget', 'goal', 'achievement'].includes(data.kind)
  )
    return null;
  if (data.kind !== 'manual' && !boundedToken(data.eventKey, 1024)) return null;
  try {
    const owner = decodeReminderOwner(data.ownerToken);
    return { owner, ownerToken: data.ownerToken, data };
  } catch {
    return null;
  }
}

module.exports = {
  MAX_REMINDER_TITLE_LENGTH,
  MAX_REMINDER_BODY_LENGTH,
  MAX_MANUAL_REMINDERS,
  MAX_REMINDER_DELAY_SECONDS,
  parseReminderDelay,
  encodeReminderOwner,
  decodeReminderOwner,
  sameReminderScope,
  reminderStorageKey,
  createReminderStore,
  ORIGIN,
  identifier,
  clone,
  validateDraft,
  validatePreferences,
  validateEventKeys,
  validateNotice,
  notificationIdentifier,
  parseNotificationOwner,
};

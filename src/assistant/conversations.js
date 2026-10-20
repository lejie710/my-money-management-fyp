const { validateWire } = require('./protocol');
const MAX_CONVERSATIONS = 20;
const MAX_TURNS = 12;
const MAX_STORE_CHARACTERS = 1000000;
const queues = new WeakMap();
const fields = (value, names) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const plain = (text, limit) => typeof text === 'string' && text.length > 0 && text.length <= limit;
const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = () => {
  throw new Error('Saved conversations could not be read safely. Existing history is retained.');
};

function validateContext(value) {
  if (
    !fields(value, [
      'version',
      'startDate',
      'endDate',
      'currency',
      'recordedIncomeIsZero',
      'selected',
      'facts',
    ]) ||
    value.version !== 1 ||
    typeof value.recordedIncomeIsZero !== 'boolean' ||
    !fields(value.selected, [
      'allDatesBalance',
      'categories',
      'budgets',
      'goal',
      'health',
      'comparisons',
    ]) ||
    Object.values(value.selected).some((entry) => typeof entry !== 'boolean')
  )
    fail();
  try {
    validateWire({
      version: 1,
      requestId: 'conversation-validation',
      templateVersion: 'recorded-facts-v2',
      period: { startDate: value.startDate, endDate: value.endDate, inclusive: true },
      currency: value.currency,
      facts: value.facts,
      question: 'Inspect the saved context.',
    });
  } catch {
    fail();
  }
  return clone(value);
}
function validateConversation(value) {
  if (
    !fields(value, [
      'id',
      'createdAt',
      'updatedAt',
      'walletId',
      'walletName',
      'provider',
      'context',
      'turns',
    ]) ||
    !plain(value.id, 96) ||
    !/^[A-Za-z0-9_-]+$/.test(value.id) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    !plain(value.walletId, 160) ||
    !plain(value.walletName, 80) ||
    !fields(value.provider, ['engine', 'processing', 'model']) ||
    !['openai', 'lemonade'].includes(value.provider.engine) ||
    value.provider.processing !== (value.provider.engine === 'openai' ? 'cloud' : 'local') ||
    !plain(value.provider.model, 160) ||
    !/^[A-Za-z0-9_.:-]+$/.test(value.provider.model) ||
    !Array.isArray(value.turns) ||
    value.turns.length < 1 ||
    value.turns.length > MAX_TURNS
  )
    fail();
  const context = validateContext(value.context);
  const factIds = new Set(context.facts.map((row) => row.id));
  for (const turn of value.turns)
    if (
      !fields(turn, ['question', 'answer', 'factIds']) ||
      !plain(turn.question, 500) ||
      !plain(turn.answer, 1200) ||
      !Array.isArray(turn.factIds) ||
      !turn.factIds.length ||
      turn.factIds.length > 8 ||
      new Set(turn.factIds).size !== turn.factIds.length ||
      turn.factIds.some((id) => !factIds.has(id))
    )
      fail();
  return clone(value);
}
function decode(raw) {
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > MAX_STORE_CHARACTERS) fail();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail();
  }
  if (
    !fields(value, ['version', 'conversations']) ||
    value.version !== 1 ||
    !Array.isArray(value.conversations) ||
    value.conversations.length > MAX_CONVERSATIONS
  )
    fail();
  const records = value.conversations.map(validateConversation);
  if (new Set(records.map((row) => row.id)).size !== records.length) fail();
  return records;
}
function createConversationStore(storage, ownerKey) {
  if (
    !storage ||
    !['getItem', 'setItem', 'removeItem'].every((key) => typeof storage[key] === 'function') ||
    !plain(ownerKey, 2048)
  )
    throw new Error('An account-bound conversation store is required.');
  const key = 'money-management:conversations:v1:' + encodeURIComponent(ownerKey);
  let shared = queues.get(storage);
  if (!shared) {
    shared = new Map();
    queues.set(storage, shared);
  }
  const serial = (work) => {
    const run = (shared.get(key) || Promise.resolve()).catch(() => {}).then(work);
    shared.set(key, run);
    return run.finally(() => {
      if (shared.get(key) === run) shared.delete(key);
    });
  };
  async function commit(records) {
    const raw = JSON.stringify({ version: 1, conversations: records });
    if (raw.length > MAX_STORE_CHARACTERS)
      throw new Error(
        'Conversation storage is full. Delete an older conversation before saving more.',
      );
    await storage.setItem(key, raw);
    if ((await storage.getItem(key)) !== raw)
      throw new Error(
        'Saving the conversation could not be confirmed. Reopen history before retrying.',
      );
    return clone(records);
  }
  return Object.freeze({
    load: () => serial(async () => decode(await storage.getItem(key))),
    save: (record, expectedUpdatedAt = null) =>
      serial(async () => {
        const checked = validateConversation(record);
        const previous = decode(await storage.getItem(key));
        const found = previous.find((row) => row.id === checked.id);
        if (
          expectedUpdatedAt === null
            ? !!found
            : !Number.isSafeInteger(expectedUpdatedAt) ||
              !found ||
              found.updatedAt !== expectedUpdatedAt
        )
          throw new Error(
            'This conversation changed or was deleted. Reopen history before continuing.',
          );
        if (
          found &&
          (found.createdAt !== checked.createdAt ||
            found.walletId !== checked.walletId ||
            JSON.stringify(found.context) !== JSON.stringify(checked.context) ||
            JSON.stringify(found.provider) !== JSON.stringify(checked.provider) ||
            found.updatedAt >= checked.updatedAt)
        )
          throw new Error('This conversation changed. Reopen history before continuing.');
        const records = [checked, ...previous.filter((row) => row.id !== checked.id)].sort(
          (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
        );
        if (records.length > MAX_CONVERSATIONS)
          throw new Error(
            'The device holds 20 conversations for this account. Delete one before saving another.',
          );
        return commit(records);
      }),
    remove: (id) =>
      serial(async () => {
        const previous = decode(await storage.getItem(key));
        return commit(previous.filter((row) => row.id !== id));
      }),
  });
}
module.exports = {
  MAX_CONVERSATIONS,
  MAX_TURNS,
  MAX_STORE_CHARACTERS,
  validateContext,
  validateConversation,
  createConversationStore,
};

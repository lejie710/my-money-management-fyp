const { validateLedger, totals, DEFAULT_CATEGORIES } = require('../core/model');
const { validatePhotoInspection, validatePhotoRef } = require('../core/transactionContext');
const FORMAT = 'mymoney-backup-v1';
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 100,
  MAX_TOTAL_PHOTO_BYTES = 50 * 1024 * 1024;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
function known(v, names, label) {
  if (!object(v) || Object.keys(v).some((key) => !names.includes(key)))
    throw new Error(`${label} contains unsupported fields. The original wallet is unchanged.`);
}
function exact(v, names, label) {
  known(v, names, label);
  if (Object.keys(v).length !== names.length) throw new Error(`${label} is incomplete.`);
}
function utf8(text) {
  const encoded = encodeURIComponent(text);
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(encoded.charCodeAt(i));
  }
  return new Uint8Array(bytes);
}
function decodeUtf8(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_SNAPSHOT_BYTES)
    throw new Error('The snapshot exceeds its supported size.');
  let encoded = '';
  for (const b of bytes) encoded += '%' + b.toString(16).padStart(2, '0');
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error('The snapshot text is invalid.');
  }
}
const evidenceKeys = {
  first_budget: ['budgetId'],
  first_transaction: ['transactionId', 'date'],
  weekly_saver: [
    'startDate',
    'endDate',
    'dayCount',
    'transactionCount',
    'incomeMinor',
    'expenseMinor',
    'debtMinor',
    'netMinor',
  ],
  budget_master: [
    'month',
    'budgetCount',
    'matchedExpenseCount',
    'totalPlannedMinor',
    'totalSpentMinor',
  ],
  expense_tracker: ['startDate', 'endDate', 'dayCount', 'expenseCount'],
  consistent_tracker: ['startDate', 'endDate', 'dayCount', 'transactionCount'],
  savings_goal_achiever: ['goalId', 'targetMinor', 'balanceMinor', 'throughDate'],
  no_spend_day: ['date', 'confirmedAtMs'],
  category_guru: ['categoryIds', 'distinctCategoryCount', 'throughDate'],
  review_expert: ['weekStarts', 'completedAtMs'],
};
function portableLedger(value) {
  validateLedger(value);
  known(
    value,
    ['version', 'mode', 'wallet', 'achievements', 'categories', 'transactions', 'budgets', 'goal'],
    'Wallet',
  );
  known(
    value.wallet,
    ['id', 'name', 'currency', 'hasTransactionHistory', 'incarnationId', 'trackingStartedOn'],
    'Wallet details',
  );
  known(
    value.achievements,
    ['version', 'ownerIncarnationId', 'awards', 'completedDays', 'weeklyReviews'],
    'Achievements',
  );
  for (const row of value.achievements.awards) {
    known(row, ['id', 'ruleVersion', 'earnedAtMs', 'earnedOnDate', 'evidence'], 'Achievement');
    known(row.evidence, ['kind', ...evidenceKeys[row.id]], 'Achievement evidence');
  }
  for (const row of value.achievements.completedDays)
    known(row, ['date', 'confirmedAtMs'], 'Completed day');
  for (const row of value.achievements.weeklyReviews)
    known(
      row,
      ['weekStart', 'completedOnDate', 'completedAtMs', 'expenseMinor', 'debtMinor', 'budgetCount'],
      'Weekly review',
    );
  for (const row of value.categories) known(row, ['id', 'name', 'type', 'isDefault'], 'Category');
  for (const row of value.budgets)
    known(
      row,
      ['id', 'walletId', 'categoryId', 'plannedMinor', 'period', 'startDate', 'endDate'],
      'Budget',
    );
  if (value.goal) known(value.goal, ['id', 'walletId', 'kind', 'targetMinor'], 'Savings goal');
  for (const row of value.transactions) {
    known(
      row,
      ['id', 'walletId', 'title', 'categoryId', 'type', 'amountMinor', 'date', 'context'],
      'Transaction',
    );
    if (row.context) {
      known(row.context, ['notes', 'photo', 'withPerson', 'location'], 'Transaction context');
      if (row.context.withPerson) known(row.context.withPerson, ['name', 'source'], 'Person label');
      if (row.context.location) known(row.context.location, ['label', 'source'], 'Place label');
    }
  }
  const copy = clone(value);
  for (const row of copy.transactions) if (row.context) row.context.photo = null;
  return validateLedger(copy);
}
function cloudOwner(value) {
  exact(value, ['projectId', 'uid'], 'Cloud owner');
  if (
    typeof value.projectId !== 'string' ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.projectId) ||
    value.projectId.trim() !== value.projectId ||
    typeof value.uid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.uid)
  )
    throw new Error('Cloud account identity is unsupported.');
  return { projectId: value.projectId, uid: value.uid };
}
function backupId(value) {
  if (typeof value !== 'string' || !/^backup-[a-z0-9-]{16,96}$/.test(value))
    throw new Error('The backup identifier is invalid.');
  return value;
}
function hashValue(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('The backup integrity value is invalid.');
  return value;
}
function makeSnapshot({ ledger, owner, id, createdAtMs, photos = [], includePhotos = false }) {
  if (
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    createdAtMs > 8640000000000000 ||
    typeof includePhotos !== 'boolean'
  )
    throw new Error('Choose a valid backup time and photo selection.');
  if (includePhotos) {
    const expected = ledger.transactions
      .filter((row) => row.context?.photo)
      .map((row) => row.id)
      .sort();
    const included = photos.flatMap((row) => row.transactionIds ?? []).sort();
    if (JSON.stringify(expected) !== JSON.stringify(included))
      throw new Error('Selected photo attachments must all be included or explicitly excluded.');
  }
  const value = {
    version: FORMAT,
    owner: cloudOwner(owner),
    backupId: backupId(id),
    createdAtMs,
    includesPhotos: includePhotos,
    ledger: portableLedger(ledger),
    photos: clone(photos),
  };
  return validateSnapshot(value, owner);
}
function validateSnapshot(value, expectedOwner) {
  exact(
    value,
    ['version', 'owner', 'backupId', 'createdAtMs', 'includesPhotos', 'ledger', 'photos'],
    'Backup',
  );
  if (
    value.version !== FORMAT ||
    JSON.stringify(cloudOwner(value.owner)) !== JSON.stringify(cloudOwner(expectedOwner))
  )
    throw new Error('This backup belongs to another project or account.');
  backupId(value.backupId);
  if (
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0 ||
    value.createdAtMs > 8640000000000000 ||
    typeof value.includesPhotos !== 'boolean' ||
    !Array.isArray(value.photos) ||
    value.photos.length > MAX_PHOTOS ||
    (!value.includesPhotos && value.photos.length)
  )
    throw new Error('The backup metadata is invalid.');
  const ledger = portableLedger(value.ledger);
  // Portable source already has no local references. Reject, do not silently erase forged references.
  if (JSON.stringify(ledger) !== JSON.stringify(value.ledger))
    throw new Error('Backup contains local attachment references.');
  const ids = new Set(ledger.transactions.map((row) => row.id)),
    seen = new Set();
  let total = 0;
  for (const item of value.photos) {
    exact(
      item,
      ['sha256', 'mimeType', 'width', 'height', 'byteSize', 'transactionIds'],
      'Backup photo',
    );
    hashValue(item.sha256);
    validatePhotoInspection(item);
    total += item.byteSize;
    if (
      !Array.isArray(item.transactionIds) ||
      !item.transactionIds.length ||
      item.transactionIds.length > 10000
    )
      throw new Error('Backup photo references are invalid.');
    for (const id of item.transactionIds) {
      if (!ids.has(id) || seen.has(id))
        throw new Error('Backup photo references are inconsistent.');
      seen.add(id);
    }
  }
  if (
    total > MAX_TOTAL_PHOTO_BYTES ||
    new Set(value.photos.map((row) => row.sha256)).size !== value.photos.length
  )
    throw new Error('Backup photo selection exceeds its supported limits.');
  if (utf8(JSON.stringify(value)).length > MAX_SNAPSHOT_BYTES)
    throw new Error('The wallet exceeds the 5 MiB snapshot limit. No partial backup was created.');
  return clone(value);
}
function isEmptyTarget(ledger) {
  validateLedger(ledger);
  return (
    JSON.stringify(ledger.categories) === JSON.stringify(DEFAULT_CATEGORIES) &&
    !ledger.wallet.hasTransactionHistory &&
    !ledger.transactions.length &&
    !ledger.budgets.length &&
    !ledger.goal &&
    !ledger.achievements.awards.length &&
    !ledger.achievements.completedDays.length &&
    !ledger.achievements.weeklyReviews.length
  );
}
function restoreLedger(snapshot, expectedOwner, incarnationId, photoRefs = {}) {
  const checked = validateSnapshot(snapshot, expectedOwner),
    ledger = clone(checked.ledger);
  ledger.wallet.incarnationId = incarnationId;
  ledger.achievements.ownerIncarnationId = incarnationId;
  const expected = new Set();
  for (const item of checked.photos) {
    const photo = photoRefs[item.sha256];
    validatePhotoRef(photo, incarnationId);
    for (const key of ['mimeType', 'width', 'height', 'byteSize'])
      if (photo[key] !== item[key])
        throw new Error('Restored photo does not match the confirmed backup.');
    for (const id of item.transactionIds) {
      expected.add(id);
      const row = ledger.transactions.find((t) => t.id === id);
      row.context = {
        notes: '',
        photo: null,
        withPerson: null,
        location: null,
        ...row.context,
        photo,
      };
    }
  }
  if (Object.keys(photoRefs).length !== checked.photos.length)
    throw new Error('Restored photo set does not match this backup.');
  return validateLedger(ledger);
}
function summary(ledger) {
  validateLedger(ledger);
  return {
    walletName: ledger.wallet.name,
    currency: ledger.wallet.currency,
    transactions: ledger.transactions.length,
    budgets: ledger.budgets.length,
    hasGoal: !!ledger.goal,
    balanceMinor: totals(ledger).balance,
    photos: ledger.transactions.filter((row) => row.context?.photo).length,
  };
}
module.exports = {
  FORMAT,
  MAX_SNAPSHOT_BYTES,
  MAX_PHOTOS,
  MAX_TOTAL_PHOTO_BYTES,
  utf8,
  decodeUtf8,
  portableLedger,
  cloudOwner,
  backupId,
  hashValue,
  makeSnapshot,
  validateSnapshot,
  isEmptyTarget,
  restoreLedger,
  summary,
};

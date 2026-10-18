const { createLedgerStorage, STORAGE_KEY, MIGRATION_STORAGE_KEYS } = require('../core/storage');
const { validateLedger } = require('../core/model');
const { encodeDataFamily, validateDataFamily } = require('./identity');
function familyStorageKeys(value) {
  const family = validateDataFamily(value);
  if (family.actor.kind === 'local')
    return family.scope.kind === 'canonical'
      ? { key: STORAGE_KEY, legacyKeys: [...MIGRATION_STORAGE_KEYS] }
      : {
          key: `@mymoney/test/${family.scope.namespace}/v5`,
          legacyKeys: [4, 3, 2, 1].map(
            (version) => `@mymoney/test/${family.scope.namespace}/v${version}`,
          ),
        };
  return {
    key: `@mymoney/account-ledger/v5/${encodeURIComponent(encodeDataFamily(family))}`,
    legacyKeys: [],
  };
}
function createFamilyLedgerStorage(adapter, value, options = {}) {
  const family = validateDataFamily(value),
    token = encodeDataFamily(family),
    keys = familyStorageKeys(family);
  if (family.actor.kind === 'local')
    return createLedgerStorage(adapter, {
      ...keys,
      identityContext: options.identityContext,
    });
  const envelopeAdapter = {
    async getItem(key) {
      if (key !== keys.key) throw new Error('Account storage cannot read another family.');
      const raw = await adapter.getItem(key);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      if (
        !value ||
        Object.keys(value).sort().join(',') !== 'family,ledger,version' ||
        value.version !== 1 ||
        encodeDataFamily(value.family) !== token
      )
        throw new Error('The saved account wallet has invalid ownership or format.');
      return JSON.stringify(validateLedger(value.ledger));
    },
    async setItem(key, raw) {
      if (key !== keys.key) throw new Error('Account storage cannot write another family.');
      const ledger = validateLedger(JSON.parse(raw));
      await adapter.setItem(key, JSON.stringify({ version: 1, family, ledger }));
    },
  };
  return createLedgerStorage(envelopeAdapter, keys);
}
module.exports = { familyStorageKeys, createFamilyLedgerStorage };

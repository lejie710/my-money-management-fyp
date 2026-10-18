const { validateLedger } = require('./ledger');

const STORAGE_KEY = '@mymoney/local-demo/v1';

// Persist before updating the visible ledger. A failed write must not claim success.
function createLedgerStorage(adapter) {
  return {
    async load() {
      const text = await adapter.getItem(STORAGE_KEY);
      if (text === null) return null;
      return validateLedger(JSON.parse(text));
    },
    async save(ledger) {
      validateLedger(ledger);
      await adapter.setItem(STORAGE_KEY, JSON.stringify(ledger));
      return ledger;
    },
  };
}

module.exports = { STORAGE_KEY, createLedgerStorage };

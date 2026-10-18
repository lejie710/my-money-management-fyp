// Shared per-adapter/key queue survives controller remounts; no external work runs under it.
const stores = new WeakMap();
class PendingJournalError extends Error {
  constructor(code, plan) {
    super(
      code === 'PENDING'
        ? 'A pending backup already exists. Resume or explicitly discard it before creating another.'
        : code === 'CHANGED'
          ? 'The wallet changed before pending backup state could be confirmed.'
          : 'Pending backup state could not be read or confirmed. It was retained; recheck or explicitly discard it before starting another.',
    );
    this.name = 'PendingJournalError';
    this.code = code;
    if (plan) this.plan = plan;
  }
}
function exclusive(storage, key, work) {
  let queues = stores.get(storage);
  if (!queues) {
    queues = new Map();
    stores.set(storage, queues);
  }
  const previous = queues.get(key) || Promise.resolve(),
    run = previous.then(work),
    tail = run.then(
      () => {},
      () => {},
    );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}
function createPendingJournal(storage, key, validate) {
  const current = (fn) => {
    try {
      fn();
    } catch {
      throw new PendingJournalError('CHANGED');
    }
  };
  const read = async () => {
    try {
      const raw = await storage.getItem(key);
      if (raw === null) return null;
      if (typeof raw !== 'string' || raw.length > 6 * 1024 * 1024) throw Error();
      return validate(JSON.parse(raw));
    } catch {
      throw new PendingJournalError('UNAVAILABLE');
    }
  };
  const write = async (raw) => {
    try {
      if (raw === null) await storage.removeItem(key);
      else await storage.setItem(key, raw);
    } catch {
      try {
        if ((await storage.getItem(key)) === raw) return;
      } catch {}
      throw new PendingJournalError('UNAVAILABLE');
    }
  };
  return Object.freeze({
    read(isCurrent) {
      return exclusive(storage, key, async () => {
        current(isCurrent);
        const plan = await read();
        current(isCurrent);
        return plan;
      });
    },
    begin(plan, isCurrent) {
      let raw;
      try {
        raw = JSON.stringify(validate(JSON.parse(JSON.stringify(plan))));
      } catch {
        throw new PendingJournalError('UNAVAILABLE');
      }
      return exclusive(storage, key, async () => {
        current(isCurrent);
        const previous = await read();
        current(isCurrent);
        if (previous) throw new PendingJournalError('PENDING', previous);
        await write(raw);
        current(isCurrent);
        return JSON.parse(raw);
      });
    },
    clear(expectedId, isCurrent) {
      return exclusive(storage, key, async () => {
        current(isCurrent);
        if (expectedId !== null) {
          const previous = await read();
          current(isCurrent);
          if (!previous || previous.snapshot.backupId !== expectedId)
            throw new PendingJournalError('CHANGED');
        }
        if (expectedId === null) {
          let recovered = null;
          try {
            recovered = await read();
          } catch (error) {
            if (error.code !== 'UNAVAILABLE') throw error;
          }
          current(isCurrent);
          if (recovered) throw new PendingJournalError('PENDING', recovered);
        }
        await write(null);
        current(isCurrent);
      });
    },
  });
}
module.exports = { createPendingJournal, PendingJournalError };

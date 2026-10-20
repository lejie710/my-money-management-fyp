const KEY = '@mymoney/appearance/v1';
const DEFAULTS = Object.freeze({ version: 1, appearance: 'system', hideHomeBalance: false });
function decode(raw) {
  if (raw === null) return { ...DEFAULTS };
  const value = JSON.parse(raw);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'appearance,hideHomeBalance,version' ||
    value.version !== 1 ||
    !['system', 'light', 'dark'].includes(value.appearance) ||
    typeof value.hideHomeBalance !== 'boolean'
  )
    throw new Error('Display preferences are unavailable.');
  return value;
}
function resolveAppearance(preference, systemScheme) {
  return preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;
}
function createAppearancePreferences(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function')
    throw new Error('Display preferences need local storage.');
  let view = Object.freeze({ ...DEFAULTS, ready: false, saving: false, error: '' });
  let loadInFlight = null,
    writes = Promise.resolve(),
    pending = 0;
  const listeners = new Set();
  const publish = (next) => {
    view = Object.freeze({ ...view, ...next });
    for (const listener of listeners) listener();
  };
  const initialize = () => {
    if (loadInFlight) return loadInFlight;
    if (pending) return Promise.resolve(false);
    publish({ error: '' });
    loadInFlight = (async () => {
      try {
        const saved = decode(await storage.getItem(KEY));
        publish({ ...saved, ready: true, error: '' });
        return true;
      } catch {
        publish({
          ready: false,
          error:
            'Display preferences could not be opened. Your saved preferences were kept. Retry to change appearance or show the home balance.',
        });
        return false;
      } finally {
        loadInFlight = null;
      }
    })();
    return loadInFlight;
  };
  const update = (patch) => {
    if (!view.ready || loadInFlight) return Promise.resolve(false);
    pending++;
    publish({ saving: true, error: '' });
    const run = writes
      .then(async () => {
        if (!view.ready) return false;
        const previous = {
          version: 1,
          appearance: view.appearance,
          hideHomeBalance: view.hideHomeBalance,
        };
        const next = { ...previous, ...patch },
          raw = JSON.stringify(next);
        try {
          await storage.setItem(KEY, raw);
          publish({ ...next, error: '' });
          return true;
        } catch {
          try {
            const actual = decode(await storage.getItem(KEY));
            if (JSON.stringify(actual) === raw) {
              publish({ ...actual, error: '' });
              return true;
            }
            publish({
              ...actual,
              error:
                'The display change was not saved. The saved preference is still in use; try again.',
            });
          } catch {
            publish({
              ready: false,
              error:
                'The display change could not be confirmed. Retry to reopen your saved preferences.',
            });
          }
          return false;
        }
      })
      .finally(() => {
        pending--;
        publish({ saving: pending > 0 });
      });
    writes = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  return Object.freeze({
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize,
    setAppearance(value) {
      if (!['system', 'light', 'dark'].includes(value))
        return Promise.reject(new Error('Choose System, Light or Dark.'));
      return update({ appearance: value });
    },
    setBalanceHidden(value) {
      if (typeof value !== 'boolean')
        return Promise.reject(new Error('Choose whether to hide the home balance.'));
      return update({ hideHomeBalance: value });
    },
  });
}
module.exports = { KEY, DEFAULTS, decode, resolveAppearance, createAppearancePreferences };

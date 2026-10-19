// Opaque SDK-session persistence. Never parses or exposes credentials/token fields.
let nextRetirementId = 0;
function createGuardedAuthPersistence(adapter, { prefix, sessionKey }) {
  if (
    !adapter ||
    !['getItem', 'setItem', 'removeItem'].every((key) => typeof adapter[key] === 'function') ||
    typeof prefix !== 'string' ||
    !(prefix.startsWith('@mymoney/auth/v1/') || prefix.startsWith('@mymoney/auth-cloud/v1/')) ||
    !prefix.endsWith('/') ||
    typeof sessionKey !== 'string' ||
    !sessionKey.startsWith('firebase:authUser:')
  ) {
    throw new Error('A scoped local authentication store is required.');
  }
  let tail = Promise.resolve();
  let phase = 'hydrating',
    blocked = false,
    revision = 0;
  let initialKnown = false,
    initialHadSession = false,
    sessionObserved = false;
  let probeSet = false,
    probeReady = false;
  let retirement = null,
    retirementAttempted = false,
    retirementConfirmed = false;
  const listeners = new Set();
  const changed = () => {
    revision++;
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  const unavailable = () =>
    new Error(
      'Local account persistence could not be confirmed. Saved session data was retained where possible. Restart after storage is available.',
    );
  const fault = (hydrationRemoval = false) => {
    if (!hydrationRemoval) retirement = null;
    blocked = true;
    changed();
    return unavailable();
  };
  function keyFor(key) {
    if (typeof key !== 'string' || !key || key.length > 4096 || /[\u0000-\u001f]/.test(key))
      throw fault();
    return prefix + encodeURIComponent(key);
  }
  function queue(work) {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function read(key) {
    let value;
    try {
      value = await adapter.getItem(keyFor(key));
      if (value !== null && typeof value !== 'string') throw unavailable();
    } catch {
      throw fault();
    }
    if (key === sessionKey) {
      // Syntax only: never inspect token/credential fields. Prevent the SDK's
      // JSON parser from including malformed saved bytes in its own warning.
      if (value !== null) {
        try {
          JSON.parse(value);
        } catch {
          throw fault();
        }
      }
      sessionObserved = true;
      if (!initialKnown) {
        initialKnown = true;
        initialHadSession = value !== null;
      }
    }
    return value;
  }
  async function write(key, value) {
    if (blocked) throw unavailable();
    const scopedKey = keyFor(key);
    if (value !== null && typeof value !== 'string') throw fault();
    const before = await read(key);
    if (key === sessionKey && phase === 'hydrating' && value === null && before !== null) {
      // Never silently drop an existing session, even when the server revoked it.
      // A separate explicit action may retire only these exact known bytes.
      if (probeReady && sessionObserved && initialHadSession && !retirementAttempted)
        retirement = { token: `saved-sign-in-${++nextRetirementId}`, bytes: before };
      throw fault(true);
    }
    try {
      if (value === null) await adapter.removeItem(scopedKey);
      else await adapter.setItem(scopedKey, value);
    } catch {
      /* Exact readback below decides whether the operation committed. */
    }
    let actual;
    try {
      actual = await adapter.getItem(scopedKey);
    } catch {
      throw fault();
    }
    if (actual !== value) throw fault();
    // Exact readback resolves both successful writes and write-then-throw outcomes.
    if (key === '__sak') {
      if (value === '1') probeSet = true;
      if (value === null && probeSet) probeReady = true;
    }
    changed();
    return undefined;
  }
  const storage = {
    getItem(key) {
      return queue(() => read(key));
    },
    setItem(key, value) {
      return queue(() => write(key, value));
    },
    removeItem(key) {
      return queue(() => write(key, null));
    },
  };
  return {
    storage,
    async preflight() {
      await storage.getItem(sessionKey);
      await storage.setItem('__fyp_storage_probe', '1');
      await storage.removeItem('__fyp_storage_probe');
    },
    confirm(expectedBytes) {
      if (expectedBytes !== null && typeof expectedBytes !== 'string')
        return Promise.resolve(false);
      return queue(async () => {
        try {
          const actual = await read(sessionKey);
          return !blocked && probeReady && sessionObserved && actual === expectedBytes;
        } catch {
          return false;
        }
      });
    },
    async finishInitialization(expectedBytes) {
      if (!(await this.confirm(expectedBytes))) return false;
      phase = 'ready';
      changed();
      return true;
    },
    retireSavedSession(token) {
      return queue(async () => {
        if (
          !blocked ||
          phase !== 'hydrating' ||
          retirementAttempted ||
          !retirement ||
          token !== retirement.token ||
          !probeReady ||
          !sessionObserved
        )
          throw unavailable();
        const expected = retirement.bytes;
        const scopedKey = keyFor(sessionKey);
        const probeKey = keyFor('__fyp_retirement_probe');
        try {
          if ((await adapter.getItem(scopedKey)) !== expected) throw unavailable();
          // Reconcile only our exact reserved sentinel after an interrupted probe.
          // Unknown values stay blocked; no Auth bytes are removed at this stage.
          const previousProbe = await adapter.getItem(probeKey);
          if (previousProbe === '1') {
            try {
              await adapter.removeItem(probeKey);
            } catch {
              /* Exact absence readback decides. */
            }
            if ((await adapter.getItem(probeKey)) !== null) throw unavailable();
          } else if (previousProbe !== null) throw unavailable();
          // A fresh successful probe is still required for every explicit attempt.
          try {
            await adapter.setItem(probeKey, '1');
          } catch {
            /* Readback decides. */
          }
          if ((await adapter.getItem(probeKey)) !== '1') throw unavailable();
          try {
            await adapter.removeItem(probeKey);
          } catch {
            /* Readback decides. */
          }
          if ((await adapter.getItem(probeKey)) !== null) throw unavailable();
          if ((await adapter.getItem(scopedKey)) !== expected) throw unavailable();
          // The ticket is single use. This guard never accepts another SDK write.
          retirementAttempted = true;
          retirement = null;
          changed();
          try {
            await adapter.removeItem(scopedKey);
          } catch {
            /* Readback decides. */
          }
          if ((await adapter.getItem(scopedKey)) !== null) throw unavailable();
          retirementConfirmed = true;
          changed();
          return true;
        } catch {
          retirement = null;
          throw fault();
        }
      });
    },
    getState() {
      return Object.freeze({
        phase,
        blocked,
        revision,
        probeReady,
        sessionObserved,
        initialHadSession,
        sessionRetirementToken: retirement?.token ?? null,
        sessionRetired: retirementConfirmed,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    drain() {
      return tail;
    },
  };
}
module.exports = { createGuardedAuthPersistence };

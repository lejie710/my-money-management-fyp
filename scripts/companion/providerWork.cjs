// Caller-facing cancellation is separate from underlying local transport completion.
function createProviderWork() {
  const pending = new Set(),
    cancellations = new WeakMap();
  let cleanupFailed = false;
  const track = (value, cleanup = false) => {
    const promise = Promise.resolve(value);
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => {
        pending.delete(promise);
        if (cleanup) cleanupFailed = true;
      },
    );
    return promise;
  };
  const cancel = (target) => {
    if (!target || typeof target.cancel !== 'function') return;
    if (cancellations.has(target)) return cancellations.get(target);
    let promise;
    try {
      promise = track(target.cancel(), true);
    } catch {
      cleanupFailed = true;
      promise = Promise.resolve();
    }
    cancellations.set(target, promise);
    return promise;
  };
  const drain = (timeoutMs = 5000) => {
    let timer;
    const work = (async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      if (cleanupFailed) throw new Error('Provider local cleanup could not be confirmed.');
    })();
    const result = Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Provider local cleanup deadline exceeded.')),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    // Legacy callers may not await close; do not turn that into an unhandled rejection.
    // Owners which await the original result still receive the cleanup failure.
    result.catch(() => {});
    return result;
  };
  return {
    track,
    cancel,
    drain,
    get cleanupFailed() {
      return cleanupFailed;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
module.exports = { createProviderWork };

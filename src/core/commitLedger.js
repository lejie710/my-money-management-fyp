const { validateLedger } = require('./model');

/** Persist a financial snapshot without guessing the outcome of a rejected write. */
async function commitLedger({ current, next, storage, transition }) {
  const currentBytes = JSON.stringify(validateLedger(current));
  const nextBytes = JSON.stringify(validateLedger(next));
  const previous = JSON.parse(currentBytes);
  const candidate = JSON.parse(nextBytes);
  const changingOwner = previous.wallet.incarnationId !== candidate.wallet.incarnationId;
  const result = (ok, ledger, blocked, message) => ({ ok, ledger, blocked, message });

  const resumePrevious = async () => {
    if (!changingOwner) return '';
    try {
      const resumed = await transition.resume(previous);
      if (resumed.ok && !resumed.pending) return ' The previous wallet’s reminders were restored.';
    } catch {
      // A failed compensation is visible; it cannot turn an unsuccessful reset into success.
    }
    return ' The previous wallet remains active, but its reminders need repair in Reminders.';
  };

  if (changingOwner) {
    if (!transition)
      return result(
        false,
        previous,
        false,
        'Reminders are still opening. Try the wallet reset again shortly.',
      );
    let prepared;
    try {
      prepared = await transition.prepare(previous, candidate);
    } catch {
      prepared = { ok: false, pending: true };
    }
    if (!prepared.ok || prepared.pending) {
      const recovery = await resumePrevious();
      return result(
        false,
        previous,
        false,
        'The wallet was not replaced because reminder cleanup did not finish.' + recovery,
      );
    }
  }

  try {
    const saved = validateLedger(await storage.save(candidate));
    if (JSON.stringify(saved) !== nextBytes) throw new Error('Unexpected saved snapshot.');
    return result(true, saved, false, '');
  } catch {
    let observed;
    try {
      // This deliberately excludes migration fallback and initial-data creation.
      observed = await storage.readCurrent();
      if (observed === null) throw new Error('The active saved wallet is missing.');
      validateLedger(observed);
    } catch {
      return result(
        false,
        previous,
        true,
        'The save outcome could not be confirmed. Reopen saved data before making further changes.' +
          (changingOwner
            ? ' The previous reminders remain paused until the saved wallet is known.'
            : ''),
      );
    }

    if (JSON.stringify(observed) === nextBytes)
      return result(
        true,
        observed,
        false,
        'The save was confirmed by reopening the stored records.',
      );

    const recovery =
      changingOwner && observed.wallet.incarnationId === previous.wallet.incarnationId
        ? await resumePrevious()
        : '';
    return result(
      false,
      observed,
      false,
      'The requested change was not confirmed. The actual saved records have been reopened.' +
        recovery,
    );
  }
}

module.exports = { commitLedger };

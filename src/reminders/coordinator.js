const storageTools = require('./store');
const {
  ORIGIN,
  MAX_MANUAL_REMINDERS,
  identifier,
  clone,
  encodeReminderOwner,
  decodeReminderOwner,
  sameReminderScope,
  validateDraft,
  validatePreferences,
  validateEventKeys,
  validateNotice,
  notificationIdentifier,
  parseNotificationOwner,
} = storageTools;

// Shared across hook remounts: a disposed instance may still be finishing a
// native call. Its successor must not race that call's durable journal update.
const ownerQueues = new Map();

function message(error) {
  return (error instanceof Error ? error.message : 'The notification operation failed.').slice(
    0,
    1800,
  );
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function result(ok, text, pending = false, reminderId) {
  return { ok, pending, message: text, ...(reminderId ? { reminderId } : {}) };
}
function validPermission(value) {
  if (
    !value ||
    !['unknown', 'granted', 'denied', 'unavailable'].includes(value.status) ||
    typeof value.canAskAgain !== 'boolean' ||
    ![true, false, null].includes(value.channelEnabled)
  ) {
    throw new Error('The notification permission status could not be read.');
  }
  return {
    status: value.status,
    canAskAgain: value.canAskAgain,
    channelEnabled: value.channelEnabled,
  };
}

function createReminderCoordinator({ owner, store, notifications, now, newId, sampleMode }) {
  const ownerToken = encodeReminderOwner(owner);
  if (
    store?.ownerToken !== ownerToken ||
    typeof store.load !== 'function' ||
    typeof store.save !== 'function' ||
    typeof now !== 'function' ||
    typeof newId !== 'function' ||
    typeof sampleMode !== 'boolean' ||
    ![
      'ensureChannel',
      'getPermission',
      'requestPermission',
      'listScheduled',
      'schedule',
      'cancel',
    ].every((key) => typeof notifications?.[key] === 'function')
  ) {
    throw new Error(
      'Reminder coordination requires matching owner-bound storage and notification adapters.',
    );
  }

  let state = null;
  let loading = true;
  let loadError = null;
  let lastError = null;
  let uncertainStorage = false;
  let disposed = false;
  let accepting = true;
  let initialization = null;
  let permission = { status: 'unknown', canAskAgain: false, channelEnabled: null };
  const busy = new Set();
  const listeners = new Set();
  let snapshot;

  function publish() {
    if (disposed) return;
    const rows = new Map(
      (state?.reminders ?? []).map((record) => [
        record.id,
        {
          id: record.id,
          revision: record.revision,
          title: record.title,
          body: record.body,
          scheduledAtMs: record.scheduledAtMs,
          status: record.status === 'needs-attention' ? 'error' : record.status,
          pendingAction: null,
          pendingDraft: null,
          message:
            record.status === 'needs-attention'
              ? 'This future reminder is not confirmed as scheduled. Retry or delete it.'
              : null,
          canRetry: record.status === 'needs-attention' && !state.ownerPaused,
          canEdit: !state.ownerPaused,
          canDelete: true,
        },
      ]),
    );
    for (const operation of state?.operations ?? []) {
      if (operation.kind === 'notice') continue;
      const record =
        state.reminders.find((item) => item.id === operation.reminderId) ??
        operation.previous ??
        operation.proposed;
      if (!record) continue;
      rows.set(operation.reminderId, {
        id: record.id,
        revision: record.revision,
        title: record.title,
        body: record.body,
        scheduledAtMs: record.scheduledAtMs,
        status: operation.error
          ? 'error'
          : operation.kind === 'create'
            ? 'creating'
            : operation.kind === 'edit'
              ? 'editing'
              : 'deleting',
        pendingAction: operation.kind,
        pendingDraft: operation.proposed
          ? {
              title: operation.proposed.title,
              body: operation.proposed.body,
              scheduledAtMs: operation.proposed.scheduledAtMs,
            }
          : null,
        message: operation.error,
        canRetry: !state.ownerPaused || operation.kind === 'delete',
        canEdit: false,
        canDelete: operation.kind !== 'delete',
      });
    }
    snapshot = freeze({
      ownerToken,
      loading,
      loadError,
      lastError,
      ownerPaused: state?.ownerPaused ?? false,
      cleanupPending: state?.cleanupPending ?? false,
      permission: { ...permission },
      reminders: [...rows.values()].sort(
        (left, right) =>
          left.scheduledAtMs - right.scheduledAtMs || left.id.localeCompare(right.id),
      ),
      busyReminderIds: [...busy],
      automatic: { ...(state?.automatic ?? { budgets: false, goal: false, achievements: false }) },
      automaticNoticeErrors: (state?.automaticNoticeErrors ?? []).map((item) => ({ ...item })),
    });
    for (const listener of listeners) listener();
  }
  publish();

  // Read back a rejected write: it may have committed before its Promise rejected.
  async function persist(next) {
    const intended = clone(next);
    const hadState = state !== null;
    try {
      await store.save(intended);
      state = intended;
      uncertainStorage = false;
    } catch (error) {
      try {
        const actual = await store.load();
        if (actual !== null && JSON.stringify(actual) === JSON.stringify(intended)) {
          state = actual;
          uncertainStorage = false;
          publish();
          return;
        }
        if (actual !== null) state = actual;
        else if (hadState) {
          uncertainStorage = true;
          loadError =
            'Saved reminder data disappeared while confirming a write. Restore or reconcile it before making more changes.';
        }
      } catch {
        uncertainStorage = true;
        loadError =
          'Saved reminder state could not be confirmed. Retry reconciliation before making more changes.';
      }
      publish();
      throw new Error(
        uncertainStorage
          ? 'Storage outcome is uncertain. A pending operation may need recovery; no success was assumed.'
          : `Could not save reminder changes. ${message(error)}`,
      );
    }
    publish();
  }

  function operation(id) {
    return state.operations.find((item) => item.reminderId === id);
  }
  async function putOperation(next) {
    await persist({
      ...state,
      operations: [...state.operations.filter((item) => item.reminderId !== next.reminderId), next],
    });
  }
  async function forgetOperation(id) {
    await persist({
      ...state,
      operations: state.operations.filter((item) => item.reminderId !== id),
    });
  }
  function makeId(kind) {
    const id = newId(kind);
    if (!identifier(id)) throw new Error('The reminder identifier could not be created.');
    return id;
  }
  function requireReady(allowPaused = false) {
    if (!state || loadError || uncertainStorage)
      throw new Error('Open or reconcile saved reminders before changing them.');
    if (!allowPaused && (!accepting || state.ownerPaused))
      throw new Error('This wallet is paused for a context change.');
  }

  function enqueue(work, reminderId, allowPaused = false, recovery = false) {
    if (disposed)
      return Promise.resolve(
        result(false, 'This reminder context is no longer active.', false, reminderId),
      );
    const previousQueue = ownerQueues.get(ownerToken) ?? Promise.resolve();
    const run = previousQueue.then(async () => {
      if (disposed)
        return result(false, 'This reminder context is no longer active.', false, reminderId);
      try {
        if (!recovery) {
          requireReady(allowPaused);
          const current = await store.load();
          if (current === null)
            throw new Error('Saved reminder data is missing. Reopen reminders before changing it.');
          state = current;
          requireReady(allowPaused);
        }
        lastError = null;
        if (reminderId) busy.add(reminderId);
        publish();
        return await work();
      } catch (error) {
        lastError = message(error);
        const pending = uncertainStorage || Boolean(reminderId && state && operation(reminderId));
        publish();
        return result(false, lastError, pending, reminderId);
      } finally {
        if (reminderId) busy.delete(reminderId);
        publish();
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    ownerQueues.set(ownerToken, tail);
    void tail.then(() => {
      if (ownerQueues.get(ownerToken) === tail) ownerQueues.delete(ownerToken);
    });
    return run;
  }

  async function refreshPermission() {
    try {
      await notifications.ensureChannel();
      permission = validPermission(await notifications.getPermission());
    } catch (error) {
      permission = { status: 'unavailable', canAskAgain: false, channelEnabled: null };
      lastError = message(error);
    }
    publish();
    return permission.status === 'granted' && permission.channelEnabled !== false;
  }
  async function requirePermission() {
    if (!(await refreshPermission()))
      throw new Error(
        permission.channelEnabled === false
          ? 'This notification channel is disabled. Enable it in device settings, then retry.'
          : 'Notifications are not enabled. Use Enable notifications, then retry.',
      );
  }
  async function ownedRequests() {
    const requests = await notifications.listScheduled();
    if (!Array.isArray(requests))
      throw new Error('Scheduled notifications could not be inspected.');
    return requests.filter((request) => parseNotificationOwner(request)?.ownerToken === ownerToken);
  }
  function forReminder(requests, id) {
    return requests.filter((item) => item.data.reminderId === id);
  }
  function requestFor(op) {
    const notice = op.kind === 'notice' ? op.notice : null;
    const proposed = op.proposed;
    return {
      identifier: op.candidateIdentifier,
      title: notice?.title ?? proposed.title,
      body: notice?.body ?? proposed.body,
      scheduledAtMs: notice ? null : proposed.scheduledAtMs,
      data: {
        origin: ORIGIN,
        ownerToken,
        reminderId: op.reminderId,
        revision: proposed?.revision ?? 1,
        operationId: op.id,
        kind: notice?.kind ?? 'manual',
        ...(notice ? { eventKey: notice.key } : {}),
      },
    };
  }
  function candidateRequests(requests, op) {
    const request = requestFor(op);
    return forReminder(requests, op.reminderId).filter(
      (item) =>
        item.data.operationId === op.id &&
        item.data.revision === request.data.revision &&
        item.data.kind === request.data.kind &&
        item.title === request.title &&
        item.body === request.body &&
        item.scheduledAtMs === request.scheduledAtMs,
    );
  }

  async function cancelRequests(requests) {
    for (const request of requests) {
      try {
        await notifications.cancel(request.identifier);
      } catch (error) {
        const remaining = await ownedRequests();
        if (remaining.some((item) => item.identifier === request.identifier)) throw error;
      }
    }
    const remaining = await ownedRequests();
    if (
      requests.some((request) => remaining.some((item) => item.identifier === request.identifier))
    ) {
      throw new Error('A notification still appears scheduled. Cancellation needs another check.');
    }
  }

  async function ensureCandidate(op) {
    if (disposed || !accepting || state.ownerPaused)
      throw new Error('This reminder context is no longer scheduling new requests.');
    if (op.proposed) validateDraft(op.proposed, now());
    await requirePermission();
    let requests = await ownedRequests();
    let matches = candidateRequests(requests, op);
    const sameAttempt = forReminder(requests, op.reminderId).filter(
      (item) => item.data.operationId === op.id,
    );
    if (sameAttempt.length && !matches.length)
      throw new Error(
        'The pending notification differs from its saved intent. Delete it or retry reconciliation.',
      );
    if (!matches.length) {
      if (disposed || !accepting || state.ownerPaused)
        throw new Error('This reminder context is no longer active.');
      if (op.proposed) validateDraft(op.proposed, now());
      try {
        const nativeIdentifier = await notifications.schedule(requestFor(op));
        if (typeof nativeIdentifier !== 'string' || !nativeIdentifier.trim())
          throw new Error('Scheduling returned no notification identifier.');
        // Immediate notices may already be presented and absent from the pending list.
        if (op.kind === 'notice') return nativeIdentifier;
      } catch (error) {
        requests = await ownedRequests();
        matches = candidateRequests(requests, op);
        if (!matches.length)
          throw new Error(`Scheduling could not be confirmed. ${message(error)}`);
      }
      requests = await ownedRequests();
      matches = candidateRequests(requests, op);
      if (!matches.length)
        throw new Error(
          'The notification is not confirmed as pending. Its time may have passed; it will not be replayed automatically.',
        );
    }
    if (matches.length > 1) {
      op = {
        ...op,
        knownNativeIds: [
          ...new Set([...op.knownNativeIds, ...matches.map((item) => item.identifier)]),
        ],
      };
      await putOperation(op);
      await cancelRequests(matches.slice(1));
    }
    return matches[0].identifier;
  }

  async function markError(id, error) {
    const op = operation(id);
    if (op && !uncertainStorage) await putOperation({ ...op, error: message(error) });
  }
  async function commitCandidate(op, nativeIdentifier) {
    const record = {
      ...op.proposed,
      notificationId: nativeIdentifier,
      status: 'scheduled',
      enabled: true,
    };
    await persist({
      ...state,
      reminders: [...state.reminders.filter((item) => item.id !== op.reminderId), record],
      operations: state.operations.filter((item) => item.reminderId !== op.reminderId),
    });
  }
  async function rollbackEdit(op) {
    await putOperation({ ...op, stage: 'rollback' });
    const requests = forReminder(await ownedRequests(), op.reminderId);
    const candidates = requests.filter((item) => item.identifier !== op.previous.notificationId);
    await cancelRequests(candidates);
    let restored = { ...op.previous };
    const remaining = forReminder(await ownedRequests(), op.reminderId);
    const previousExists = remaining.some(
      (item) =>
        item.identifier === restored.notificationId &&
        item.data.revision === restored.revision &&
        item.title === restored.title &&
        item.body === restored.body &&
        item.scheduledAtMs === restored.scheduledAtMs,
    );
    if (
      !previousExists &&
      restored.scheduledAtMs > now() &&
      restored.enabled &&
      !state.ownerPaused
    ) {
      if (disposed || !accepting)
        throw new Error('The previous schedule still needs restoration in its paused context.');
      await requirePermission();
      const request = {
        identifier:
          restored.notificationId ??
          notificationIdentifier(ownerToken, restored.id, restored.revision),
        title: restored.title,
        body: restored.body,
        scheduledAtMs: restored.scheduledAtMs,
        data: {
          origin: ORIGIN,
          ownerToken,
          reminderId: restored.id,
          revision: restored.revision,
          operationId: op.id,
          kind: 'manual',
        },
      };
      try {
        await notifications.schedule(request);
      } catch (error) {
        if (
          !(await ownedRequests()).some(
            (item) =>
              item.identifier === request.identifier && item.data.reminderId === restored.id,
          )
        )
          throw error;
      }
      const confirmed = (await ownedRequests()).find(
        (item) =>
          item.identifier === request.identifier &&
          item.data.reminderId === restored.id &&
          item.data.revision === restored.revision,
      );
      if (!confirmed) throw new Error('Restoring the previous reminder could not be confirmed.');
      restored.notificationId = confirmed.identifier;
      restored.status = 'scheduled';
    } else if (!previousExists) {
      restored.notificationId = null;
      restored.status = restored.scheduledAtMs <= now() ? 'elapsed' : 'paused';
    }
    await persist({
      ...state,
      reminders: state.reminders.map((item) => (item.id === restored.id ? restored : item)),
    });
    await forgetOperation(op.reminderId);
  }

  async function runCreate(id) {
    let op = operation(id);
    try {
      const nativeIdentifier = await ensureCandidate(op);
      op = {
        ...operation(id),
        stage: 'candidate-scheduled',
        knownNativeIds: [...new Set([...operation(id).knownNativeIds, nativeIdentifier])],
      };
      await putOperation(op);
      await commitCandidate(op, nativeIdentifier);
      return result(true, 'Reminder scheduled on this device.', false, id);
    } catch (error) {
      await markError(id, error);
      return result(false, message(error), Boolean(operation(id)) || uncertainStorage, id);
    }
  }
  async function runEdit(id) {
    let op = operation(id);
    let switched = false;
    try {
      const nativeIdentifier = await ensureCandidate(op);
      op = {
        ...operation(id),
        stage: 'candidate-scheduled',
        knownNativeIds: [...new Set([...operation(id).knownNativeIds, nativeIdentifier])],
      };
      await putOperation(op);
      op = { ...op, stage: 'switching' };
      await putOperation(op);
      const old = forReminder(await ownedRequests(), id).filter(
        (item) => item.identifier !== nativeIdentifier,
      );
      await cancelRequests(old);
      switched = true;
      await commitCandidate(op, nativeIdentifier);
      return result(true, 'Reminder updated. The previous schedule was canceled.', false, id);
    } catch (error) {
      op = operation(id);
      if (switched) {
        await markError(
          id,
          new Error('The replacement is scheduled, but its saved confirmation needs recovery.'),
        );
        return result(
          false,
          'The native replacement is scheduled; saved confirmation is pending. Retry reconciliation.',
          true,
          id,
        );
      }
      if (op && !uncertainStorage) {
        try {
          await rollbackEdit(op);
        } catch (rollbackError) {
          await markError(id, new Error(`Edit outcome needs recovery. ${message(rollbackError)}`));
          return result(
            false,
            'The edit or its rollback is not fully confirmed. Retry reconciliation before changing it again.',
            true,
            id,
          );
        }
      }
      return result(
        false,
        uncertainStorage
          ? message(error)
          : `The edit failed; the previous reminder was retained. ${message(error)}`,
        uncertainStorage || Boolean(operation(id)),
        id,
      );
    }
  }
  async function runDelete(id) {
    try {
      const requests = forReminder(await ownedRequests(), id);
      await cancelRequests(requests);
      await persist({
        ...state,
        reminders: state.reminders.filter((item) => item.id !== id),
        operations: state.operations.filter((item) => item.reminderId !== id),
      });
      return result(true, 'Reminder deleted and its pending notifications canceled.', false, id);
    } catch (error) {
      await markError(id, error);
      return result(
        false,
        'Deletion is pending. Retry to finish cancellation; this reminder will not be recreated.',
        true,
        id,
      );
    }
  }

  async function finishPause() {
    const requests = await ownedRequests();
    await cancelRequests(requests);
    const deleting = new Set(
      state.operations.filter((item) => item.kind === 'delete').map((item) => item.reminderId),
    );
    const records = new Map(
      state.reminders.filter((item) => !deleting.has(item.id)).map((item) => [item.id, item]),
    );
    for (const op of state.operations)
      if (op.kind === 'create' && op.proposed) records.set(op.reminderId, op.proposed);
    await persist({
      ...state,
      cleanupPending: false,
      operations: [],
      reminders: [...records.values()].map((item) => ({
        ...item,
        status: item.scheduledAtMs <= now() ? 'elapsed' : 'paused',
        notificationId: null,
      })),
    });
  }

  async function reconcileInternal() {
    if (state.ownerPaused) {
      await finishPause();
      return;
    }
    for (const savedOp of [...state.operations]) {
      let op = operation(savedOp.reminderId);
      if (!op) continue;
      if (op.kind === 'delete') {
        const deleted = await runDelete(op.reminderId);
        if (!deleted.ok) throw new Error(deleted.message);
      } else if (op.kind === 'notice') {
        // An immediate event cannot be safely replayed after an interrupted attempt.
        await cancelRequests(forReminder(await ownedRequests(), op.reminderId));
        await persist({
          ...state,
          operations: state.operations.filter((item) => item.id !== op.id),
          automaticNoticeErrors: [
            ...state.automaticNoticeErrors.filter((item) => item.key !== op.notice.key),
            {
              key: op.notice.key,
              kind: op.notice.kind,
              message: 'An interrupted automatic notice was not replayed.',
            },
          ].slice(-100),
        });
      } else if (op.kind === 'edit') {
        const requests = forReminder(await ownedRequests(), op.reminderId);
        const candidate = candidateRequests(requests, op)[0];
        if (op.stage === 'switching' && candidate) {
          await cancelRequests(requests.filter((item) => item.identifier !== candidate.identifier));
          await commitCandidate(op, candidate.identifier);
        } else if (op.stage === 'switching' && op.proposed.scheduledAtMs <= now()) {
          // Replacement scheduling was confirmed before this durable stage.
          // Its time passing must not resurrect the superseded old reminder.
          await cancelRequests(requests);
          await persist({
            ...state,
            reminders: [
              ...state.reminders.filter((item) => item.id !== op.reminderId),
              { ...op.proposed, status: 'elapsed', notificationId: null },
            ],
            operations: state.operations.filter((item) => item.reminderId !== op.reminderId),
          });
        } else {
          await rollbackEdit(op);
        }
      } else {
        const candidate = candidateRequests(await ownedRequests(), op)[0];
        if (candidate) await commitCandidate(op, candidate.identifier);
        else
          await putOperation({
            ...op,
            error:
              op.proposed.scheduledAtMs <= now()
                ? 'The selected time has passed. This reminder was not replayed; delete it and choose another time.'
                : 'The pending reminder is not scheduled. Retry to schedule it or delete it.',
          });
      }
    }
    let requests = await ownedRequests();
    const currentOps = new Set(state.operations.map((item) => item.reminderId));
    const updated = state.reminders.map((record) => {
      if (currentOps.has(record.id)) return record;
      const match = requests.find(
        (item) =>
          item.identifier === record.notificationId &&
          item.data.reminderId === record.id &&
          item.data.revision === record.revision,
      );
      return {
        ...record,
        status: match ? 'scheduled' : record.scheduledAtMs <= now() ? 'elapsed' : 'needs-attention',
      };
    });
    if (JSON.stringify(updated) !== JSON.stringify(state.reminders))
      await persist({ ...state, reminders: updated });
    const allowedIds = new Set(state.reminders.map((item) => item.notificationId).filter(Boolean));
    const orphaned = requests.filter(
      (request) =>
        !allowedIds.has(request.identifier) &&
        !currentOps.has(request.data.reminderId) &&
        !(
          request.data.kind !== 'manual' && state.observedEventKeys.includes(request.data.eventKey)
        ),
    );
    if (orphaned.length) {
      await persist({ ...state, cleanupPending: true });
      await cancelRequests(orphaned);
    }
    if (state.cleanupPending) await persist({ ...state, cleanupPending: false });
  }

  function baseOperation(id, kind, previous, proposed) {
    const opId = makeId('operation');
    if (state.operations.some((item) => item.id === opId))
      throw new Error('This operation identifier is already in use. Retry.');
    return {
      id: opId,
      reminderId: id,
      kind,
      stage: kind === 'delete' ? 'deleting' : 'prepared',
      previous: previous ? clone(previous) : null,
      proposed: proposed ? clone(proposed) : null,
      candidateIdentifier: proposed
        ? notificationIdentifier(ownerToken, id, proposed.revision)
        : null,
      knownNativeIds: previous?.notificationId ? [previous.notificationId] : [],
      error: null,
    };
  }

  const api = {
    ownerToken,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function')
        throw new Error('A reminder subscriber must be a function.');
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize(baselineKeys) {
      if (initialization && !loadError && !uncertainStorage) return initialization;
      const keys = validateEventKeys(baselineKeys);
      initialization = enqueue(
        async () => {
          let loadedDurably = false;
          loading = true;
          loadError = null;
          publish();
          try {
            const hadState = state !== null;
            const loaded = await store.load();
            if (loaded === null && hadState)
              throw new Error(
                'Saved reminder data is missing. It was not replaced with an empty list.',
              );
            state = loaded;
            uncertainStorage = false;
            if (state === null) await persist(store.empty());
            loadedDurably = true;
            const union = validateEventKeys([
              ...state.observedEventKeys,
              ...(sampleMode ? [] : keys),
            ]);
            if (union.length !== state.observedEventKeys.length)
              await persist({ ...state, observedEventKeys: union });
            accepting = !state.ownerPaused;
            await refreshPermission();
            await reconcileInternal();
            return result(true, 'Saved reminders are ready.');
          } catch (error) {
            if (!loadedDurably || uncertainStorage) loadError = message(error);
            else lastError = message(error);
            return result(
              false,
              message(error),
              Boolean(state?.operations.length) || uncertainStorage,
            );
          } finally {
            loading = false;
            publish();
          }
        },
        undefined,
        true,
        true,
      );
      initialization.then((outcome) => {
        if (!outcome.ok) initialization = null;
      });
      return initialization;
    },
    create(draft) {
      const captured = clone(draft);
      return enqueue(async () => {
        const outstanding = state.operations.find((item) => item.kind === 'create');
        if (outstanding)
          return result(
            false,
            'Finish or delete the existing pending reminder before creating another.',
            true,
            outstanding.reminderId,
          );
        const values = validateDraft(captured, now());
        if (state.reminders.length >= MAX_MANUAL_REMINDERS)
          throw new Error('The limit of 100 manual reminders has been reached.');
        const id = makeId('reminder');
        if (state.reminders.some((item) => item.id === id) || operation(id))
          throw new Error('This reminder identifier is already in use. Retry.');
        const proposed = {
          id,
          revision: 1,
          ...values,
          enabled: true,
          notificationId: null,
          status: 'needs-attention',
        };
        const op = baseOperation(id, 'create', null, proposed);
        busy.add(id);
        publish();
        try {
          await putOperation(op);
          return await runCreate(id);
        } catch (error) {
          return result(false, message(error), Boolean(operation(id)) || uncertainStorage, id);
        } finally {
          busy.delete(id);
          publish();
        }
      });
    },
    edit(id, draft) {
      const captured = clone(draft);
      return enqueue(async () => {
        if (operation(id))
          return result(
            false,
            'Retry or delete the pending operation before editing this reminder again.',
            true,
            id,
          );
        const previous = state.reminders.find((item) => item.id === id);
        if (!previous) throw new Error('This reminder no longer exists.');
        const proposed = {
          ...previous,
          ...validateDraft(captured, now()),
          revision: previous.revision + 1,
          notificationId: null,
          status: 'needs-attention',
        };
        await putOperation(baseOperation(id, 'edit', previous, proposed));
        return runEdit(id);
      }, id);
    },
    remove(id) {
      return enqueue(
        async () => {
          const pending = operation(id);
          if (pending?.kind === 'delete') return runDelete(id);
          const previous =
            state.reminders.find((item) => item.id === id) ??
            pending?.previous ??
            pending?.proposed;
          if (!previous) throw new Error('This reminder no longer exists.');
          const op = baseOperation(id, 'delete', previous, null);
          op.knownNativeIds = [
            ...new Set([
              ...op.knownNativeIds,
              ...(pending?.knownNativeIds ?? []),
              ...(pending?.candidateIdentifier ? [pending.candidateIdentifier] : []),
            ]),
          ];
          await putOperation(op);
          return runDelete(id);
        },
        id,
        true,
      );
    },
    retry(id) {
      return enqueue(
        async () => {
          const op = operation(id);
          if (op?.kind === 'delete') return runDelete(id);
          if (op?.kind === 'create') {
            requireReady();
            return runCreate(id);
          }
          if (op?.kind === 'edit') {
            const intended = op.proposed;
            await reconcileInternal();
            if (operation(id))
              return result(false, 'The pending edit still needs recovery.', true, id);
            const current = state.reminders.find((item) => item.id === id);
            return current?.revision === intended.revision
              ? result(true, 'The reminder edit has been reconciled.', false, id)
              : result(
                  false,
                  'The previous reminder was restored. Review the new details and save again.',
                  false,
                  id,
                );
          }
          const previous = state.reminders.find((item) => item.id === id);
          if (!previous) throw new Error('This reminder no longer exists.');
          requireReady();
          validateDraft(previous, now());
          const proposed = {
            ...previous,
            revision: previous.revision + 1,
            notificationId: null,
            status: 'needs-attention',
          };
          await putOperation(baseOperation(id, 'edit', previous, proposed));
          return runEdit(id);
        },
        id,
        true,
      );
    },
    reconcile() {
      return enqueue(
        async () => {
          const loaded = await store.load();
          if (loaded === null)
            throw new Error('Saved reminder data is missing. Reopen reminders before changing it.');
          state = loaded;
          uncertainStorage = false;
          loadError = null;
          await refreshPermission();
          await reconcileInternal();
          return result(
            true,
            state.ownerPaused
              ? 'Old-wallet notifications are paused and canceled.'
              : 'Reminders reconciled.',
          );
        },
        undefined,
        true,
        true,
      );
    },
    requestPermission() {
      return enqueue(
        async () => {
          await notifications.ensureChannel();
          permission = validPermission(await notifications.requestPermission());
          publish();
          return permission.status === 'granted' && permission.channelEnabled !== false
            ? result(true, 'Local notifications are enabled.')
            : result(
                false,
                'Notifications remain disabled. Check device settings before retrying reminders.',
              );
        },
        undefined,
        true,
      );
    },
    setAutomaticPreferences(preferences, baselineKeys) {
      const next = validatePreferences(preferences);
      const keys = validateEventKeys(baselineKeys);
      return enqueue(async () => {
        await persist({
          ...state,
          automatic: next,
          observedEventKeys: validateEventKeys([
            ...state.observedEventKeys,
            ...(sampleMode ? [] : keys),
          ]),
        });
        return result(
          true,
          'Notification preferences saved. Historical milestones will not be announced.',
        );
      });
    },
    observeFinancialEvents(eventOwnerToken, events) {
      if (eventOwnerToken !== ownerToken)
        return Promise.resolve(result(false, 'Stale wallet notification events were ignored.'));
      const captured = events.map(validateNotice);
      return enqueue(async () => {
        if (sampleMode) return result(true, 'Sample milestones do not send notifications.');
        for (const notice of captured) {
          if (state.observedEventKeys.includes(notice.key)) continue;
          const enabled =
            state.automatic[
              notice.kind === 'budget'
                ? 'budgets'
                : notice.kind === 'achievement'
                  ? 'achievements'
                  : 'goal'
            ];
          const keys = validateEventKeys([...state.observedEventKeys, notice.key]);
          if (!enabled) {
            await persist({ ...state, observedEventKeys: keys });
            continue;
          }
          const id = makeId('reminder');
          const op = {
            ...baseOperation(id, 'notice', null, null),
            notice,
            candidateIdentifier: notificationIdentifier(ownerToken, id, 1),
          };
          await persist({
            ...state,
            observedEventKeys: keys,
            operations: [...state.operations, op],
          });
          try {
            await ensureCandidate(op);
            await forgetOperation(id);
          } catch (error) {
            if (uncertainStorage) throw error;
            await persist({
              ...state,
              operations: state.operations.filter((item) => item.reminderId !== id),
              automaticNoticeErrors: [
                ...state.automaticNoticeErrors.filter((item) => item.key !== notice.key),
                {
                  key: notice.key,
                  kind: notice.kind,
                  message: `Notice was not confirmed and will not be replayed automatically. ${message(error)}`,
                },
              ].slice(-100),
            });
          }
        }
        return result(true, 'Observed financial milestones recorded without changing the ledger.');
      });
    },
    quiesceAndCancelOwner() {
      accepting = false;
      return enqueue(
        async () => {
          await persist({ ...state, ownerPaused: true, cleanupPending: true });
          await finishPause();
          return result(true, 'This wallet is paused and its pending notifications are canceled.');
        },
        undefined,
        true,
      );
    },
    resumeOwner() {
      return enqueue(
        async () => {
          // A failed reset must not turn a durable deletion into a new schedule.
          // Finish cancel-only pause/deletion recovery before restoring definitions.
          if (state.ownerPaused) await finishPause();
          else {
            accepting = true;
            await reconcileInternal();
          }
          if (state.ownerPaused) await persist({ ...state, ownerPaused: false });
          accepting = true;
          for (const previous of [...state.reminders]) {
            if (
              operation(previous.id) ||
              !previous.enabled ||
              previous.scheduledAtMs <= now() ||
              previous.status === 'scheduled'
            )
              continue;
            const proposed = {
              ...previous,
              revision: previous.revision + 1,
              notificationId: null,
              status: 'needs-attention',
            };
            await putOperation(baseOperation(previous.id, 'edit', previous, proposed));
            const resumed = await runEdit(previous.id);
            if (!resumed.ok)
              return result(
                false,
                'The wallet was retained, but one or more reminders need repair.',
                resumed.pending,
                previous.id,
              );
          }
          if (state.operations.length)
            return result(false, 'Some reminder operations still need recovery.', true);
          return result(true, 'This wallet’s eligible future reminders are restored.');
        },
        undefined,
        true,
      );
    },
    dispose() {
      disposed = true;
      accepting = false;
      listeners.clear();
    },
  };
  return Object.freeze(api);
}

async function retireInactiveNotifications({
  scope,
  activeOwner,
  notifications,
  stillActive = () => true,
}) {
  const activeToken = encodeReminderOwner(activeOwner);
  if (!sameReminderScope(scope, activeOwner.scope))
    throw new Error('The retirement scope does not match the active wallet scope.');
  const retired = new Set();
  const failures = [];
  let canceledCount = 0;
  const active = () => {
    try {
      return stillActive() === true;
    } catch {
      return false;
    }
  };
  const interrupted = () => {
    failures.push({
      ownerToken: activeToken,
      identifier: '',
      message: 'The active wallet changed. Inactive-notification cleanup stopped.',
    });
    return { ok: false, canceledCount, retiredOwnerTokens: [...retired], failures };
  };
  if (!active()) return interrupted();
  const requests = await notifications.listScheduled();
  if (!Array.isArray(requests)) throw new Error('Scheduled notifications could not be inspected.');
  if (!active()) return interrupted();
  for (const request of requests) {
    const parsed = parseNotificationOwner(request);
    if (
      !parsed ||
      parsed.ownerToken === activeToken ||
      !sameReminderScope(parsed.owner.scope, scope)
    )
      continue;
    try {
      if (!active()) return interrupted();
      try {
        await notifications.cancel(request.identifier);
      } catch (error) {
        const remaining = await notifications.listScheduled();
        if (
          remaining.some(
            (item) =>
              item.identifier === request.identifier &&
              parseNotificationOwner(item)?.ownerToken === parsed.ownerToken,
          )
        )
          throw error;
      }
      const remaining = await notifications.listScheduled();
      if (
        remaining.some(
          (item) =>
            item.identifier === request.identifier &&
            parseNotificationOwner(item)?.ownerToken === parsed.ownerToken,
        )
      )
        throw new Error('The inactive notification is still pending.');
      canceledCount += 1;
      retired.add(parsed.ownerToken);
    } catch (error) {
      failures.push({
        ownerToken: parsed.ownerToken,
        identifier: request.identifier,
        message: message(error),
      });
    }
  }
  if (!active()) return interrupted();
  return { ok: failures.length === 0, canceledCount, retiredOwnerTokens: [...retired], failures };
}

module.exports = { ...storageTools, createReminderCoordinator, retireInactiveNotifications };

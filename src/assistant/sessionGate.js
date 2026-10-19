const { buildAssistantRequest, assessAnswer } = require('./grounding');
const { AssistantError } = require('./protocol');
const { assistantProvider, validateAssistantResponse } = require('./providerResponse');
const ASSISTANT_WAIT_MS = 125000;

// One in-memory UI session; no storage, financial mutation, or provider start code.
function createAssistantSession({
  actorKey,
  sessionKey,
  context,
  isCurrent,
  transport,
  expectedProvider,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  createAbort = () => new AbortController(),
}) {
  if (
    typeof actorKey !== 'string' ||
    !actorKey ||
    typeof sessionKey !== 'string' ||
    !sessionKey ||
    typeof isCurrent !== 'function' ||
    typeof transport !== 'function'
  )
    throw new Error('Open an active assistant session.');
  const provider = assistantProvider(expectedProvider);
  // Validate the context at construction; the fixed probe text is never sent.
  buildAssistantRequest(context, 'Explain the selected facts.');
  let active = null,
    generation = 0,
    closed = false;
  const current = () => !closed && isCurrent({ actorKey, sessionKey, context });
  function cancel() {
    generation += 1;
    if (active) {
      const pending = active;
      pending.settle({ status: 'cancelled' });
      pending.abort.abort();
    }
  }
  function ask(question, history = []) {
    if (!current()) return Promise.resolve({ status: 'stale', generation });
    if (active) return Promise.resolve({ status: 'busy', generation });
    let payload;
    try {
      payload = buildAssistantRequest(context, question, history);
    } catch {
      return Promise.resolve({ status: 'invalid-question', generation });
    }
    const requestGeneration = ++generation;
    return new Promise((resolve) => {
      let timer;
      const pending = {
        abort: createAbort(),
        settle(result) {
          if (active !== pending) return;
          active = null;
          clearTimer(timer);
          resolve({ ...result, generation: requestGeneration });
        },
      };
      active = pending;
      timer = setTimer(() => {
        pending.settle({ status: current() ? 'timeout' : 'stale' });
        pending.abort.abort();
      }, ASSISTANT_WAIT_MS);
      Promise.resolve()
        .then(() => {
          if (active !== pending || !current()) return null;
          return transport(payload, { signal: pending.abort.signal });
        })
        .then(
          (response) => {
            if (active !== pending) return;
            if (!current() || requestGeneration !== generation)
              return pending.settle({ status: 'stale' });
            try {
              validateAssistantResponse(response, provider, expectedProvider === undefined);
            } catch {
              return pending.settle({ status: 'invalid-provider-response' });
            }
            const assessed = assessAnswer(context, response.content);
            pending.settle(
              assessed.accepted
                ? { status: 'success', response: assessed }
                : { status: 'rejected', code: assessed.code },
            );
          },
          (error) => {
            pending.settle({
              status: current() ? 'unavailable' : 'stale',
              code: error instanceof AssistantError ? error.code : 'NETWORK',
            });
          },
        );
    });
  }
  return {
    ask,
    cancel,
    close() {
      closed = true;
      cancel();
    },
    isResultCurrent: (result) => current() && result.generation === generation,
    isBusy: () => active !== null,
  };
}

module.exports = { ASSISTANT_WAIT_MS, createAssistantSession };

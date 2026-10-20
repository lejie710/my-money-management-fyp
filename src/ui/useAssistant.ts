import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  buildAssistantContext,
  buildAssistantRequest,
  MAX_QUESTION_LENGTH,
  type AssistantContext,
} from '../assistant/grounding';
import { createAssistantSession, type AssistantResult } from '../assistant/sessionGate';
import type { SavedConversation } from '../assistant/conversations';
import { MESSAGES } from '../assistant/protocol';
import type { AssistantGroup, AssistantPanelProps, AssistantTurn } from './assistantUiTypes';

const noGroups = () => ({
  allDatesBalance: false,
  categories: false,
  budgets: false,
  goal: false,
  health: false,
  comparisons: false,
});
type SelectionState = {
  scope: object;
  startDate: string;
  endDate: string;
  startDraft: string;
  endDraft: string;
  include: ReturnType<typeof noGroups>;
  error: string;
};
type View = {
  key: object;
  question: string;
  message: string;
  busy: boolean;
  retryQuestion: string | null;
  turns: readonly AssistantTurn[];
};
const emptyView = (key: object): View => ({
  key,
  question: '',
  message: '',
  busy: false,
  retryQuestion: null,
  turns: [],
});
type Binding = {
  key: object;
  alive: boolean;
  gate: ReturnType<typeof createAssistantSession>;
};
function resultMessage(result: AssistantResult) {
  if (result.status === 'rejected' || result.status === 'invalid-provider-response')
    return MESSAGES.INVALID_MODEL_RESPONSE;
  if (result.status === 'timeout') return MESSAGES.TIMEOUT;
  if (result.status === 'busy') return MESSAGES.BUSY;
  if (result.status === 'invalid-question')
    return 'Enter a question of 1 to 500 characters and choose fewer details if needed.';
  if (result.code && Object.hasOwn(MESSAGES, result.code)) return MESSAGES[result.code];
  return MESSAGES.FAILED;
}

export function useAssistant({
  ledger,
  actorKey,
  sessionKey,
  initialRange,
  transport,
  provider,
  isCurrent,
  initialInclude,
  conversationStore,
}: AssistantPanelProps) {
  const scope = useMemo(
    () => ({}),
    [actorKey, sessionKey, initialRange.startDate, initialRange.endDate],
  );
  const initial = (): SelectionState => ({
    scope,
    ...initialRange,
    startDraft: initialRange.startDate,
    endDraft: initialRange.endDate,
    include: { ...noGroups(), ...initialInclude },
    error: '',
  });
  const [selection, setSelection] = useState<SelectionState>(initial);
  const effective = selection.scope === scope ? selection : initial();
  const prepared = useMemo<{
    context: AssistantContext | null;
    error: string;
    requestReady: boolean;
  }>(() => {
    try {
      const context = buildAssistantContext(ledger, {
        startDate: effective.startDate,
        endDate: effective.endDate,
        include: effective.include,
      });
      try {
        buildAssistantRequest(context, 'Explain the selected facts.');
        return { context, error: '', requestReady: true };
      } catch {
        return { context, error: MESSAGES.TOO_LARGE, requestReady: false };
      }
    } catch {
      return {
        context: null,
        error: 'Choose a valid inclusive date range from 1900-01-01 through 2100-12-31.',
        requestReady: false,
      };
    }
  }, [ledger, scope, effective.startDate, effective.endDate, effective.include]);
  const key = useMemo(() => ({}), [actorKey, sessionKey, prepared.context, transport, provider]);
  const latestKey = useRef(key);
  latestKey.current = key;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const binding = useRef<Binding | null>(null);
  const closedKey = useRef<object | null>(null);
  const [storedView, setView] = useState<View>(() => emptyView(key));
  const view = storedView.key === key ? storedView : emptyView(key);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [history, setHistory] = useState<{
    store: typeof conversationStore;
    records: SavedConversation[];
    loaded: boolean;
    error: string;
  }>(() => ({ store: conversationStore, records: [], loaded: !conversationStore, error: '' }));
  const currentHistory =
    history.store === conversationStore
      ? history
      : { store: conversationStore, records: [], loaded: !conversationStore, error: '' };
  const [archive, setArchive] = useState<{
    store: typeof conversationStore;
    record: SavedConversation;
  } | null>(null);
  const archivedConversation =
    archive?.store === conversationStore ? (archive?.record ?? null) : null;
  const latestStore = useRef(conversationStore);
  latestStore.current = conversationStore;
  const conversationRef = useRef<{
    key: object;
    id: string;
    createdAt: number;
    expectedUpdatedAt: number | null;
  } | null>(null);
  const historySequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const panelCurrent = () =>
    mounted.current &&
    latestKey.current === key &&
    latestStore.current === conversationStore &&
    closedKey.current !== key &&
    (isCurrent?.() ?? true);
  const refreshHistory = async () => {
    const store = conversationStore;
    if (!store || !panelCurrent()) return;
    const sequence = ++historySequence.current;
    try {
      const records = await store.load();
      const pending = conversationRef.current;
      const saved = pending && records.find((row) => row.id === pending.id);
      const visible = viewRef.current.turns.map((turn) => ({
        question: turn.question,
        answer: turn.answer,
        factIds: turn.facts.map((fact) => fact.id),
      }));
      if (
        saved &&
        JSON.stringify(saved.turns) === JSON.stringify(visible) &&
        pending === conversationRef.current &&
        latestStore.current === store
      )
        pending.expectedUpdatedAt = saved.updatedAt;
      if (mounted.current && latestStore.current === store && sequence === historySequence.current)
        setHistory({ store, records, loaded: true, error: '' });
    } catch {
      if (mounted.current && latestStore.current === store && sequence === historySequence.current)
        setHistory({
          store,
          records: [],
          loaded: false,
          error:
            'Saved conversations could not be opened. Existing history is retained. Retry before saving new conversations.',
        });
    }
  };
  useEffect(() => {
    setArchive(null);
    setHistory({ store: conversationStore, records: [], loaded: !conversationStore, error: '' });
    void refreshHistory();
  }, [conversationStore]);
  const persistTurns = async (turns: readonly AssistantTurn[], context: AssistantContext) => {
    const store = conversationStore;
    if (!store || !turns.length || !current(binding.current) || !mounted.current) return;
    if (!currentHistory.loaded || latestStore.current !== store) {
      setHistory((old) => ({
        ...old,
        error:
          'This answer is visible but not saved. Reopen history before saving the conversation.',
      }));
      return;
    }
    const now = Date.now();
    if (conversationRef.current?.key !== key)
      conversationRef.current = {
        key,
        id: 'chat-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 10),
        createdAt: now,
        expectedUpdatedAt: null,
      };
    const id = conversationRef.current;
    const record: SavedConversation = {
      id: id.id,
      createdAt: id.createdAt,
      updatedAt: Math.max(now, id.createdAt, (id.expectedUpdatedAt ?? -1) + 1),
      walletId: ledger.wallet.incarnationId,
      walletName: ledger.wallet.name,
      provider: {
        engine: provider?.engine ?? 'lemonade',
        processing: provider?.processing ?? 'local',
        model: provider?.model ?? 'Qwen3-4B-Instruct-2507-GGUF',
      },
      context,
      turns: turns.slice(-12).map((turn) => ({
        question: turn.question,
        answer: turn.answer,
        factIds: turn.facts.map((fact) => fact.id),
      })),
    };
    const sequence = ++historySequence.current;
    try {
      const records = await store.save(record, id.expectedUpdatedAt);
      if (conversationRef.current === id) id.expectedUpdatedAt = record.updatedAt;
      if (mounted.current && latestStore.current === store && sequence === historySequence.current)
        setHistory({ store, records, loaded: true, error: '' });
    } catch {
      if (mounted.current && latestStore.current === store && sequence === historySequence.current)
        setHistory((old) => ({
          ...old,
          error:
            'This conversation was not confirmed saved. Retry saving, or delete an older conversation if history is full.',
        }));
    }
  };
  const currentContextMatchesArchive =
    !!archivedConversation &&
    !!prepared.context &&
    archivedConversation.walletId === ledger.wallet.incarnationId &&
    JSON.stringify(archivedConversation.context) === JSON.stringify(prepared.context) &&
    archivedConversation.provider.engine === (provider?.engine ?? 'lemonade') &&
    archivedConversation.provider.model === (provider?.model ?? 'Qwen3-4B-Instruct-2507-GGUF');
  const continueSaved = () => {
    if (
      !panelCurrent() ||
      !currentContextMatchesArchive ||
      !archivedConversation ||
      !prepared.context
    )
      return false;
    const entry = binding.current;
    if (current(entry)) entry.gate.cancel();
    conversationRef.current = {
      key,
      id: archivedConversation.id,
      createdAt: archivedConversation.createdAt,
      expectedUpdatedAt: archivedConversation.updatedAt,
    };
    const context = prepared.context;
    setView({
      ...emptyView(key),
      turns: archivedConversation.turns.map((turn) => ({
        question: turn.question,
        answer: turn.answer,
        context,
        facts: context.facts.filter((fact) => turn.factIds.includes(fact.id)),
      })),
    });
    setArchive(null);
    return true;
  };
  const deleteSaved = async (id: string) => {
    const store = conversationStore;
    if (
      !store ||
      !mounted.current ||
      closedKey.current === key ||
      latestKey.current !== key ||
      !(isCurrent?.() ?? true)
    )
      return;
    const sequence = ++historySequence.current;
    try {
      const records = await store.remove(id);
      if (
        mounted.current &&
        latestStore.current === store &&
        sequence === historySequence.current
      ) {
        setHistory({ store, records, loaded: true, error: '' });
        if (archive?.record.id === id) setArchive(null);
        if (conversationRef.current?.id === id) {
          conversationRef.current = null;
          const entry = binding.current;
          if (current(entry)) entry.gate.cancel();
          setView(emptyView(key));
        }
      }
    } catch {
      if (mounted.current && latestStore.current === store && sequence === historySequence.current)
        setHistory((old) => ({
          ...old,
          error:
            'Deleting the conversation could not be confirmed. Reopen history before retrying.',
        }));
    }
  };

  useLayoutEffect(() => {
    if (selection.scope !== scope) setSelection(initial());
  }, [scope]);
  useLayoutEffect(() => {
    setView(emptyView(key));
    const context = prepared.context;
    if (!context || !prepared.requestReady || !transport || !actorKey || !sessionKey) {
      binding.current = null;
      return;
    }
    const entry = {} as Binding;
    entry.key = key;
    entry.alive = true;
    entry.gate = createAssistantSession({
      actorKey,
      sessionKey,
      context,
      transport,
      expectedProvider: provider,
      isCurrent: (identity) =>
        entry.alive &&
        binding.current === entry &&
        latestKey.current === key &&
        identity.actorKey === actorKey &&
        identity.sessionKey === sessionKey &&
        identity.context === context &&
        (isCurrent?.() ?? true),
    });
    binding.current = entry;
    return () => {
      entry.alive = false;
      entry.gate.close();
      if (binding.current === entry) binding.current = null;
    };
  }, [key]);

  const current = (entry: Binding | null): entry is Binding =>
    !!entry &&
    entry.alive &&
    closedKey.current !== key &&
    binding.current === entry &&
    entry.key === key &&
    latestKey.current === key &&
    (isCurrent?.() ?? true);
  const updateView = (update: (old: View) => View) => {
    if (latestKey.current !== key || !(isCurrent?.() ?? true)) return;
    setView((old) => update(old.key === key ? old : emptyView(key)));
  };
  const setQuestion = useCallback(
    (question: string) => {
      if (
        latestKey.current !== key ||
        !(isCurrent?.() ?? true) ||
        (!binding.current?.alive && transport)
      )
        return;
      updateView((old) => ({ ...old, question: question.slice(0, MAX_QUESTION_LENGTH) }));
    },
    [key],
  );
  const changeDate = (field: 'startDraft' | 'endDraft', value: string) => {
    if (latestKey.current !== key || latestScope.current !== scope || !(isCurrent?.() ?? true))
      return;
    setSelection((old) => ({
      ...(old.scope === scope ? old : initial()),
      [field]: value.slice(0, 10),
    }));
  };
  const applyRange = () => {
    if (latestKey.current !== key || latestScope.current !== scope || !(isCurrent?.() ?? true))
      return false;
    try {
      buildAssistantContext(ledger, {
        startDate: effective.startDraft,
        endDate: effective.endDraft,
        include: effective.include,
      });
      setSelection({
        ...effective,
        startDate: effective.startDraft,
        endDate: effective.endDraft,
        error: '',
      });
      return true;
    } catch {
      setSelection({
        ...effective,
        error:
          'Enter real YYYY-MM-DD dates in order, within 1900-01-01 through 2100-12-31. The applied facts are unchanged.',
      });
      return false;
    }
  };
  const toggleGroup = (group: AssistantGroup) => {
    if (latestKey.current !== key || latestScope.current !== scope || !(isCurrent?.() ?? true))
      return;
    setSelection((old) => {
      const actual = old.scope === scope ? old : initial();
      return { ...actual, include: { ...actual.include, [group]: !actual.include[group] } };
    });
  };
  const perform = async (question: string) => {
    const entry = binding.current,
      context = prepared.context;
    if (
      !current(entry) ||
      !context ||
      archivedConversation ||
      (conversationStore && !currentHistory.loaded)
    )
      return false;
    if (entry.gate.isBusy()) return false;
    if (!question.trim() || question.trim().length > MAX_QUESTION_LENGTH) {
      updateView((old) => ({ ...old, message: 'Enter a question of 1 to 500 characters.' }));
      return false;
    }
    const previousTurns = viewRef.current.turns
      .slice(-3)
      .map(({ question, answer }) => ({ question, answer }));
    try {
      buildAssistantRequest(context, question, previousTurns);
    } catch {
      updateView((old) => ({ ...old, message: MESSAGES.TOO_LARGE }));
      return false;
    }
    updateView((old) => ({ ...old, busy: true, message: '', retryQuestion: question.trim() }));
    const result = await entry.gate.ask(question, previousTurns);
    if (!current(entry) || !entry.gate.isResultCurrent(result)) return false;
    if (result.status === 'success') {
      const turn: AssistantTurn = {
        question: question.trim(),
        answer: result.response.answer,
        context,
        facts: context.facts.filter((fact) => result.response.factIds.includes(fact.id)),
      };
      const turns = [...viewRef.current.turns, turn].slice(-12);
      updateView((old) => ({
        ...old,
        busy: false,
        retryQuestion: null,
        message: '',
        turns,
      }));
      await persistTurns(turns, context);
      return true;
    }
    updateView((old) => ({ ...old, busy: false, message: resultMessage(result) }));
    return false;
  };
  const cancel = () => {
    const entry = binding.current;
    if (!current(entry)) return;
    entry.gate.cancel();
    updateView((old) => ({
      ...old,
      busy: false,
      message:
        provider?.processing === 'cloud'
          ? 'Explanation cancelled. OpenAI may already have processed the request; cancellation does not guarantee charges are avoided. No result will be added.'
          : 'Explanation cancelled. The Windows model may still be finishing; no result will be added.',
    }));
  };
  const clear = () => {
    if (latestKey.current !== key || !(isCurrent?.() ?? true)) return;
    const entry = binding.current;
    if (current(entry)) entry.gate.cancel();
    conversationRef.current = null;
    setArchive(null);
    setView(emptyView(key));
  };
  const close = () => {
    if (latestKey.current !== key) return;
    const entry = binding.current;
    const live = current(entry);
    closedKey.current = key;
    if (!live || !entry) return;
    entry.alive = false;
    entry.gate.close();
  };
  return {
    ...view,
    history: currentHistory.records,
    historyLoaded: currentHistory.loaded,
    historyError: currentHistory.error,
    historyEnabled: !!conversationStore,
    archivedConversation,
    canContinueSaved: currentContextMatchesArchive && !!transport,
    refreshHistory,
    saveConversation: () =>
      prepared.context ? persistTurns(viewRef.current.turns, prepared.context) : Promise.resolve(),
    openSaved: (id: string) => {
      if (!panelCurrent()) return;
      const record = currentHistory.records.find((row) => row.id === id);
      if (record) {
        const entry = binding.current;
        if (current(entry)) entry.gate.cancel();
        updateView((old) => ({ ...old, busy: false }));
        setArchive({ store: conversationStore, record });
      }
    },
    closeSaved: () => {
      if (panelCurrent()) setArchive(null);
    },
    continueSaved,
    deleteSaved,
    context: prepared.context,
    contextError: prepared.error,
    selectionError: effective.error,
    startDraft: effective.startDraft,
    endDraft: effective.endDraft,
    include: effective.include,
    hasUnappliedDates:
      effective.startDraft !== effective.startDate || effective.endDraft !== effective.endDate,
    configured: !!transport,
    canAsk:
      !!transport &&
      prepared.requestReady &&
      !!actorKey &&
      !!sessionKey &&
      !archivedConversation &&
      (!conversationStore || currentHistory.loaded),
    setQuestion,
    setStartDraft: (value: string) => changeDate('startDraft', value),
    setEndDraft: (value: string) => changeDate('endDraft', value),
    applyRange,
    toggleGroup,
    ask: () => perform(viewRef.current.question),
    retry: () =>
      viewRef.current.retryQuestion
        ? perform(viewRef.current.retryQuestion)
        : Promise.resolve(false),
    cancel,
    clear,
    close,
  };
}

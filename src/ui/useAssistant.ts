import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  buildAssistantContext,
  buildAssistantRequest,
  MAX_QUESTION_LENGTH,
  type AssistantContext,
} from '../assistant/grounding';
import { createAssistantSession, type AssistantResult } from '../assistant/sessionGate';
import { MESSAGES } from '../assistant/protocol';
import type { AssistantGroup, AssistantPanelProps, AssistantTurn } from './assistantUiTypes';

const noGroups = () => ({
  allDatesBalance: false,
  categories: false,
  budgets: false,
  goal: false,
  health: false,
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
  isCurrent,
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
    include: noGroups(),
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
  const key = useMemo(() => ({}), [actorKey, sessionKey, prepared.context, transport]);
  const latestKey = useRef(key);
  latestKey.current = key;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const binding = useRef<Binding | null>(null);
  const [storedView, setView] = useState<View>(() => emptyView(key));
  const view = storedView.key === key ? storedView : emptyView(key);
  const viewRef = useRef(view);
  viewRef.current = view;

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
    if (!current(entry) || !context) return false;
    if (entry.gate.isBusy()) return false;
    if (!question.trim() || question.trim().length > MAX_QUESTION_LENGTH) {
      updateView((old) => ({ ...old, message: 'Enter a question of 1 to 500 characters.' }));
      return false;
    }
    try {
      buildAssistantRequest(context, question);
    } catch {
      updateView((old) => ({ ...old, message: MESSAGES.TOO_LARGE }));
      return false;
    }
    updateView((old) => ({ ...old, busy: true, message: '', retryQuestion: question.trim() }));
    const result = await entry.gate.ask(question);
    if (!current(entry) || !entry.gate.isResultCurrent(result)) return false;
    if (result.status === 'success') {
      const turn: AssistantTurn = {
        question: question.trim(),
        answer: result.response.answer,
        context,
        facts: context.facts.filter((fact) => result.response.factIds.includes(fact.id)),
      };
      updateView((old) => ({
        ...old,
        busy: false,
        retryQuestion: null,
        message: '',
        turns: [...old.turns, turn].slice(-3),
      }));
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
        'Explanation cancelled. The Windows model may still be finishing; no result will be added.',
    }));
  };
  const clear = () => {
    if (latestKey.current !== key || !(isCurrent?.() ?? true)) return;
    const entry = binding.current;
    if (current(entry)) entry.gate.cancel();
    setView(emptyView(key));
  };
  const close = () => {
    const entry = binding.current;
    if (!current(entry)) return;
    entry.alive = false;
    entry.gate.close();
  };
  return {
    ...view,
    context: prepared.context,
    contextError: prepared.error,
    selectionError: effective.error,
    startDraft: effective.startDraft,
    endDraft: effective.endDraft,
    include: effective.include,
    hasUnappliedDates:
      effective.startDraft !== effective.startDate || effective.endDraft !== effective.endDate,
    configured: !!transport,
    canAsk: !!transport && prepared.requestReady && !!actorKey && !!sessionKey,
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

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createConversationStore, type ConversationStorage } from '../assistant/conversations';
import { encodeDataFamily } from '../accounts/identity';
import type { Ledger } from '../core/model';
import { periodReport } from '../core/reports';
import type { ReminderOwner } from '../reminders/coordinator';
import { encodeReminderOwner } from '../reminders/store';
import { AssistantError } from '../assistant/client';
import type { AssistantPanelProps, AssistantTransport } from './assistantUiTypes';
import type { useCompanionConnection } from './useCompanionConnection';

type Range = { startDate: string; endDate: string };
type Session = {
  epoch: object;
  actorKey: string;
  sessionKey: string;
  initialRange: Range;
  transport?: AssistantTransport;
  provider?: AssistantPanelProps['provider'];
  requests: Set<AbortController>;
  connectionCurrent: () => boolean;
};
let serial = 0;

/** A read-only transient panel. It has no financial save, storage, or identity mutation power. */
export function useAssistantSession({
  ledger,
  owner,
  active,
  connection,
  historyStorage,
}: {
  ledger: Ledger | null;
  owner: ReminderOwner | null;
  active: boolean;
  connection: ReturnType<typeof useCompanionConnection>;
  historyStorage?: ConversationStorage;
}) {
  const historyOwnerKey = owner
    ? encodeDataFamily({ scope: owner.scope, actor: owner.actor })
    : null;
  const conversationStore = useMemo(
    () =>
      historyStorage && historyOwnerKey
        ? createConversationStore(historyStorage, historyOwnerKey)
        : undefined,
    [historyStorage, historyOwnerKey],
  );
  const actorKey = owner ? encodeReminderOwner(owner) : null;
  const epoch = useMemo(() => ({}), [actorKey, active, connection.revision, connection.binding]);
  const latest = useRef({ ledger, actorKey, active, epoch, connection });
  latest.current = { ledger, actorKey, active, epoch, connection };
  const mounted = useRef(false),
    current = useRef<Session | null>(null);
  const [stored, setStored] = useState<Session | null>(null),
    [error, setError] = useState<{ epoch: object; message: string } | null>(null);
  const currentSession = (session: Session) =>
    mounted.current &&
    current.current === session &&
    latest.current.active &&
    latest.current.actorKey === session.actorKey &&
    latest.current.epoch === session.epoch;
  const retire = (session: Session) => {
    for (const request of session.requests) request.abort();
    session.requests.clear();
  };
  const close = (expected?: Session) => {
    const session = current.current;
    if (expected && expected !== session) return;
    current.current = null;
    setStored(null);
    if (session) retire(session);
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const session = current.current;
      current.current = null;
      if (session) retire(session);
    };
  }, []);
  useLayoutEffect(() => {
    if (current.current?.epoch !== epoch) close();
    setError(null);
  }, [epoch]);
  const open = (range: Range) => {
    const live = latest.current;
    if (
      !mounted.current ||
      !active ||
      !ledger ||
      !actorKey ||
      live.epoch !== epoch ||
      live.ledger !== ledger
    )
      return;
    const configured = connection.getCurrent();
    if (configured.phase === 'checking') return;
    try {
      periodReport(ledger, range.startDate, range.endDate);
      const session: Session = {
        epoch,
        actorKey,
        sessionKey: JSON.stringify([actorKey, `assistant-${Date.now().toString(36)}-${++serial}`]),
        initialRange: Object.freeze({ ...range }),
        requests: new Set(),
        provider: configured.binding?.providers?.assistant ?? undefined,
        connectionCurrent: () =>
          connection.getCurrent().binding === configured.binding &&
          connection.getCurrent().revision === configured.revision,
      };
      const transport = configured.binding?.assistant;
      if (transport)
        session.transport = async (payload, options) => {
          const requestLedger = latest.current.ledger;
          const isCurrent = () =>
            currentSession(session) &&
            latest.current.ledger === requestLedger &&
            connection.getCurrent().binding === configured.binding &&
            connection.getCurrent().revision === configured.revision;
          if (!isCurrent() || options.signal.aborted) throw new AssistantError('CANCELLED');
          const controller = new AbortController(),
            abort = () => controller.abort();
          session.requests.add(controller);
          options.signal.addEventListener('abort', abort, { once: true });
          try {
            const result = await transport(payload, { signal: controller.signal });
            if (controller.signal.aborted || !isCurrent()) throw new AssistantError('CANCELLED');
            return result;
          } finally {
            options.signal.removeEventListener('abort', abort);
            session.requests.delete(controller);
          }
        };
      close();
      current.current = session;
      setStored(session);
      setError(null);
    } catch {
      setError({
        epoch,
        message: 'Choose a valid applied report period before opening the assistant.',
      });
    }
  };
  const session = stored && currentSession(stored) ? stored : null;
  const panel: AssistantPanelProps | null =
    session && ledger
      ? {
          ledger,
          actorKey: session.actorKey,
          sessionKey: session.sessionKey,
          initialRange: session.initialRange,
          initialInclude:
            session.provider?.engine === 'lemonade'
              ? { categories: true }
              : { categories: true, budgets: true, goal: true, comparisons: true },
          conversationStore,
          transport: session.transport,
          provider: session.provider,
          isCurrent: () =>
            currentSession(session) &&
            latest.current.ledger === ledger &&
            session.connectionCurrent(),
        }
      : null;
  return {
    panel,
    open,
    close: () => close(),
    closeCurrent: () => {
      if (session) close(session);
    },
    error: error?.epoch === epoch ? error.message : '',
  };
}

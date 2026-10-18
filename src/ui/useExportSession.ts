import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Ledger } from '../core/model';
import {
  captureTransactionExportSource,
  createReportExportSnapshot,
  type ReportExportSnapshot,
  type TransactionExportSource,
} from '../core/exports';
import type { PhotoManager } from '../attachments/photoManager';
import type { ReminderOwner } from '../reminders/coordinator';
import { encodeReminderOwner } from '../reminders/store';
import { createExpoPdfServices } from '../exports/expoPdfAdapter';
import type { PdfController } from '../exports/pdfController';

type ExportSession = {
  ownerToken: string;
  sessionKey: string;
  binding: object;
  controller: PdfController;
} & (
  | { kind: 'report'; snapshot: ReportExportSnapshot }
  | { kind: 'transaction'; source: TransactionExportSource }
);
const newExportId = () =>
  `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function useExportSession({
  ledger,
  owner,
  active,
  photos,
}: {
  ledger: Ledger | null;
  owner: ReminderOwner | null;
  active: boolean;
  photos?: PhotoManager;
}) {
  const ownerToken = owner ? encodeReminderOwner(owner) : null;
  const binding = useMemo(() => ({}), [active, ownerToken, photos]);
  const latest = useRef({ ledger, ownerToken, photos, active, binding });
  latest.current = { ledger, ownerToken, photos, active, binding };
  const mounted = useRef(false);
  const currentSession = useRef<ExportSession | null>(null);
  const [storedSession, setSession] = useState<ExportSession | null>(null);
  const [failure, setFailure] = useState<{ binding: object; message: string } | null>(null);
  const closeSession = (expected?: ExportSession) => {
    const current = currentSession.current;
    if (expected && expected !== current) return;
    currentSession.current = null;
    current?.controller.close();
    setSession(null);
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      currentSession.current?.controller.close();
      currentSession.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (currentSession.current?.binding !== binding) closeSession();
    setFailure(null);
  }, [binding]);
  const open = (
    content: () =>
      | Pick<Extract<ExportSession, { kind: 'report' }>, 'kind' | 'snapshot'>
      | Pick<Extract<ExportSession, { kind: 'transaction' }>, 'kind' | 'source'>,
  ) => {
    if (
      !mounted.current ||
      !active ||
      !ledger ||
      !owner ||
      !ownerToken ||
      latest.current.binding !== binding ||
      latest.current.ledger !== ledger
    )
      return;
    if (!photos) {
      setFailure({
        binding,
        message: 'Photo storage is still opening. Try export again in a moment.',
      });
      return;
    }
    try {
      const captured = content();
      const id = newExportId();
      let next: ExportSession;
      const controller = createExpoPdfServices({
        owner,
        storage: AsyncStorage,
        photos,
        now: Date.now,
        newId: newExportId,
        isCurrent: () =>
          mounted.current &&
          latest.current.active &&
          latest.current.binding === binding &&
          latest.current.ownerToken === ownerToken &&
          currentSession.current === next,
      });
      next = {
        ...captured,
        ownerToken,
        binding,
        sessionKey: JSON.stringify([ownerToken, id]),
        controller,
      };
      closeSession();
      currentSession.current = next;
      setSession(next);
      setFailure(null);
    } catch {
      setFailure({
        binding,
        message:
          'This export could not be opened from the current saved records. Reopen it and try again.',
      });
    }
  };
  const session =
    active && storedSession?.binding === binding && currentSession.current === storedSession
      ? storedSession
      : null;
  return {
    session,
    error: failure?.binding === binding ? failure.message : '',
    openReport: (range: { startDate: string; endDate: string }) =>
      open(() => ({
        kind: 'report',
        snapshot: createReportExportSnapshot(ledger!, range.startDate, range.endDate, Date.now()),
      })),
    openTransaction: (transactionId: string) =>
      open(() => ({
        kind: 'transaction',
        source: captureTransactionExportSource(ledger!, transactionId, Date.now()),
      })),
    close: () => closeSession(),
    closeCurrent: () => {
      if (session) closeSession(session);
    },
    clearError: () => {
      if (latest.current.binding === binding) setFailure(null);
    },
  };
}

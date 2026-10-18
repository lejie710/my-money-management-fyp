import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Ledger } from '../core/model';
import type { ReminderOwner } from '../reminders/coordinator';
import { encodeReminderOwner } from '../reminders/store';
import type { PhotoManager } from '../attachments/photoManager';
import { createExpoReceiptCapture } from '../receipts/expoCapture';
import { receiptCaptureFamilyToken, type ReceiptCaptureManager } from '../receipts/captureManager';
import type { ReceiptUiBinding } from './receiptUiTypes';
import type { useCompanionConnection } from './useCompanionConnection';

declare const process: { env: { EXPO_PUBLIC_RECEIPT_CAMERA_ENABLED?: string } };
export const receiptCameraEnabled = process.env.EXPO_PUBLIC_RECEIPT_CAMERA_ENABLED === '1';
const retired = new Map<string, Set<ReceiptCaptureManager>>();
let sequence = 0;
const newId = () =>
  `receipt-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
type Session = {
  ownerToken: string;
  familyToken: string;
  sessionKey: string;
  capture: ReceiptCaptureManager;
  binding: ReceiptUiBinding;
  epoch: object;
  closeDraft: (() => Promise<void>) | null;
  closing: Promise<void> | null;
};
type Props = {
  ledger: Ledger | null;
  owner: ReminderOwner | null;
  active: boolean;
  visible: boolean;
  photos?: PhotoManager;
  connection: ReturnType<typeof useCompanionConnection>;
  getToday(): string;
  onPhotoCleanupMessage(ownerToken: string, message: string): void;
  cameraEnabled?: boolean;
};

export function useReceiptSession({
  ledger,
  owner,
  active,
  visible,
  photos,
  connection,
  getToday,
  onPhotoCleanupMessage,
  cameraEnabled = receiptCameraEnabled,
}: Props) {
  const ownerToken = owner ? encodeReminderOwner(owner) : null;
  const familyToken = owner ? receiptCaptureFamilyToken(owner) : null;
  const epoch = useMemo(
    () => ({}),
    [active, ownerToken, photos, connection.revision, connection.binding, cameraEnabled],
  );
  const latest = useRef({
    ledger,
    owner,
    ownerToken,
    familyToken,
    active,
    visible,
    epoch,
    connection,
    getToday,
    onPhotoCleanupMessage,
  });
  latest.current = {
    ledger,
    owner,
    ownerToken,
    familyToken,
    active,
    visible,
    epoch,
    connection,
    getToday,
    onPhotoCleanupMessage,
  };
  const mounted = useRef(false),
    current = useRef<Session | null>(null);
  const [stored, setStored] = useState<Session | null>(null);
  const [error, setError] = useState<{ epoch: object; message: string } | null>(null);
  const [cleanup, setCleanup] = useState<{
    familyToken: string;
    pending: boolean;
    message: string;
  } | null>(null);
  const isCurrent = (session: Session) =>
    mounted.current &&
    current.current === session &&
    latest.current.active &&
    latest.current.visible &&
    latest.current.epoch === session.epoch &&
    latest.current.ownerToken === session.ownerToken;
  const register = (manager: ReceiptCaptureManager) => {
    if (!retired.has(manager.familyToken)) retired.set(manager.familyToken, new Set());
    retired.get(manager.familyToken)!.add(manager);
  };
  const report = (family: string, pending: boolean) => {
    const unresolved = pending || !!retired.get(family)?.size;
    if (mounted.current && latest.current.familyToken === family)
      setCleanup({
        familyToken: family,
        pending: unresolved,
        message: unresolved ? 'Temporary receipt image cleanup needs another check.' : '',
      });
  };
  const checkManager = async (manager: ReceiptCaptureManager) => {
    try {
      const result = await manager.retryCleanup();
      if (!result.pending) {
        retired.get(manager.familyToken)?.delete(manager);
        if (!retired.get(manager.familyToken)?.size) retired.delete(manager.familyToken);
      }
      return result.pending;
    } catch {
      return true;
    }
  };
  const finish = (session: Session) => {
    if (session.closing) return session.closing;
    register(session.capture);
    let released: Promise<void>;
    try {
      released = session.closeDraft?.() ?? Promise.resolve();
    } catch {
      released = Promise.resolve();
    }
    let closed: Promise<unknown>;
    try {
      closed = session.capture.close().catch(() => null);
    } catch {
      closed = Promise.resolve(null);
    }
    session.closing = (async () => {
      await Promise.all([released.catch(() => {}), closed]);
      const pending = await checkManager(session.capture);
      report(session.familyToken, pending);
    })();
    return session.closing;
  };
  const close = (expected?: Session) => {
    const session = current.current;
    if (expected && session !== expected) return Promise.resolve();
    current.current = null;
    setStored(null);
    return session ? finish(session) : Promise.resolve();
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const session = current.current;
      current.current = null;
      if (session) void finish(session);
    };
  }, []);
  useLayoutEffect(() => {
    if (current.current?.epoch !== epoch) void close();
    setError(null);
  }, [epoch]);
  // A private family journal may contain a released/abandoned snapshot from a
  // prior process. Opening a cleanup-only binding never opens a picker or OCR.
  useLayoutEffect(() => {
    if (!active || !owner || !familyToken) return;
    let observing = true;
    try {
      const manager = createExpoReceiptCapture({
        owner,
        sessionKey: `cleanup-${newId()}`,
        storage: AsyncStorage,
        newId,
        isCurrent: () => false,
      });
      register(manager);
      void manager
        .close()
        .then(
          () => checkManager(manager),
          () => true,
        )
        .then((pending) => {
          if (observing) report(familyToken, pending);
        });
    } catch {
      report(familyToken, true);
    }
    return () => {
      observing = false;
    };
  }, [active, familyToken]);
  const open = () => {
    const live = latest.current;
    if (
      !mounted.current ||
      current.current ||
      !live.active ||
      !live.visible ||
      !ledger ||
      !owner ||
      !ownerToken ||
      !familyToken ||
      live.epoch !== epoch ||
      live.ledger !== ledger
    )
      return;
    const configured = connection.getCurrent();
    if (configured.phase === 'checking') return;
    if (!photos) {
      setError({
        epoch,
        message: 'Photo storage is still opening. Try receipt capture again in a moment.',
      });
      return;
    }
    try {
      const sessionKey = JSON.stringify([ownerToken, newId()]);
      let session: Session;
      const capture = createExpoReceiptCapture({
        owner,
        sessionKey,
        storage: AsyncStorage,
        newId,
        isCurrent: () =>
          isCurrent(session) &&
          connection.getCurrent().revision === configured.revision &&
          connection.getCurrent().binding === configured.binding,
      });
      const reportCapture = () => {
        register(capture);
        report(familyToken, true);
      };
      const binding: ReceiptUiBinding = {
        sessionKey,
        photos,
        client: configured.binding?.receipt ?? null,
        provider: configured.binding?.providers?.ocr ?? null,
        today: getToday(),
        capture: {
          cameraAvailable: cameraEnabled && capture.cameraAvailable,
          pickPhoto: () => capture.pickPhoto(),
          takePhoto: () =>
            cameraEnabled && capture.cameraAvailable
              ? capture.takePhoto()
              : Promise.reject(
                  new Error(
                    'Camera capture is unavailable in this build. Choose a receipt image instead.',
                  ),
                ),
          readBytes: (image, options) => capture.readBytes(image, options),
          async release(image) {
            try {
              await capture.release(image);
            } catch (error) {
              reportCapture();
              throw error;
            }
            if (retired.get(familyToken)?.has(capture)) {
              const pending = await checkManager(capture);
              report(familyToken, pending);
            }
          },
        },
        isCurrent: () =>
          isCurrent(session) &&
          connection.getCurrent().revision === configured.revision &&
          connection.getCurrent().binding === configured.binding,
        attachLifecycle(closeDraft) {
          if (!isCurrent(session)) return () => {};
          session.closeDraft = closeDraft;
          return () => {
            if (session.closeDraft === closeDraft) session.closeDraft = null;
          };
        },
        onCleanupMessage: reportCapture,
        onPhotoCleanupMessage: (message) => {
          if (latest.current.ownerToken === ownerToken)
            latest.current.onPhotoCleanupMessage(ownerToken, message);
        },
      };
      session = {
        ownerToken,
        familyToken,
        sessionKey,
        capture,
        binding,
        epoch,
        closeDraft: null,
        closing: null,
      };
      void close();
      current.current = session;
      setStored(session);
      setError(null);
    } catch {
      setError({
        epoch,
        message: 'Receipt capture could not be opened for this saved wallet. Try again.',
      });
    }
  };
  const session = stored && current.current === stored && isCurrent(stored) ? stored : null;
  return {
    session: session ? { ...session, binding: { ...session.binding, today: getToday() } } : null,
    hasOpenDraft: () => current.current !== null,
    open,
    close: () => close(),
    closeCurrent: () => (session ? close(session) : Promise.resolve()),
    error: error?.epoch === epoch ? error.message : '',
    cleanupPending: cleanup?.familyToken === familyToken && cleanup.pending,
    cleanupMessage: cleanup?.familyToken === familyToken ? cleanup.message : '',
    async retryCleanup() {
      const live = latest.current,
        family = live.familyToken;
      if (!family || !live.owner || !live.active) return;
      let pending = false;
      try {
        const manager = createExpoReceiptCapture({
          owner: live.owner,
          sessionKey: `cleanup-${newId()}`,
          storage: AsyncStorage,
          newId,
          isCurrent: () => false,
        });
        register(manager);
        await manager.close();
      } catch {
        pending = true;
      }
      for (const manager of [...(retired.get(family) ?? [])])
        pending = (await checkManager(manager)) || pending;
      report(family, pending);
    },
  };
}

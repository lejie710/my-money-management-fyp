import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ledger } from '../core/model';
import {
  AchievementClock,
  currentFinancialMilestoneKeys,
  financialMilestoneEvents,
} from '../core/achievements';
import { LedgerTransitionGuard } from '../core/commitLedger';
import {
  ReminderNotificationData,
  ReminderOwner,
  ReminderOperationResult,
  retireInactiveNotifications,
  type NotificationAdapter,
  type ReminderKeyValueStorage,
} from '../reminders/coordinator';
import {
  expoNotificationAdapter,
  installReminderPresentationHandler,
  setActiveReminderOwner,
  subscribeToReminderNotifications,
} from '../reminders/expoAdapter';
import { CommitObserver, localLedgerFamily } from './useLedger';
import { encodeDataFamily, validateDataFamily, type DataFamily } from '../accounts/identity';
import { useReminders } from './useReminders';

type Options = {
  ledger: Ledger | null;
  active: boolean;
  getClock: () => AchievementClock;
  registerTransitionGuard: (guard: LedgerTransitionGuard) => () => void;
  registerCommitObserver: (observer: CommitObserver) => () => void;
  onOpen: (data: ReminderNotificationData) => void;
  family?: DataFamily;
  storage?: ReminderKeyValueStorage;
  notifications?: NotificationAdapter;
  presentationActive?: boolean;
  autoResumePaused?: boolean;
  isOwnerCurrent?: () => boolean;
};
type Activation = { promise: Promise<ReminderOperationResult> | null };

export function useWalletReminders({
  ledger,
  active,
  getClock,
  registerTransitionGuard,
  registerCommitObserver,
  onOpen,
  family: requestedFamily = localLedgerFamily,
  storage = AsyncStorage,
  notifications = expoNotificationAdapter,
  presentationActive = active,
  autoResumePaused = true,
  isOwnerCurrent,
}: Options) {
  const familyToken = encodeDataFamily(requestedFamily);
  const family = useMemo(() => validateDataFamily(requestedFamily), [familyToken]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const presentationRef = useRef(presentationActive);
  presentationRef.current = presentationActive;
  const currentCheck = useRef(isOwnerCurrent);
  currentCheck.current = isOwnerCurrent;
  const owner = useMemo<ReminderOwner | null>(
    () =>
      active && ledger
        ? {
            ...family,
            incarnationId: ledger.wallet.incarnationId,
          }
        : null,
    [active, familyToken, ledger?.wallet.incarnationId],
  );
  const baselineKeys = useMemo(
    () => (active && ledger ? currentFinancialMilestoneKeys(ledger, getClock()) : []),
    [active, ledger, getClock],
  );
  const reminders = useReminders({
    owner,
    sampleMode: ledger?.mode === 'sample',
    baselineKeys,
    storage,
    notifications,
  });
  const { state, coordinator } = reminders;
  const token = coordinator?.ownerToken ?? null;
  const currentToken = useRef(token);
  currentToken.current = token;
  const stillCurrent = () => {
    try {
      return (
        activeRef.current &&
        !!coordinator &&
        currentToken.current === coordinator.ownerToken &&
        (currentCheck.current?.() ?? true)
      );
    } catch {
      return false;
    }
  };
  const [retryEpoch, setRetryEpoch] = useState(0);
  const activation = useMemo<Activation>(() => ({ promise: null }), [coordinator, retryEpoch]);
  const transitionState = useMemo(() => ({ pending: false }), [coordinator]);
  const [startup, setStartup] = useState<{ token: string; pending: boolean; error: string } | null>(
    null,
  );
  const [received, setReceived] = useState<{ token: string; message: string } | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    installReminderPresentationHandler();
    setActiveReminderOwner(presentationActive ? token : null);
    return () => setActiveReminderOwner(null);
  }, [token, presentationActive]);

  useEffect(() => {
    if (!owner || !coordinator || !state || state.loading || state.loadError) return;
    let observing = true;
    if (!activation.promise) {
      setStartup({ token: coordinator.ownerToken, pending: true, error: '' });
      activation.promise = (async () => {
        const retired = await retireInactiveNotifications({
          scope: owner.scope,
          activeOwner: owner,
          notifications,
          stillActive: stillCurrent,
        });
        if (!retired.ok)
          return {
            ok: false,
            pending: true,
            message:
              'Previous-wallet notification cleanup did not finish. Retry cleanup before replacing this wallet.',
          };
        if (!stillCurrent())
          return {
            ok: false,
            pending: true,
            message: 'The active wallet changed during notification cleanup.',
          };
        // A paused owner restored from disk may represent a reset that never committed.
        // This runs once per binding, not each time an intentional reset pauses it.
        if (autoResumePaused && coordinator.getSnapshot().ownerPaused && !transitionState.pending)
          return coordinator.resumeOwner();
        return { ok: true, pending: false, message: '' };
      })().catch(() => ({
        ok: false,
        pending: true,
        message: 'Previous-wallet notification cleanup could not be checked. Retry cleanup.',
      }));
    }
    void activation.promise.then((result) => {
      if (observing && stillCurrent())
        setStartup({
          token: coordinator.ownerToken,
          pending: false,
          error: result.ok && !result.pending ? '' : result.message,
        });
    });
    return () => {
      observing = false;
    };
  }, [
    owner,
    coordinator,
    state?.loading,
    state?.loadError,
    activation,
    transitionState,
    notifications,
    autoResumePaused,
  ]);

  const quiesceForIdentity = async (
    expectedOwnerToken: string,
  ): Promise<ReminderOperationResult> => {
    if (!coordinator || coordinator.ownerToken !== expectedOwnerToken || !stillCurrent())
      return { ok: false, pending: true, message: 'Reminder ownership is changing.' };
    transitionState.pending = true;
    if (!activation.promise)
      return { ok: false, pending: true, message: 'Reminders are still opening.' };
    const ready = await activation.promise;
    if (!ready.ok || ready.pending || !stillCurrent())
      return {
        ok: false,
        pending: true,
        message: ready.message || 'Reminder activation is unresolved.',
      };
    return coordinator.quiesceAndCancelOwner();
  };
  const resumeForIdentity = async (
    expectedOwnerToken: string,
  ): Promise<ReminderOperationResult> => {
    if (!coordinator || coordinator.ownerToken !== expectedOwnerToken || !stillCurrent())
      return { ok: false, pending: true, message: 'The saved wallet has another reminder owner.' };
    try {
      return await coordinator.resumeOwner();
    } finally {
      transitionState.pending = false;
    }
  };

  useEffect(() => {
    if (!owner || !coordinator) return;
    return registerTransitionGuard({
      async prepare(current) {
        if (current.wallet.incarnationId !== owner.incarnationId || !stillCurrent())
          return { ok: false, pending: true, message: 'Reminder ownership is changing.' };
        return quiesceForIdentity(coordinator.ownerToken);
      },
      async resume(current) {
        if (current.wallet.incarnationId !== owner.incarnationId)
          return {
            ok: false,
            pending: true,
            message: 'The saved wallet has a different reminder owner.',
          };
        return resumeForIdentity(coordinator.ownerToken);
      },
    });
  }, [owner, coordinator, activation, transitionState, registerTransitionGuard]);

  useEffect(() => {
    if (!owner || !coordinator) return;
    return registerCommitObserver(async (previous, committed, clock) => {
      if (
        !stillCurrent() ||
        previous.wallet.incarnationId !== owner.incarnationId ||
        committed.wallet.incarnationId !== owner.incarnationId
      )
        return;
      const events = financialMilestoneEvents(previous, committed, clock);
      if (events.length) await coordinator.observeFinancialEvents(coordinator.ownerToken, events);
    });
  }, [owner, coordinator, registerCommitObserver]);

  useEffect(() => {
    if (!coordinator || !state || state.loading || state.loadError) return;
    return subscribeToReminderNotifications({
      ownerToken: coordinator.ownerToken,
      onReceived() {
        if (!stillCurrent() || !presentationRef.current) return;
        setReceived({ token: coordinator.ownerToken, message: 'A local reminder was received.' });
        void coordinator.reconcile().catch(() => {
          if (!stillCurrent() || !presentationRef.current) return;
          setReceived({
            token: coordinator.ownerToken,
            message: 'A local reminder was received. Refresh Reminders to check its saved status.',
          });
        });
      },
      onOpen(data) {
        if (!stillCurrent() || !presentationRef.current) return;
        if (
          data.kind === 'manual' &&
          !coordinator.getSnapshot().reminders.some((row) => row.id === data.reminderId)
        )
          return;
        openRef.current(data);
      },
    });
  }, [coordinator, state?.loading, state?.loadError]);

  const getBaselineKeys = useCallback(
    () => (ledger && stillCurrent() ? currentFinancialMilestoneKeys(ledger, getClock()) : []),
    [ledger, getClock, coordinator],
  );
  return {
    ...reminders,
    family,
    identityOpening: !coordinator || !state || state.loading || !activation.promise,
    quiesceForIdentity,
    resumeForIdentity,
    async readyForIdentity(
      expectedOwnerToken: string,
      isActivationCurrent: () => boolean,
    ): Promise<ReminderOperationResult> {
      if (
        !coordinator ||
        coordinator.ownerToken !== expectedOwnerToken ||
        !stillCurrent() ||
        !isActivationCurrent() ||
        !activation.promise
      )
        return {
          ok: false,
          pending: true,
          message: 'Reminders are still opening for this exact owner.',
        };
      const ready = await activation.promise;
      if (!stillCurrent() || !isActivationCurrent())
        return {
          ok: false,
          pending: true,
          message: 'Reminder ownership changed during activation.',
        };
      if (coordinator.getSnapshot().ownerPaused)
        return {
          ok: false,
          pending: true,
          message: 'This confirmed owner must be resumed before account access is released.',
        };
      return ready;
    },
    getBaselineKeys,
    startupPending: startup?.token === token && startup.pending,
    startupError: startup?.token === token ? startup.error : '',
    retryStartup: () => setRetryEpoch((value) => value + 1),
    async resumeActiveOwner(): Promise<ReminderOperationResult> {
      if (!coordinator || !stillCurrent() || transitionState.pending)
        return {
          ok: false,
          pending: true,
          message: 'Wait until the saved wallet and its transition are confirmed.',
        };
      return coordinator.resumeOwner();
    },
    receivedMessage: received?.token === token ? received.message : '',
  };
}

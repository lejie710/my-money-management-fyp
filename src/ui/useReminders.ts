import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import {
  createReminderCoordinator,
  NotificationAdapter,
  ReminderCoordinator,
  ReminderKeyValueStorage,
  ReminderOwner,
  ReminderViewState,
} from '../reminders/coordinator';
import { createReminderStore, encodeReminderOwner } from '../reminders/store';

type Options = {
  owner: ReminderOwner | null;
  sampleMode: boolean;
  baselineKeys: readonly string[];
  storage: ReminderKeyValueStorage;
  notifications: NotificationAdapter;
};
type Binding = {
  coordinator: ReminderCoordinator;
  initialization: Promise<unknown> | null;
  disposal: ReturnType<typeof setTimeout> | null;
};
let idSequence = 0;
const operationId = (kind: 'reminder' | 'operation') =>
  `${kind}-${Date.now().toString(36)}-${(++idSequence).toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

export function useReminders({
  owner,
  sampleMode,
  baselineKeys,
  storage,
  notifications,
}: Options): {
  state: ReminderViewState | null;
  coordinator: ReminderCoordinator | null;
} {
  const ownerToken = owner ? encodeReminderOwner(owner) : null;
  const baselineRef = useRef(baselineKeys);
  baselineRef.current = baselineKeys;
  const binding = useMemo<Binding | null>(() => {
    if (!owner) return null;
    return {
      coordinator: createReminderCoordinator({
        owner,
        sampleMode,
        store: createReminderStore(storage, owner),
        notifications,
        now: Date.now,
        newId: operationId,
      }),
      initialization: null,
      disposal: null,
    };
    // Equal owner tokens identify the same immutable owner even if its object is reconstructed.
  }, [ownerToken, sampleMode, storage, notifications]);
  const [failure, setFailure] = useState<Binding | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => (binding ? binding.coordinator.subscribe(listener) : () => {}),
    [binding],
  );
  const getSnapshot = useCallback(() => binding?.coordinator.getSnapshot() ?? null, [binding]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!binding) return;
    let active = true;
    if (binding.disposal !== null) {
      clearTimeout(binding.disposal);
      binding.disposal = null;
    }
    if (!binding.initialization)
      binding.initialization = binding.coordinator.initialize([...baselineRef.current]);
    void binding.initialization.catch(() => {
      if (active) setFailure(binding);
    });
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active')
        void binding.coordinator.reconcile().catch(() => {
          if (active) setFailure(binding);
        });
    });
    return () => {
      active = false;
      listener.remove();
      // React may replay this effect immediately. Only the same binding cancels disposal.
      binding.disposal = setTimeout(() => {
        binding.coordinator.dispose();
        binding.disposal = null;
      }, 0);
    };
  }, [binding]);

  const state = useMemo(
    () =>
      failure === binding && snapshot?.loading
        ? {
            ...snapshot,
            loading: false,
            loadError:
              'Reminder initialization could not finish. Retry to inspect the saved state.',
          }
        : snapshot,
    [failure, binding, snapshot],
  );
  return { state, coordinator: binding?.coordinator ?? null };
}

import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { Ledger } from '../core/model';
import { Action, FormError, Sheet } from '../ui/components';
import { useTheme } from '../ui/theme';
import {
  ledgerFingerprint,
  type TransactionDraftSnapshot,
  type TransactionDraftStore,
} from './transactionDrafts';
export function TransactionDraftGate({
  store,
  ledger,
  isCurrent,
  onClose,
  children,
}: {
  store?: TransactionDraftStore;
  ledger: Ledger;
  isCurrent?: () => boolean;
  onClose(): void;
  children(snapshot: TransactionDraftSnapshot): ReactNode;
}) {
  const { ui } = useTheme();
  const [snapshot, setSnapshot] = useState<TransactionDraftSnapshot | null>(
    store ? null : { revision: 0, record: null },
  );
  const [opened, setOpened] = useState(!store),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const live = useRef({ ledger, isCurrent, store, active: true });
  live.current = { ledger, isCurrent, store, active: true };
  const current = () =>
    live.current.active && live.current.store === store && (live.current.isCurrent?.() ?? true);
  const reload = async () => {
    if (!store || !current()) return;
    setBusy(true);
    setError('');
    try {
      const value = await store.load();
      if (current()) {
        setSnapshot(value);
        setOpened(value.record === null);
      }
    } catch {
      if (current())
        setError(
          'Your saved draft could not be opened. It has been retained. Retry before editing this entry.',
        );
    } finally {
      if (current()) setBusy(false);
    }
  };
  useEffect(() => {
    live.current.active = true;
    void reload();
    return () => {
      live.current.active = false;
    };
  }, [store]);
  if (opened && snapshot) return <>{children(snapshot)}</>;
  const record = snapshot?.record;
  const matches = !!record && record.baseFingerprint === ledgerFingerprint(ledger);
  return (
    <Sheet
      title="Saved entry draft"
      onClose={() => {
        if (!busy && current()) onClose();
      }}
      busy={busy}
    >
      {!snapshot && !error ? (
        <Text style={ui.body}>Opening the draft saved on this device.</Text>
      ) : null}
      {record ? (
        <>
          <Text style={ui.heading}>Continue your unfinished entry?</Text>
          <Text style={[ui.body, ui.smallGap]}>
            This draft is saved only on this device. Review it before making any changes to the
            wallet.
          </Text>
          <View style={[ui.card, ui.gap]} testID="transaction-saved-draft-preview">
            <Text selectable style={ui.heading}>
              {record.fields.title || 'Untitled entry'}
            </Text>
            <Text selectable style={ui.body}>
              {record.fields.type} · {record.fields.amount || 'No amount'} ·{' '}
              {record.fields.date || 'No date'}
            </Text>
            {record.details.notes ? (
              <Text selectable style={[ui.body, ui.smallGap]}>
                {record.details.notes}
              </Text>
            ) : null}
            {record.details.person ? (
              <Text selectable style={ui.body}>
                Person: {record.details.person.name}
              </Text>
            ) : null}
            {record.details.place ? (
              <Text selectable style={ui.body}>
                Place: {record.details.place.label}
              </Text>
            ) : null}
          </View>
          {!matches ? (
            <Text style={[ui.error, ui.gap]} testID="transaction-draft-stale">
              The wallet changed after this draft was started. Review these saved details before
              discarding the draft and starting from the current records. This draft cannot
              overwrite the newer wallet.
            </Text>
          ) : null}
          {record.photoIntent === 'repick' ? (
            <Text style={[ui.hint, ui.smallGap]}>
              Choose the newly selected photo again after resuming. Temporary photo access is not
              retained in a draft.
            </Text>
          ) : null}
          <View style={ui.gap}>
            <Action
              label="Resume saved draft"
              disabled={busy || !matches}
              testID="transaction-draft-resume"
              onPress={() => {
                if (current() && record.baseFingerprint === ledgerFingerprint(live.current.ledger))
                  setOpened(true);
              }}
            />
          </View>
          <View style={ui.smallGap}>
            <Action
              label="Discard saved draft"
              danger
              secondary
              disabled={busy}
              testID="transaction-draft-discard"
              onPress={() => {
                if (!store || !snapshot || busy || !current()) return;
                setBusy(true);
                setError('');
                void store
                  .discard(snapshot.revision)
                  .then(
                    (value) => {
                      if (current()) {
                        setSnapshot(value);
                        setOpened(true);
                      }
                    },
                    () => {
                      if (current())
                        setError(
                          'The saved draft changed or could not be removed. Reopen it before trying again.',
                        );
                    },
                  )
                  .finally(() => {
                    if (current()) setBusy(false);
                  });
              }}
            />
          </View>
        </>
      ) : null}
      <FormError message={error} testID="transaction-draft-load-error" />
      {error ? (
        <View style={ui.gap}>
          <Action
            label="Reopen saved draft"
            secondary
            disabled={busy}
            testID="transaction-draft-reload"
            onPress={() => {
              void reload();
            }}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

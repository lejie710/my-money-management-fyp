import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { GOAL_KINDS, type Ledger } from '../core/model';
import { Action, FormError, Sheet } from '../ui/components';
import { useTheme } from '../ui/theme';
import { type FormDraftSnapshot, type FinancialFormDraftStore } from './formDrafts';
import { ledgerFingerprint } from './transactionDrafts';
export function FinancialFormDraftGate({
  store,
  kind,
  ledger,
  isCurrent,
  onClose,
  children,
}: {
  store?: FinancialFormDraftStore;
  kind: 'budget' | 'goal';
  ledger: Ledger;
  isCurrent?: () => boolean;
  onClose(): void;
  children(snapshot: FormDraftSnapshot): ReactNode;
}) {
  const { ui } = useTheme();
  const [snapshot, setSnapshot] = useState<FormDraftSnapshot | null>(
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
          'Your saved draft could not be opened. It has been retained. Retry before editing this plan.',
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
      title={kind === 'budget' ? 'Saved budget draft' : 'Saved goal draft'}
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
          <Text style={ui.heading}>Continue your unfinished plan?</Text>
          <Text style={[ui.body, ui.smallGap]}>
            This draft is saved only on this device. Review it before making any changes to the
            wallet.
          </Text>
          <View style={[ui.card, ui.gap]} testID={kind + '-saved-draft-preview'}>
            <Text selectable style={ui.heading}>
              {record.fields.amount || 'No amount entered'}
            </Text>
            {record.kind === 'budget' ? (
              <>
                <Text selectable style={ui.body}>
                  {record.fields.period} - {record.fields.anchorDate || 'No date entered'}
                </Text>
                <Text selectable style={ui.body}>
                  {ledger.categories.find(
                    (row) => row.id === (record.kind === 'budget' ? record.fields.categoryId : ''),
                  )?.name || 'Previously selected category'}
                </Text>
              </>
            ) : (
              <Text selectable style={ui.body}>
                {
                  GOAL_KINDS.find(
                    (row) => row.value === (record.kind === 'goal' ? record.fields.kind : ''),
                  )?.label
                }
              </Text>
            )}
          </View>
          {!matches ? (
            <Text style={[ui.error, ui.gap]} testID={kind + '-draft-stale'}>
              The wallet changed after this draft was started. Review these saved details before
              discarding the draft and starting from the current records. This draft cannot
              overwrite the newer wallet.
            </Text>
          ) : null}
          <View style={ui.gap}>
            <Action
              label="Resume saved draft"
              disabled={busy || !matches}
              testID={kind + '-draft-resume'}
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
              testID={kind + '-draft-discard'}
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
      <FormError message={error} testID={kind + '-draft-load-error'} />
      {error ? (
        <View style={ui.gap}>
          <Action
            label="Reopen saved draft"
            secondary
            disabled={busy}
            testID={kind + '-draft-reload'}
            onPress={() => {
              void reload();
            }}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

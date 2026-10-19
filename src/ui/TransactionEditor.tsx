import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  amountInputValue,
  deleteTransaction,
  Draft,
  Ledger,
  localDate,
  saveTransaction,
  Transaction,
  TransactionType,
  transactionFromDraft,
  patchTransactionContext,
} from '../core/model';
import { Action, Choice, Field, FormError, Sheet } from './components';
import { useTheme } from './theme';
import { SaveLedger } from './useLedger';
import { TransactionDraftGate } from '../drafts/TransactionDraftGate';
import { useTransactionDraft } from '../drafts/useTransactionDraft';
import {
  ledgerFingerprint,
  type TransactionDraftSnapshot,
  type TransactionDraftStore,
} from '../drafts/transactionDrafts';
import { contextForTransaction } from '../core/transactionContext';
import { TransactionContextFields } from './TransactionContextFields';
import { useTransactionContext } from './useTransactionContext';
import type { TransactionContextBinding } from './transactionContextTypes';

export const typeLabels: Record<TransactionType, string> = {
  income: 'Income',
  expense: 'Expense',
  debt: 'Debt payment',
};
export const types: TransactionType[] = ['expense', 'income', 'debt'];
export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type Props = {
  ledger: Ledger;
  cloudAccount?: boolean;
  transaction?: Transaction;
  saving: boolean;
  saveError: string;
  onSave: SaveLedger;
  onClose: () => void;
  clearSaveError: () => void;
  context?: TransactionContextBinding;
  draftStore?: TransactionDraftStore;
  isCurrent?: () => boolean;
};

export function TransactionEditor(props: Props) {
  const key =
    props.context?.sessionKey ??
    `${props.ledger.wallet.incarnationId}/${props.transaction?.id ?? 'new'}`;
  return (
    <TransactionDraftGate
      key={key + '/' + (props.draftStore?.key ?? '')}
      store={props.draftStore}
      ledger={props.ledger}
      isCurrent={props.isCurrent}
      onClose={props.onClose}
    >
      {(initialDraft) => <TransactionEditorForm {...props} initialDraft={initialDraft} />}
    </TransactionDraftGate>
  );
}

function TransactionEditorForm({
  ledger,
  cloudAccount = false,
  transaction,
  saving,
  saveError,
  onSave,
  onClose,
  clearSaveError,
  context,
  draftStore,
  isCurrent,
  initialDraft,
}: Props & { initialDraft: TransactionDraftSnapshot }) {
  const { colors, ui } = useTheme();
  const [draft, setDraft] = useState<Draft>(
    () =>
      initialDraft.record?.fields ??
      (transaction
        ? {
            type: transaction.type,
            title: transaction.title,
            categoryId: transaction.categoryId,
            amount: amountInputValue(transaction.amountMinor, ledger.wallet.currency),
            date: transaction.date,
          }
        : {
            type: 'expense',
            title: '',
            categoryId: ledger.categories.find((item) => item.type === 'expense')?.id ?? '',
            amount: '',
            date: localDate(),
          }),
  );
  const [error, setError] = useState('');
  const [transactionId] = useState(
    () => initialDraft.record?.transactionId ?? transaction?.id ?? newId('transaction'),
  );
  const [baseFingerprint] = useState(
    () => initialDraft.record?.baseFingerprint ?? ledgerFingerprint(ledger),
  );
  const latestLedger = useRef(ledger);
  latestLedger.current = ledger;
  const [resumedContext] = useState(() => {
    const saved = initialDraft.record,
      original = contextForTransaction(transaction ?? {});
    return saved
      ? {
          context: {
            ...original,
            notes: saved.details.notes,
            withPerson: saved.details.person,
            location: saved.details.place,
            photo: original.photo,
          },
        }
      : (transaction ?? {});
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const writing = useRef(false);
  const contextDraft = useTransactionContext({
    sessionKey: context?.sessionKey ?? `${ledger.wallet.incarnationId}/${transaction?.id ?? 'new'}`,
    ownerIncarnationId: ledger.wallet.incarnationId,
    initial: resumedContext,
    photos: context?.photos ?? null,
    services: context?.services ?? null,
    onCleanupMessage: context?.onCleanupMessage,
  });
  useEffect(() => {
    if (initialDraft.record?.photoIntent === 'remove') contextDraft.removePhoto();
  }, []);
  const draftPersistence = useTransactionDraft({
    store: draftStore,
    initial: initialDraft,
    isCurrent,
    value: {
      baseFingerprint,
      transactionId,
      fields: draft,
      details: {
        notes: contextDraft.notes,
        person: contextDraft.person,
        place: contextDraft.place,
      },
      photoIntent:
        contextDraft.photoEdit.kind === 'selected'
          ? 'repick'
          : contextDraft.photoEdit.kind === 'remove'
            ? 'remove'
            : (initialDraft.record?.photoIntent ?? 'keep'),
    },
  });
  const [closing, setClosing] = useState(false);
  const busy = saving || contextDraft.preparing || closing;
  const close = () => {
    if (writing.current || busy || !(isCurrent?.() ?? true)) return;
    setClosing(true);
    void draftPersistence
      .flush()
      .then((saved) => {
        if (saved && (isCurrent?.() ?? true) && contextDraft.close()) onClose();
      })
      .finally(() => setClosing(false));
  };
  const categories = ledger.categories.filter((item) => item.type === draft.type);

  const update = (key: keyof Draft, value: string) => {
    if (writing.current || busy || !(isCurrent?.() ?? true)) return;
    setDraft((current) => ({ ...current, [key]: value }));
    setError('');
    clearSaveError();
  };

  const submit = async () => {
    if (saving || writing.current || !(isCurrent?.() ?? true)) return;
    writing.current = true;
    setError('');
    let prepared: Awaited<ReturnType<typeof contextDraft.preparePatch>> | null = null;
    try {
      if (ledgerFingerprint(latestLedger.current) !== baseFingerprint)
        throw new Error(
          'The wallet changed while this entry was open. Your draft is retained; reopen it and review the current records before saving.',
        );
      if (!(await draftPersistence.flush())) return;
      if (!(isCurrent?.() ?? true) || ledgerFingerprint(latestLedger.current) !== baseFingerprint)
        throw new Error(
          'The wallet changed before this entry could be saved. Your draft is retained.',
        );
      const financialTransaction = transactionFromDraft(draft, transactionId, ledger);
      prepared = await contextDraft.preparePatch();
      if (!prepared.isCurrent() || !(isCurrent?.() ?? true)) return;
      if (ledgerFingerprint(latestLedger.current) !== baseFingerprint)
        throw new Error(
          'The wallet changed while the photo was prepared. Your entry draft is retained.',
        );
      const nextTransaction = patchTransactionContext(financialTransaction, prepared.patch, ledger);
      const next = saveTransaction(ledger, nextTransaction, !!transaction);
      if (
        await onSave(
          next,
          `${transaction ? 'Updated' : 'Added'} ${nextTransaction.title}.`,
        )
      ) {
        const stillCurrent = prepared.isCurrent();
        void prepared.complete(true);
        const cleared = await draftPersistence.complete();
        if (!cleared)
          context?.onCleanupMessage?.(
            'The transaction was saved. An older entry draft remains on this device; review it before another entry.',
          );
        if (stillCurrent && (isCurrent?.() ?? true)) onClose();
      } else await prepared.complete(false);
    } catch (cause) {
      if (prepared) await prepared.complete(false);
      setError(
        cause instanceof Error ? cause.message : 'Check the transaction details and try again.',
      );
    } finally {
      writing.current = false;
    }
  };

  const remove = async () => {
    if (!transaction || saving || writing.current || !(isCurrent?.() ?? true)) return;
    writing.current = true;
    let prepared: ReturnType<typeof contextDraft.prepareDeletion> | null = null;
    try {
      if (ledgerFingerprint(latestLedger.current) !== baseFingerprint)
        throw new Error(
          'The wallet changed while this entry was open. Review the current record before deleting it.',
        );
      if (!(await draftPersistence.flush())) return;
      if (!(isCurrent?.() ?? true) || ledgerFingerprint(latestLedger.current) !== baseFingerprint)
        throw new Error('The wallet changed before deletion. Review the current record first.');
      prepared = contextDraft.prepareDeletion();
      if (
        await onSave(
          deleteTransaction(ledger, transaction.id),
          'Transaction deleted. Balances and totals are updated.',
        )
      ) {
        const stillCurrent = prepared.isCurrent();
        void prepared.complete(true);
        const cleared = await draftPersistence.complete();
        if (!cleared)
          context?.onCleanupMessage?.(
            'The transaction was deleted. An older entry draft remains on this device.',
          );
        if (stillCurrent && (isCurrent?.() ?? true)) onClose();
      } else await prepared.complete(false);
    } catch (cause) {
      if (prepared) await prepared.complete(false);
      setError(cause instanceof Error ? cause.message : 'The transaction could not be deleted.');
    } finally {
      writing.current = false;
    }
  };

  if (showMap && context?.renderPlacePicker && context.services)
    return (
      <Sheet key="place-picker" title="Choose a place" onClose={() => setShowMap(false)}>
        {context.renderPlacePicker({
          initialLabel: contextDraft.place?.label ?? '',
          services: context.services,
          sessionKey: context.sessionKey,
          onCancel: () => setShowMap(false),
          onConfirm: (value) => {
            contextDraft.acceptMapPlace(value);
            setShowMap(false);
          },
        })}
      </Sheet>
    );

  return (
    <Sheet
      key="transaction-editor"
      title={transaction ? 'Edit transaction' : 'New transaction'}
      onClose={close}
      busy={busy}
    >
      {draftPersistence.enabled ? (
        <View style={ui.smallGap}>
          <Text style={ui.hint} testID="transaction-draft-status">
            {draftPersistence.saving
              ? 'Saving draft on this device.'
              : draftPersistence.saved
                ? 'Draft saved on this device. Close to finish it later.'
                : 'Unfinished edits will be saved as a draft on this device.'}
          </Text>
          <FormError message={draftPersistence.error} testID="transaction-draft-save-error" />
          {draftPersistence.error ? (
            <View style={ui.smallGap}>
              <Action
                label="Retry saving draft"
                secondary
                disabled={busy}
                onPress={() => {
                  void draftPersistence.flush();
                }}
                testID="transaction-draft-save-retry"
              />
            </View>
          ) : null}
          {initialDraft.record?.photoIntent === 'repick' ? (
            <Text style={[ui.hint, ui.smallGap]} testID="transaction-draft-photo-repick">
              Choose the newly selected photo again. Its temporary access was not retained; any
              previously saved photo stays unchanged until you replace or remove it.
            </Text>
          ) : null}
        </View>
      ) : null}
      <Text style={ui.fieldLabel}>Transaction type</Text>
      <View style={[ui.row, { flexWrap: 'wrap' }]}>
        {types.map((type) => (
          <Choice
            key={type}
            label={typeLabels[type]}
            selected={draft.type === type}
            disabled={busy}
            testID={`type-${type}`}
            onPress={() => {
              if (type === draft.type || writing.current || busy || !(isCurrent?.() ?? true))
                return;
              setDraft((current) => ({
                ...current,
                type,
                categoryId: ledger.categories.find((item) => item.type === type)?.id ?? '',
              }));
              setError('');
              clearSaveError();
            }}
          />
        ))}
      </View>
      <Field
        label="Title"
        testID="transaction-title-input"
        accessibilityLabel="Transaction title"
        value={draft.title}
        onChangeText={(value) => update('title', value)}
        placeholder="e.g. Lunch with friends"
        maxLength={80}
        editable={!busy}
        autoCapitalize="sentences"
      />
      <Field
        label={`Amount (${ledger.wallet.currency})`}
        testID="transaction-amount-input"
        value={draft.amount}
        onChangeText={(value) => update('amount', value)}
        placeholder={ledger.wallet.currency === 'JPY' ? '0' : '0.00'}
        keyboardType="decimal-pad"
        maxLength={15}
        editable={!busy}
        style={{ fontSize: 23, fontVariant: ['tabular-nums'] }}
      />
      <Text style={ui.fieldLabel}>Category</Text>
      <View style={[ui.row, { flexWrap: 'wrap', gap: 8 }]}>
        {categories.map((category) => (
          <Choice
            key={category.id}
            label={category.name}
            selected={draft.categoryId === category.id}
            disabled={busy}
            testID={`select-category-${category.id}`}
            onPress={() => update('categoryId', category.id)}
          />
        ))}
      </View>
      <Text style={[ui.hint, { marginTop: 7 }]}>
        Create or rename categories in Wallet → Categories.
      </Text>
      <Field
        label="Date (YYYY-MM-DD)"
        testID="transaction-date-input"
        accessibilityLabel="Transaction date in year month day format"
        value={draft.date}
        onChangeText={(value) => update('date', value)}
        placeholder={localDate()}
        maxLength={10}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        hint="Use the date the money moved, for example 2026-10-17."
      />
      {cloudAccount ? (
        <Text style={[ui.hint,ui.gap]} testID="transaction-cloud-disclosure">
          When you save, these details and any attached photo are stored in your Firebase account.
          Unsaved drafts stay on this device.
        </Text>
      ) : null}
      <TransactionContextFields
        draft={contextDraft}
        expanded={contextExpanded}
        onExpandedChange={setContextExpanded}
        photos={context?.photos ?? null}
        disabled={busy}
        onOpenMap={
          context?.renderPlacePicker && context.services
            ? () => {
                contextDraft.invalidatePlace();
                setShowMap(true);
              }
            : undefined
        }
      />
      <FormError message={error || saveError} testID="transaction-error" />
      <View style={ui.gap}>
        <Action
          label={busy ? 'Saving…' : transaction ? 'Save changes' : 'Save transaction'}
          disabled={busy || contextDraft.pending !== null}
          onPress={() => {
            void submit();
          }}
          testID="save-transaction"
        />
      </View>
      {transaction && !confirmDelete ? (
        <View style={ui.smallGap}>
          <Action
            label="Delete transaction"
            secondary
            danger
            disabled={busy}
            onPress={() => setConfirmDelete(true)}
            testID="delete-transaction"
          />
        </View>
      ) : null}
      {transaction && confirmDelete ? (
        <View style={ui.gap}>
          <Text style={ui.body}>
            Delete this transaction and update the balance? This cannot be undone.
          </Text>
          <View style={ui.smallGap}>
            <Action
              label="Yes, delete transaction"
              secondary
              danger
              disabled={busy}
              onPress={() => {
                void remove();
              }}
              testID="confirm-delete"
            />
          </View>
          <View style={ui.smallGap}>
            <Action
              label="Keep transaction"
              secondary
              disabled={busy}
              onPress={() => setConfirmDelete(false)}
            />
          </View>
        </View>
      ) : null}
      <Text style={[ui.hint, ui.gap]}>
        {cloudAccount
          ? 'Saving confirms this transaction and its optional details in Firebase. Attached photos are also stored with this account.'
          : 'Saved only on this device.'}{' '}
        Debt payments reduce the balance, just like expenses, and remain
        separate in totals.
      </Text>
    </Sheet>
  );
}

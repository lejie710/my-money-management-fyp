import React, { useRef, useState } from 'react';
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
import { ui } from './theme';
import { SaveLedger } from './useLedger';
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
  transaction?: Transaction;
  saving: boolean;
  saveError: string;
  onSave: SaveLedger;
  onClose: () => void;
  clearSaveError: () => void;
  context?: TransactionContextBinding;
};

export function TransactionEditor(props: Props) {
  const key =
    props.context?.sessionKey ??
    `${props.ledger.wallet.incarnationId}/${props.transaction?.id ?? 'new'}`;
  return <TransactionEditorForm key={key} {...props} />;
}

function TransactionEditorForm({
  ledger,
  transaction,
  saving,
  saveError,
  onSave,
  onClose,
  clearSaveError,
  context,
}: Props) {
  const [draft, setDraft] = useState<Draft>(() =>
    transaction
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
        },
  );
  const [error, setError] = useState('');
  const [transactionId] = useState(() => transaction?.id ?? newId('transaction'));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const writing = useRef(false);
  const contextDraft = useTransactionContext({
    sessionKey: context?.sessionKey ?? `${ledger.wallet.incarnationId}/${transaction?.id ?? 'new'}`,
    ownerIncarnationId: ledger.wallet.incarnationId,
    initial: transaction ?? {},
    photos: context?.photos ?? null,
    services: context?.services ?? null,
    onCleanupMessage: context?.onCleanupMessage,
  });
  const busy = saving || contextDraft.preparing;
  const close = () => {
    if (writing.current || busy) return;
    if (contextDraft.close()) onClose();
  };
  const categories = ledger.categories.filter((item) => item.type === draft.type);

  const update = (key: keyof Draft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError('');
    clearSaveError();
  };

  const submit = async () => {
    if (saving || writing.current) return;
    writing.current = true;
    setError('');
    let prepared: Awaited<ReturnType<typeof contextDraft.preparePatch>> | null = null;
    try {
      const financialTransaction = transactionFromDraft(draft, transactionId, ledger);
      prepared = await contextDraft.preparePatch();
      if (!prepared.isCurrent()) return;
      const nextTransaction = patchTransactionContext(financialTransaction, prepared.patch, ledger);
      const next = saveTransaction(ledger, nextTransaction, !!transaction);
      if (
        await onSave(
          next,
          `${transaction ? 'Updated' : 'Added'} ${nextTransaction.title}. Saved on this device.`,
        )
      ) {
        const stillCurrent = prepared.isCurrent();
        void prepared.complete(true);
        if (stillCurrent) onClose();
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
    if (!transaction || saving || writing.current) return;
    writing.current = true;
    let prepared: ReturnType<typeof contextDraft.prepareDeletion> | null = null;
    try {
      prepared = contextDraft.prepareDeletion();
      if (
        await onSave(
          deleteTransaction(ledger, transaction.id),
          'Transaction deleted. Balances and totals are updated.',
        )
      ) {
        const stillCurrent = prepared.isCurrent();
        void prepared.complete(true);
        if (stillCurrent) onClose();
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
              if (type === draft.type) return;
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
        Saved only on this device. Debt payments reduce the balance, just like expenses, and remain
        separate in totals.
      </Text>
    </Sheet>
  );
}

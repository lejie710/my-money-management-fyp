import React, { type ReactNode, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  createEmptyLedger,
  canChangeCurrency,
  CURRENCIES,
  Currency,
  formatMoney,
  Ledger,
  totals,
  updateWallet,
} from '../core/model';
import { Action, Choice, Field, FormError, RowAction, Screen, Sheet } from './components';
import { colors, ui } from './theme';
import { SaveLedger } from './useLedger';

function CurrencyChoices({
  currency,
  onChange,
  disabled,
}: {
  currency: Currency;
  onChange: (currency: Currency) => void;
  disabled: boolean;
}) {
  return (
    <View style={[ui.row, { flexWrap: 'wrap', gap: 8 }]}>
      {CURRENCIES.map((item) => (
        <Choice
          key={item.code}
          label={item.code}
          selected={currency === item.code}
          disabled={disabled}
          onPress={() => onChange(item.code)}
          testID={`currency-${item.code}`}
        />
      ))}
    </View>
  );
}

type Props = {
  ledger: Ledger;
  saving: boolean;
  saveError: string;
  onSave: SaveLedger;
  clearSaveError: () => void;
};

export function WalletScreen({
  ledger,
  saving,
  saveError,
  onSave,
  clearSaveError,
  onManageCategories,
  onOpenLoanCalculator,
  onOpenAchievements,
  onOpenReminders,
  accountEntry,
  showAccountShortcut = true,
  onOpenConnections,
}: Props & {
  onManageCategories: () => void;
  onOpenLoanCalculator: () => void;
  onOpenAchievements: () => void;
  onOpenReminders: () => void;
  accountEntry?: ReactNode;
  showAccountShortcut?: boolean;
  onOpenConnections?: () => void;
}) {
  const [name, setName] = useState(ledger.wallet.name);
  const [currency, setCurrency] = useState<Currency>(ledger.wallet.currency);
  const [error, setError] = useState('');
  const [freshOpen, setFreshOpen] = useState(false);
  useEffect(() => {
    setName(ledger.wallet.name);
    setCurrency(ledger.wallet.currency);
  }, [ledger.wallet.name, ledger.wallet.currency]);
  const changed = name.trim() !== ledger.wallet.name || currency !== ledger.wallet.currency;

  const saveWallet = async () => {
    setError('');
    try {
      await onSave(
        updateWallet(ledger, { name, currency }),
        'Wallet settings saved on this device.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the wallet details.');
    }
  };

  return (
    <>
      <Screen>
        <Text style={ui.title} accessibilityRole="header">
          Wallet
        </Text>
        {showAccountShortcut && accountEntry ? (
          <View style={styles.group}>{accountEntry}</View>
        ) : null}
        <Text style={styles.sectionLabel} accessibilityRole="header">
          Wallet details
        </Text>
        <View style={styles.details}>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceLabel}>Balance across all dates</Text>
            <Text selectable style={styles.balanceValue}>
              {formatMoney(totals(ledger).balance, ledger.wallet.currency)}
            </Text>
          </View>
          <Field
            label="Wallet name"
            testID="wallet-name-input"
            value={name}
            editable={!saving}
            maxLength={80}
            onChangeText={(value) => {
              setName(value);
              setError('');
              clearSaveError();
            }}
            placeholder="e.g. Everyday wallet"
          />
          <Text style={ui.fieldLabel}>Currency</Text>
          {!canChangeCurrency(ledger) ? (
            <>
              <Text style={ui.heading} testID="wallet-currency">
                {ledger.wallet.currency}
              </Text>
              <Text style={[ui.hint, { marginTop: 7 }]}>
                {ledger.wallet.hasTransactionHistory
                  ? 'Currency is fixed after the first transaction, even if entries are deleted.'
                  : 'Currency is fixed while a budget or savings goal exists.'}{' '}
                Changing a label would not convert your money.
              </Text>
            </>
          ) : (
            <>
              <CurrencyChoices
                currency={currency}
                onChange={(value) => {
                  setCurrency(value);
                  setError('');
                  clearSaveError();
                }}
                disabled={saving}
              />
              <Text style={[ui.hint, { marginTop: 8 }]}>
                Choose before adding a transaction, budget, or savings goal. Currency conversion is
                not supported.
              </Text>
            </>
          )}
          <FormError message={error || (!freshOpen ? saveError : '')} testID="wallet-error" />
          <View style={ui.gap}>
            <Action
              label={saving ? 'Saving…' : 'Save wallet'}
              disabled={saving || !changed}
              onPress={() => {
                void saveWallet();
              }}
              testID="save-wallet"
            />
          </View>
        </View>
        <Text style={styles.sectionLabel} accessibilityRole="header">
          Tools
        </Text>
        <View style={styles.tools}>
          <RowAction
            label="Categories"
            detail="Organize transactions and budgets"
            icon="category"
            disabled={saving}
            onPress={onManageCategories}
            testID="manage-categories"
          />
          <RowAction
            label="Achievements"
            detail="Milestones and check-ins"
            icon="trophy"
            disabled={saving}
            onPress={onOpenAchievements}
            testID="open-achievements"
          />
          <RowAction
            label="Reminders"
            detail="Scheduled on this device"
            icon="bell"
            disabled={saving}
            onPress={onOpenReminders}
            testID="open-reminders"
          />
          <RowAction
            label="Loan calculator"
            detail="Payment estimates and schedules"
            icon="calculator"
            disabled={saving}
            onPress={onOpenLoanCalculator}
            testID="open-loan-calculator"
            last={!onOpenConnections}
          />
          {onOpenConnections ? (
            <RowAction
              label="Connections"
              detail="Accounts, receipt recognition and assistant"
              icon="category"
              disabled={saving}
              onPress={onOpenConnections}
              testID="open-connections"
              last
            />
          ) : null}
        </View>
        <View style={styles.resetSection}>
          <RowAction
            label="Start fresh"
            detail={
              ledger.mode === 'sample'
                ? 'Replace the sample wallet and your edits'
                : 'Replace this wallet with an empty one'
            }
            danger
            last
            onPress={() => {
              setError('');
              clearSaveError();
              setFreshOpen(true);
            }}
            disabled={saving}
            testID="start-fresh"
          />
        </View>
        <Text style={styles.storageNote}>
          Records stay on this device. Uninstalling the app or clearing its storage can remove them.
        </Text>
      </Screen>
      {freshOpen ? (
        <FreshWallet
          ledger={ledger}
          saving={saving}
          saveError={saveError}
          onSave={onSave}
          clearSaveError={clearSaveError}
          onClose={() => setFreshOpen(false)}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  group: {
    marginTop: 20,
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  sectionLabel: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
    marginTop: 24,
    marginBottom: 9,
    paddingHorizontal: 4,
  },
  details: {
    backgroundColor: colors.surface,
    padding: 20,
    borderRadius: 18,
    borderCurve: 'continuous',
  },
  balanceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: 12,
    rowGap: 6,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  balanceLabel: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  balanceValue: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  tools: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  resetSection: {
    marginTop: 30,
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  storageNote: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 4,
    marginTop: 14,
  },
});

function FreshWallet({
  ledger,
  saving,
  saveError,
  onSave,
  onClose,
  clearSaveError,
}: Props & { onClose: () => void }) {
  const [name, setName] = useState('My wallet');
  const [currency, setCurrency] = useState<Currency>(ledger.wallet.currency);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const reset = async () => {
    if (saving || !confirmed) return;
    try {
      const next = createEmptyLedger({ name, currency });
      if (await onSave(next, 'Your empty local wallet is ready. Add a transaction to begin.'))
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the new wallet details.');
    }
  };

  return (
    <Sheet title="Start fresh" busy={saving} onClose={onClose}>
      <Text style={[ui.body, { marginTop: 14 }]}>
        Replace “{ledger.wallet.name}” and its {ledger.transactions.length}{' '}
        {ledger.transactions.length === 1 ? 'transaction' : 'transactions'} with an empty wallet.
        Custom categories, {ledger.budgets.length}{' '}
        {ledger.budgets.length === 1 ? 'budget' : 'budgets'}, and{' '}
        {ledger.goal ? 'your savings goal' : 'any savings goal'} will also be removed. Earned
        awards, completed-day check-ins, and weekly reviews start over. This wallet’s future
        reminders are canceled before replacement; if cancellation is incomplete, the reset remains
        pending. This cannot be undone.
      </Text>
      <Field
        label="New wallet name"
        value={name}
        maxLength={80}
        editable={!saving}
        testID="fresh-wallet-name-input"
        onChangeText={(value) => {
          setName(value);
          setError('');
          clearSaveError();
        }}
      />
      <Text style={ui.fieldLabel}>Currency</Text>
      <CurrencyChoices currency={currency} onChange={setCurrency} disabled={saving} />
      <FormError message={error || saveError} testID="fresh-wallet-error" />
      <View style={ui.gap}>
        <Choice
          label="I understand these records will be replaced"
          selected={confirmed}
          onPress={() => setConfirmed((value) => !value)}
          disabled={saving}
          testID="fresh-wallet-confirmation"
        />
      </View>
      <View style={ui.gap}>
        <Action
          label={saving ? 'Saving…' : 'Replace with empty wallet'}
          danger
          secondary
          disabled={saving || !confirmed}
          onPress={() => {
            void reset();
          }}
          testID="confirm-start-fresh"
        />
      </View>
      <View style={ui.smallGap}>
        <Action label="Keep current wallet" secondary disabled={saving} onPress={onClose} />
      </View>
    </Sheet>
  );
}

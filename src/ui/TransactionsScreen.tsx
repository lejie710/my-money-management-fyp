import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
  categoryForTransaction,
  formatMoney,
  Ledger,
  localDate,
  periodTotals,
  totals,
  Transaction,
} from '../core/model';
import { Action, FormError, Screen } from './components';
import { AppIcon } from './AppIcon';
import { useThemedStyles, type ThemeColors } from './theme';
import { typeLabels } from './TransactionEditor';

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const firstMonth = '1900-01';
const lastMonth = '2100-12';
function clampMonth(month: string) {
  return month < firstMonth ? firstMonth : month > lastMonth ? lastMonth : month;
}
export function displayDate(date: string) {
  const [year, month, day] = date.split('-');
  return `${Number(day)} ${months[Number(month) - 1].slice(0, 3)} ${year}`;
}
function monthLabel(month: string) {
  return `${months[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}
function shiftMonth(month: string, delta: number) {
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + delta, 1);
  return clampMonth(localDate(date).slice(0, 7));
}
function monthEnd(month: string) {
  return localDate(new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0));
}

export function TransactionsScreen({
  ledger,
  onEdit,
  onAdd,
  onShare,
  receiptTools,
}: {
  ledger: Ledger;
  onEdit: (transaction: Transaction) => void;
  onAdd: () => void;
  onShare?: (transaction: Transaction) => void;
  receiptTools?: React.ReactNode;
}) {
  const {
    colors,
    ui,
    styles,
    balanceHidden,
    preferencesReady,
    preferencesSaving,
    preferenceError,
    setBalanceHidden,
    retryPreferences,
  } = useThemedStyles(createStyles);
  const [month, setMonth] = useState(() => clampMonth(localDate().slice(0, 7)));
  const [allTime, setAllTime] = useState(true);
  const { fontScale, width } = useWindowDimensions();
  const roomyRows = fontScale >= 1.3 || width < 360;
  const summary = totals(ledger);
  const activity = allTime ? summary : periodTotals(ledger, `${month}-01`, monthEnd(month));
  const transactions = ledger.transactions
    .filter((item) => allTime || item.date.startsWith(`${month}-`))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const money = (amount: number) => formatMoney(amount, ledger.wallet.currency);

  return (
    <Screen>
      <View style={styles.titleRow}>
        <Text style={ui.title} accessibilityRole="header">
          Activity
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add transaction"
          onPress={onAdd}
          testID="add-transaction"
          style={({ pressed }) => [styles.addAction, pressed && ui.pressed]}
        >
          <AppIcon name="plus" size={18} color={colors.onAccent} />
          <Text style={styles.addLabel}>Add</Text>
        </Pressable>
      </View>
      <View style={styles.balanceSurface}>
        <View style={styles.walletHeading}>
          <AppIcon name="wallet" size={20} color={colors.muted} />
          <Text style={styles.walletName}>{ledger.wallet.name}</Text>
        </View>
        <View style={[ui.between, { flexWrap: 'wrap' }]}>
          <Text style={styles.balanceLabel}>Wallet balance</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              balanceHidden ? 'Show home wallet balance' : 'Hide home wallet balance'
            }
            accessibilityHint="Only the balance at the top of Activity is hidden. Other amounts stay visible."
            accessibilityState={{ disabled: !preferencesReady || preferencesSaving }}
            disabled={!preferencesReady || preferencesSaving}
            onPress={() => {
              void setBalanceHidden(!balanceHidden);
            }}
            style={({ pressed }) => [
              styles.balanceToggle,
              pressed && ui.pressed,
              (!preferencesReady || preferencesSaving) && ui.disabled,
            ]}
            testID="toggle-home-balance"
          >
            <AppIcon name={balanceHidden ? 'eye' : 'eyeoff'} size={20} />
            <Text style={styles.balanceToggleText}>{balanceHidden ? 'Show' : 'Hide'}</Text>
          </Pressable>
        </View>
        <Text
          selectable={!balanceHidden}
          accessibilityLabel={balanceHidden ? 'Wallet balance hidden' : undefined}
          testID="wallet-balance"
          style={styles.balance}
        >
          {balanceHidden ? '••••••' : money(summary.balance)}
        </Text>
        <Text style={ui.hint}>
          {balanceHidden
            ? 'Only this balance is hidden. Transactions and reports stay visible.'
            : 'Across all recorded dates'}
        </Text>
        <FormError message={preferenceError} testID="balance-preference-error" />
        {!preferencesReady && preferenceError ? (
          <View style={ui.smallGap}>
            <Action
              label="Retry display preferences"
              secondary
              onPress={() => {
                void retryPreferences();
              }}
              testID="balance-preference-retry"
            />
          </View>
        ) : null}
      </View>
      {receiptTools}

      <View style={styles.sectionHeader}>
        <Text style={ui.heading} accessibilityRole="header">
          Transactions
        </Text>
        <Text style={ui.hint}>
          {transactions.length} {transactions.length === 1 ? 'entry' : 'entries'}
        </Text>
      </View>
      <View
        style={styles.segmented}
        accessibilityRole="tablist"
        accessibilityLabel="Activity period"
      >
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: allTime }}
          onPress={() => setAllTime(true)}
          testID="period-all-time"
          style={({ pressed }) => [
            styles.segment,
            allTime && styles.selectedSegment,
            pressed && ui.pressed,
          ]}
        >
          <Text style={[styles.segmentText, allTime && styles.selectedSegmentText]}>All time</Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: !allTime }}
          onPress={() => setAllTime(false)}
          testID="period-by-month"
          style={({ pressed }) => [
            styles.segment,
            !allTime && styles.selectedSegment,
            pressed && ui.pressed,
          ]}
        >
          <Text style={[styles.segmentText, !allTime && styles.selectedSegmentText]}>By month</Text>
        </Pressable>
      </View>
      {!allTime ? (
        <View style={[ui.between, styles.monthBar]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            accessibilityState={{ disabled: month === firstMonth }}
            disabled={month === firstMonth}
            onPress={() => setMonth((current) => shiftMonth(current, -1))}
            style={({ pressed }) => [
              styles.monthButton,
              pressed && ui.pressed,
              month === firstMonth && ui.disabled,
            ]}
            testID="previous-month"
          >
            <View style={{ transform: [{ rotate: '180deg' }] }}>
              <AppIcon name="chevron" size={20} color={colors.accent} />
            </View>
          </Pressable>
          <Text style={styles.monthText} accessibilityLiveRegion="polite" testID="selected-month">
            {monthLabel(month)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next month"
            accessibilityState={{ disabled: month === lastMonth }}
            disabled={month === lastMonth}
            onPress={() => setMonth((current) => shiftMonth(current, 1))}
            style={({ pressed }) => [
              styles.monthButton,
              pressed && ui.pressed,
              month === lastMonth && ui.disabled,
            ]}
            testID="next-month"
          >
            <AppIcon name="chevron" size={20} color={colors.accent} />
          </Pressable>
        </View>
      ) : null}

      <View style={styles.activity}>
        <Text style={[ui.hint, { marginBottom: 14 }]} accessibilityRole="header">
          {allTime ? 'All-time activity' : `${monthLabel(month)} activity`}
        </Text>
        <View style={styles.summaryGrid}>
          <View style={styles.summaryCell}>
            <Text style={ui.hint}>Income</Text>
            <Text
              selectable
              style={[styles.summaryValue, { color: colors.green }]}
              testID="income-total"
            >
              {money(activity.income)}
            </Text>
          </View>
          <View style={styles.summaryCell}>
            <Text style={ui.hint}>Expenses</Text>
            <Text selectable style={styles.summaryValue} testID="expense-total">
              {money(activity.expense)}
            </Text>
          </View>
          <View style={styles.summaryCell}>
            <Text style={ui.hint}>Debt payments</Text>
            <Text selectable style={styles.summaryValue} testID="debt-total">
              {money(activity.debt)}
            </Text>
          </View>
          <View style={styles.summaryCell}>
            <Text style={ui.hint}>Net change</Text>
            <Text selectable style={styles.summaryValue} testID="period-net">
              {money(activity.balance)}
            </Text>
          </View>
        </View>
        {!allTime ? (
          <Text style={[ui.hint, { marginTop: 12 }]}>
            This month only. Wallet balance includes all dates.
          </Text>
        ) : null}
      </View>
      {transactions.length > 0 ? (
        <Text style={styles.listHint}>Tap an entry to edit or delete.</Text>
      ) : null}
      <View style={styles.list}>
        {transactions.length === 0 ? (
          <View style={{ padding: 22 }}>
            <Text style={ui.heading}>
              {allTime ? 'Ready for your first entry' : 'No entries this month'}
            </Text>
            <Text style={[ui.body, ui.smallGap]}>
              {allTime
                ? 'Add income, an expense, or a debt payment to start tracking this wallet.'
                : 'Choose another month, show all time, or add a transaction dated in this month.'}
            </Text>
          </View>
        ) : (
          transactions.map((transaction, index) => {
            const category = categoryForTransaction(ledger, transaction);
            return (
              <View key={transaction.id} style={index > 0 ? styles.transactionBorder : undefined}>
                <Pressable
                  testID={`transaction-${transaction.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${transaction.title}, ${typeLabels[transaction.type]}, ${money(transaction.amountMinor)}, ${displayDate(transaction.date)}. Edit transaction.`}
                  onPress={() => onEdit(transaction)}
                  style={({ pressed }) => [styles.transaction, pressed && ui.pressed]}
                >
                  <View
                    style={[styles.typeBadge, transaction.type === 'income' && styles.incomeBadge]}
                  >
                    <AppIcon
                      name={transaction.type === 'income' ? 'arrowdown' : 'arrowup'}
                      size={18}
                      color={transaction.type === 'income' ? colors.green : colors.text}
                    />
                  </View>
                  <View style={[styles.transactionContent, roomyRows && styles.roomyContent]}>
                    <View style={[styles.transactionInfo, roomyRows && styles.roomyInfo]}>
                      <Text style={styles.transactionTitle}>{transaction.title}</Text>
                      <Text style={styles.transactionCategory}>{category.name}</Text>
                      <Text style={styles.transactionDate}>{displayDate(transaction.date)}</Text>
                    </View>
                    <View style={[styles.amountColumn, roomyRows && styles.roomyAmount]}>
                      <Text
                        style={[
                          styles.transactionAmount,
                          transaction.type === 'income' && { color: colors.green },
                        ]}
                      >
                        {transaction.type === 'income' ? '+' : '−'}
                        {money(transaction.amountMinor)}
                      </Text>
                      <Text style={styles.transactionDate}>{typeLabels[transaction.type]}</Text>
                    </View>
                  </View>
                </Pressable>
                {onShare ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Details and share options for ${transaction.title}`}
                    onPress={() => onShare(transaction)}
                    testID={`share-transaction-${transaction.id}`}
                    style={({ pressed }) => [styles.shareAction, pressed && ui.pressed]}
                  >
                    <Text style={styles.shareLabel}>Details & share</Text>
                    <AppIcon name="chevron" size={16} color={colors.accent} />
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
      </View>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    titleRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    balanceSurface: {
      backgroundColor: colors.surface,
      borderRadius: 22,
      borderCurve: 'continuous',
      padding: 18,
      marginTop: 18,
    },
    walletHeading: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
    walletName: { flex: 1, color: colors.muted, fontSize: 15, lineHeight: 21, fontWeight: '500' },
    balanceToggle: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 8,
    },
    balanceToggleText: { color: colors.accent, fontSize: 14, lineHeight: 20, fontWeight: '500' },
    balanceLabel: { color: colors.muted, fontSize: 15, lineHeight: 21 },
    balance: {
      color: colors.text,
      fontSize: 38,
      lineHeight: 46,
      fontWeight: '600',
      letterSpacing: -1.2,
      marginTop: 4,
      marginBottom: 9,
      fontVariant: ['tabular-nums'],
    },
    addAction: {
      minHeight: 48,
      minWidth: 88,
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 14,
      backgroundColor: colors.accentFill,
    },
    addLabel: { color: colors.onAccent, fontSize: 16, lineHeight: 22, fontWeight: '600' },
    sectionHeader: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 8,
      marginTop: 28,
      marginBottom: 12,
    },
    segmented: {
      flexDirection: 'row',
      padding: 3,
      gap: 3,
      borderRadius: 13,
      backgroundColor: colors.raised,
    },
    segment: {
      flex: 1,
      minHeight: 48,
      paddingHorizontal: 10,
      paddingVertical: 12,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 10,
    },
    selectedSegment: {
      backgroundColor: colors.surface,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 2,
      elevation: 1,
    },
    segmentText: {
      color: colors.muted,
      fontSize: 15,
      lineHeight: 21,
      fontWeight: '600',
      textAlign: 'center',
    },
    selectedSegmentText: { color: colors.text },
    monthBar: { marginTop: 12, backgroundColor: colors.surface, borderRadius: 13 },
    monthButton: { width: 50, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    monthText: {
      flex: 1,
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
      textAlign: 'center',
    },
    activity: {
      marginTop: 16,
      padding: 18,
      borderRadius: 18,
      borderCurve: 'continuous',
      backgroundColor: colors.surface,
    },
    summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 16, columnGap: 12 },
    summaryCell: { flexGrow: 1, flexBasis: '44%', minWidth: 120 },
    summaryValue: {
      color: colors.text,
      fontSize: 18,
      lineHeight: 24,
      fontWeight: '600',
      marginTop: 4,
      fontVariant: ['tabular-nums'],
    },
    listHint: {
      color: colors.muted,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 20,
      marginBottom: 10,
    },
    list: {
      borderRadius: 18,
      backgroundColor: colors.surface,
      overflow: 'hidden',
      borderCurve: 'continuous',
    },
    transaction: {
      flexDirection: 'row',
      gap: 12,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 10,
      alignItems: 'flex-start',
      minHeight: 80,
    },
    transactionBorder: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.separator,
    },
    transactionContent: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    roomyContent: { flexDirection: 'column', gap: 8 },
    transactionInfo: { flex: 1, minWidth: 0 },
    roomyInfo: { flex: 0, alignSelf: 'stretch' },
    typeBadge: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: colors.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    incomeBadge: { backgroundColor: colors.greenSoft },
    transactionTitle: { color: colors.text, fontWeight: '600', fontSize: 16, lineHeight: 22 },
    transactionCategory: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 3 },
    transactionDate: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 2 },
    amountColumn: { alignItems: 'flex-end', flexShrink: 1, maxWidth: '47%' },
    roomyAmount: { alignSelf: 'stretch', maxWidth: '100%' },
    transactionAmount: {
      color: colors.text,
      fontSize: 16,
      lineHeight: 22,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
      textAlign: 'right',
    },
    shareAction: {
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: 6,
    },
    shareLabel: {
      color: colors.accent,
      fontSize: 13,
      lineHeight: 19,
      fontWeight: '500',
      flexShrink: 1,
      textAlign: 'right',
    },
  });

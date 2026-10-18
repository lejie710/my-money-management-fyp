import React, { useMemo, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatMoney, Ledger, localDate, periodBounds, TransactionType } from '../core/model';
import { periodReport } from '../core/reports';
import { Action, Choice, Field, FormError, RowAction, Screen } from './components';
import { displayDate } from './TransactionsScreen';
import { colors, ui } from './theme';
import { HealthPanel } from './HealthPanel';
import { ForecastEntry } from './ForecastEntry';

const firstMonth = '1900-01';
const lastMonth = '2100-12';
const monthNames = [
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
const categoryTypes: { type: TransactionType; label: string; noun: string }[] = [
  { type: 'expense', label: 'Expenses', noun: 'expenses' },
  { type: 'income', label: 'Income', noun: 'income' },
  { type: 'debt', label: 'Debt payments', noun: 'debt payments' },
];

function boundedMonth(value: string) {
  const year = Number(value.split('-')[0]);
  if (year < 1900) return firstMonth;
  if (year > 2100) return lastMonth;
  return value;
}
function shiftMonth(value: string, change: number) {
  const [year, month] = value.split('-').map(Number);
  return boundedMonth(localDate(new Date(year, month - 1 + change, 1)).slice(0, 7));
}
function monthTitle(month: string) {
  return `${monthNames[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}

function MoneyRow({
  label,
  amount,
  hint,
  testID,
  emphasize = false,
  negative = false,
}: {
  label: string;
  amount: string;
  hint?: string;
  testID: string;
  emphasize?: boolean;
  negative?: boolean;
}) {
  return (
    <View style={styles.moneyRow}>
      <View style={styles.rowLabel}>
        <Text style={[styles.rowTitle, emphasize && styles.bold]}>{label}</Text>
        {hint ? <Text style={[ui.hint, { marginTop: 4 }]}>{hint}</Text> : null}
      </View>
      <Text
        selectable
        style={[
          styles.rowAmount,
          emphasize && styles.emphasizedAmount,
          negative && { color: colors.red },
        ]}
        testID={testID}
      >
        {amount}
      </Text>
    </View>
  );
}

function RatioRow({
  title,
  ratio,
  formula,
  testID,
}: {
  title: string;
  ratio: number | null;
  formula: string;
  testID: string;
}) {
  return (
    <View style={styles.ratioRow}>
      <View style={ui.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={[ui.hint, { marginTop: 4 }]}>{formula}</Text>
      </View>
      <Text
        selectable
        style={[styles.ratioValue, ratio !== null && ratio < 0 && { color: colors.red }]}
        testID={testID}
      >
        {ratio === null ? 'Unavailable' : `${(ratio * 100).toFixed(1)}%`}
      </Text>
    </View>
  );
}

export function ReportsScreen({
  ledger,
  forecastOwnerKey,
  getForecastToday,
  onExport,
  onAssistant,
  showAssistantShortcut = true,
  assistantRequested = false,
}: {
  ledger: Ledger;
  forecastOwnerKey: string;
  getForecastToday: () => string;
  onExport?: (range: { startDate: string; endDate: string }) => void;
  onAssistant?: (range: { startDate: string; endDate: string }) => void;
  showAssistantShortcut?: boolean;
  assistantRequested?: boolean;
}) {
  const [month, setMonth] = useState(() => boundedMonth(localDate().slice(0, 7)));
  const [mode, setMode] = useState<'month' | 'custom'>('month');
  const [applied, setApplied] = useState(() => periodBounds('month', `${month}-01`));
  const [startDraft, setStartDraft] = useState(applied.startDate);
  const [endDraft, setEndDraft] = useState(applied.endDate);
  const [rangeError, setRangeError] = useState('');
  const [categoryType, setCategoryType] = useState<TransactionType>('expense');
  const report = useMemo(
    () => periodReport(ledger, applied.startDate, applied.endDate),
    [ledger, applied.startDate, applied.endDate],
  );
  const money = (amount: number) => formatMoney(amount, ledger.wallet.currency);
  const categoryRows = report.categoryBreakdown.filter((item) => item.type === categoryType);
  const categoryLabel = categoryTypes.find((item) => item.type === categoryType)!;
  const categoryTotal =
    categoryType === 'income'
      ? report.incomeMinor
      : categoryType === 'expense'
        ? report.expenseMinor
        : report.debtMinor;
  const rangeChanged =
    startDraft.trim() !== applied.startDate || endDraft.trim() !== applied.endDate;

  const selectMonth = (nextMonth: string) => {
    const bounded = boundedMonth(nextMonth);
    const range = periodBounds('month', `${bounded}-01`);
    setMonth(bounded);
    setApplied(range);
    setStartDraft(range.startDate);
    setEndDraft(range.endDate);
    setRangeError('');
  };
  const applyCustom = () => {
    const next = { startDate: startDraft.trim(), endDate: endDraft.trim() };
    try {
      periodReport(ledger, next.startDate, next.endDate);
      setApplied(next);
      setStartDraft(next.startDate);
      setEndDraft(next.endDate);
      setRangeError('');
      Keyboard.dismiss();
    } catch (cause) {
      setRangeError(
        cause instanceof Error
          ? cause.message
          : 'Enter a valid date range. The displayed report is unchanged.',
      );
    }
  };

  return (
    <Screen>
      <Text style={ui.title} accessibilityRole="header">
        Reports
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Understand what came in, what went out, and what changed.
      </Text>
      <View style={[ui.row, ui.gap, { flexWrap: 'wrap' }]}>
        <Choice
          label="Month"
          selected={mode === 'month'}
          testID="report-period-month"
          onPress={() => {
            if (mode === 'month') return;
            setMode('month');
            selectMonth(month);
          }}
        />
        <Choice
          label="Custom range"
          selected={mode === 'custom'}
          testID="report-period-custom"
          onPress={() => {
            if (mode === 'custom') return;
            setMode('custom');
            setStartDraft(applied.startDate);
            setEndDraft(applied.endDate);
            setRangeError('');
          }}
        />
      </View>
      {mode === 'month' ? (
        <View style={[styles.monthBar, ui.smallGap]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous report month"
            accessibilityState={{ disabled: month === firstMonth }}
            disabled={month === firstMonth}
            testID="report-previous-month"
            onPress={() => selectMonth(shiftMonth(month, -1))}
            style={({ pressed }) => [
              styles.monthButton,
              pressed && ui.pressed,
              month === firstMonth && ui.disabled,
            ]}
          >
            <Text style={styles.arrow}>‹</Text>
          </Pressable>
          <Text style={styles.monthTitle} accessibilityLiveRegion="polite">
            {monthTitle(month)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next report month"
            accessibilityState={{ disabled: month === lastMonth }}
            disabled={month === lastMonth}
            testID="report-next-month"
            onPress={() => selectMonth(shiftMonth(month, 1))}
            style={({ pressed }) => [
              styles.monthButton,
              pressed && ui.pressed,
              month === lastMonth && ui.disabled,
            ]}
          >
            <Text style={styles.arrow}>›</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[ui.card, ui.smallGap]}>
          <Field
            label="Start date (YYYY-MM-DD)"
            testID="report-start-input"
            value={startDraft}
            maxLength={10}
            autoCorrect={false}
            autoCapitalize="none"
            onChangeText={(value) => {
              setStartDraft(value);
              setRangeError('');
            }}
          />
          <Field
            label="End date (YYYY-MM-DD)"
            testID="report-end-input"
            value={endDraft}
            maxLength={10}
            autoCorrect={false}
            autoCapitalize="none"
            onChangeText={(value) => {
              setEndDraft(value);
              setRangeError('');
            }}
            hint="Both dates are included. Use dates between 1900 and 2100."
          />
          <FormError message={rangeError} testID="report-range-error" />
          <View style={ui.gap}>
            <Action label="Apply date range" onPress={applyCustom} testID="apply-report-range" />
          </View>
          {rangeChanged ? (
            <Text style={[ui.hint, ui.smallGap]}>
              Apply the new dates to update the report. The range shown below is still active.
            </Text>
          ) : null}
        </View>
      )}

      <Text
        selectable
        style={[styles.appliedRange, ui.gap]}
        accessibilityLiveRegion="polite"
        testID="report-period"
      >
        Showing {displayDate(report.startDate)} – {displayDate(report.endDate)}
      </Text>
      <Text style={[ui.hint, { marginTop: 5 }]}>
        {report.transactionCount} recorded {report.transactionCount === 1 ? 'entry' : 'entries'} •
        Both dates included
      </Text>
      {!report.hasActivity ? (
        <View style={styles.emptyNotice} testID="report-empty">
          <Text style={ui.heading}>No recorded movement in this period</Text>
          <Text style={[ui.body, ui.smallGap]}>
            Earlier entries can still contribute to the opening and closing balances.
          </Text>
        </View>
      ) : null}

      <View style={[ui.card, ui.gap]}>
        <Text style={ui.heading} accessibilityRole="header">
          Period balances
        </Text>
        <MoneyRow
          label="Opening balance"
          hint={`Before ${displayDate(report.startDate)}`}
          amount={money(report.openingMinor)}
          testID="report-opening"
        />
        <View style={styles.rule} />
        <MoneyRow
          label="Closing balance"
          hint={`Through ${displayDate(report.endDate)}`}
          amount={money(report.closingMinor)}
          testID="report-closing"
          emphasize
        />
        <Text style={[ui.hint, ui.smallGap]}>Closing balance = opening balance + net change.</Text>
        <View style={ui.divider}>
          <Text style={ui.hint}>Wallet balance across all recorded dates</Text>
          <Text
            selectable
            style={[styles.currentBalance, ui.smallGap]}
            testID="report-wallet-balance"
          >
            {money(report.currentBalanceMinor)}
          </Text>
          <Text style={[ui.hint, { marginTop: 6 }]}>
            This includes entries outside the report, including any later dates.
          </Text>
        </View>
      </View>

      <View style={[ui.card, ui.gap]}>
        <Text style={ui.heading} accessibilityRole="header">
          Money movement
        </Text>
        <MoneyRow label="Income" amount={money(report.incomeMinor)} testID="report-income" />
        <MoneyRow label="Expenses" amount={money(report.expenseMinor)} testID="report-expense" />
        <MoneyRow label="Debt payments" amount={money(report.debtMinor)} testID="report-debt" />
        <View style={styles.rule} />
        <MoneyRow
          label="Total outflow"
          hint="Expenses + debt payments"
          amount={money(report.outflowMinor)}
          testID="report-outflow"
        />
        <MoneyRow
          label="Net change"
          hint="Income − total outflow"
          amount={money(report.netMinor)}
          testID="report-net"
          emphasize
          negative={report.netMinor < 0}
        />
      </View>

      {onExport || (onAssistant && showAssistantShortcut) ? (
        <View style={ui.gap}>
          <Text style={ui.heading} accessibilityRole="header">
            Use this report
          </Text>
          <View style={[styles.toolGroup, ui.smallGap]}>
            {onExport ? (
              <RowAction
                icon="reports"
                label="Export applied report"
                detail="Review a PDF of the displayed period."
                onPress={() => onExport({ startDate: applied.startDate, endDate: applied.endDate })}
                testID="export-report"
                last={!onAssistant || !showAssistantShortcut}
              />
            ) : null}
            {onAssistant && showAssistantShortcut ? (
              <RowAction
                icon="activity"
                label="Ask about this period"
                detail="Choose facts for a read-only local explanation."
                testID="open-report-assistant"
                onPress={() =>
                  onAssistant({ startDate: applied.startDate, endDate: applied.endDate })
                }
                last
              />
            ) : null}
          </View>
          {assistantRequested ? (
            <Text style={[ui.hint, ui.smallGap]} testID="report-assistant-guidance">
              Choose the period above, then Ask about this period. You can review its calculated
              facts even when the local model is unavailable.
            </Text>
          ) : null}
          {mode === 'custom' && rangeChanged ? (
            <Text style={[ui.hint, ui.smallGap]}>
              These actions use the displayed report. Apply your date edits to use a different
              range.
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={[ui.divider, { marginTop: 28 }]}>
        <Text style={ui.heading} accessibilityRole="header">
          Category breakdown
        </Text>
        <View style={[ui.row, ui.smallGap, { flexWrap: 'wrap', gap: 8 }]}>
          {categoryTypes.map((item) => (
            <Choice
              key={item.type}
              label={item.label}
              selected={categoryType === item.type}
              testID={`report-category-filter-${item.type}`}
              onPress={() => setCategoryType(item.type)}
            />
          ))}
        </View>
        <Text selectable style={[ui.body, ui.smallGap]} testID="report-category-denominator">
          Percentages use {money(categoryTotal)} of {categoryLabel.noun} in this period.
        </Text>
        {categoryRows.length === 0 ? (
          <Text style={[ui.body, ui.gap]} testID="report-categories-empty">
            No {categoryLabel.noun} recorded in this period.
          </Text>
        ) : (
          categoryRows.map((item) => (
            <View style={styles.categoryRow} key={item.categoryId}>
              <View style={ui.between}>
                <Text style={[styles.categoryName, ui.flex]}>{item.categoryName}</Text>
                <Text
                  selectable
                  style={styles.categoryAmount}
                  testID={`report-category-${item.categoryId}-amount`}
                >
                  {money(item.amountMinor)}
                </Text>
              </View>
              <View
                style={styles.barTrack}
                accessibilityRole="progressbar"
                accessibilityLabel={`${item.categoryName}: ${(item.shareOfType * 100).toFixed(1)} percent of ${categoryLabel.noun}`}
                accessibilityValue={{ min: 0, max: 100, now: item.shareOfType * 100 }}
              >
                <View
                  style={[
                    styles.barFill,
                    {
                      width: `${item.shareOfType * 100}%`,
                      backgroundColor:
                        categoryType === 'income'
                          ? colors.green
                          : categoryType === 'debt'
                            ? colors.red
                            : colors.purple,
                    },
                  ]}
                />
              </View>
              <Text selectable style={ui.hint} testID={`report-category-${item.categoryId}-share`}>
                {(item.shareOfType * 100).toFixed(1)}% of {categoryLabel.noun} •{' '}
                {item.transactionCount} {item.transactionCount === 1 ? 'entry' : 'entries'}
              </Text>
            </View>
          ))
        )}
      </View>

      <View style={[ui.card, { marginTop: 28 }]}>
        <Text style={ui.heading} accessibilityRole="header">
          Recorded cash flow
        </Text>
        <Text style={[ui.hint, ui.smallGap]}>
          Ratios describe this period's recorded entries. They are not a financial-health score.
        </Text>
        <RatioRow
          title="Net retained"
          formula="Net change ÷ income"
          ratio={report.ratios.retainedNetToIncome}
          testID="report-net-ratio"
        />
        <RatioRow
          title="Expense share"
          formula="Expenses ÷ income"
          ratio={report.ratios.expenseToIncome}
          testID="report-expense-ratio"
        />
        <RatioRow
          title="Debt-payment share"
          formula="Debt payments ÷ income"
          ratio={report.ratios.debtToIncome}
          testID="report-debt-ratio"
        />
        {report.incomeMinor === 0 ? (
          <Text style={[ui.hint, ui.smallGap]}>
            Ratios are unavailable because no income was recorded in this period.
          </Text>
        ) : (
          <Text style={[ui.hint, ui.smallGap]}>
            A negative net ratio means recorded outflow exceeded income. Expense or debt-payment
            shares can exceed 100%.
          </Text>
        )}
      </View>
      <HealthPanel report={report} goal={ledger.goal} />
      <ForecastEntry ledger={ledger} ownerKey={forecastOwnerKey} getToday={getForecastToday} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  monthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 16,
  },
  monthButton: { minHeight: 48, width: 50, alignItems: 'center', justifyContent: 'center' },
  arrow: { color: colors.purple, fontSize: 30 },
  monthTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    lineHeight: 23,
    fontWeight: '600',
    textAlign: 'center',
  },
  appliedRange: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
  emptyNotice: {
    marginTop: 20,
    padding: 18,
    borderRadius: 16,
    backgroundColor: colors.accentSoft,
  },
  toolGroup: { backgroundColor: colors.surface, borderRadius: 20, overflow: 'hidden' },
  moneyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 18 },
  rowLabel: { flexGrow: 1, flexShrink: 1, flexBasis: '43%' },
  rowTitle: { color: colors.text, fontSize: 15, lineHeight: 22 },
  rowAmount: {
    flexShrink: 1,
    maxWidth: '100%',
    marginLeft: 'auto',
    color: colors.text,
    fontSize: 17,
    lineHeight: 25,
    fontWeight: '500',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  bold: { fontWeight: '700' },
  emphasizedAmount: { fontWeight: '600', fontSize: 24, lineHeight: 32, letterSpacing: -0.5 },
  rule: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 18 },
  currentBalance: {
    color: colors.muted,
    fontSize: 18,
    lineHeight: 26,
    fontVariant: ['tabular-nums'],
  },
  categoryRow: { marginTop: 22 },
  categoryName: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
  categoryAmount: {
    maxWidth: '48%',
    color: colors.text,
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.raised,
    marginVertical: 10,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 3 },
  ratioRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 20 },
  ratioValue: {
    maxWidth: '47%',
    color: colors.text,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
});

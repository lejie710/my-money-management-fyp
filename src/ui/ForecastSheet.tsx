import React, { useMemo, useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { Currency, formatMoney, Ledger } from '../core/model';
import { ExpenseForecast, forecastRecordedExpenses, FORECAST_METHODS } from '../core/forecast';
import { Action, Choice, Field, FormError, Sheet } from './components';
import { useThemedStyles, type ThemeColors } from './theme';
import { useProphetForecast } from './useProphetForecast';
import type { ForecastTransportBinding } from '../forecast/client';

const CATEGORY_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 12;
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
const monthTitle = (value: string) =>
  `${months[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`;
const lastHistoryPage = (result: ExpenseForecast) =>
  Math.max(0, Math.ceil(result.history.length / HISTORY_PAGE_SIZE) - 1);

// Only fields that can change this target are compared; notes, photos, income and debt stay private.
function sourceKey(ledger: Ledger) {
  return JSON.stringify({
    currency: ledger.wallet.currency,
    mode: ledger.mode,
    walletName: ledger.wallet.name,
    categories: ledger.categories
      .filter((row) => row.type === 'expense')
      .map((row) => [row.id, row.name]),
    expenses: ledger.transactions
      .filter((row) => row.type === 'expense')
      .map((row) => [row.id, row.categoryId, row.date, row.amountMinor]),
  });
}
type Applied = {
  result: ExpenseForecast;
  source: string;
  mode: Ledger['mode'];
  walletName: string;
};
function calculate(ledger: Ledger, date: string, categoryId: string | null): Applied {
  return {
    result: forecastRecordedExpenses(ledger, {
      asOfDate: date.trim(),
      categoryId,
      horizon: 6,
    }),
    source: sourceKey(ledger),
    mode: ledger.mode,
    walletName: ledger.wallet.name,
  };
}
function initial(ledger: Ledger, date: string): { applied: Applied | null; error: string } {
  try {
    return { applied: calculate(ledger, date, null), error: '' };
  } catch (cause) {
    return {
      applied: null,
      error: cause instanceof Error ? cause.message : 'Enter a supported as-of date.',
    };
  }
}
function displayMae(amount: number, currency: Currency) {
  // MAE is an average of integer errors, so it can contain fractional minor units.
  return formatMoney(Math.round(amount), currency);
}
function AmountRow({
  label,
  amount,
  hint,
  testID,
  tone = 'history',
}: {
  label: string;
  amount: string;
  hint?: string;
  testID: string;
  tone?: 'history' | 'forecast' | 'partial';
}) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  return (
    <View style={styles.amountRow}>
      <View style={styles.rowHeading}>
        <Text style={styles.label}>{label}</Text>
        <Text
          selectable
          testID={testID}
          style={[
            styles.amount,
            tone === 'forecast' && styles.projected,
            tone === 'partial' && styles.partial,
          ]}
        >
          {amount}
        </Text>
      </View>
      {hint ? (
        <Text selectable style={ui.hint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function ForecastSheet({
  ledger,
  initialAsOfDate,
  ownerKey = '',
  transportBinding,
  onClose,
}: {
  ledger: Ledger;
  initialAsOfDate: string;
  ownerKey?: string;
  transportBinding?: ForecastTransportBinding | null;
  onClose: () => void;
}) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  const cloudProphet = transportBinding?.provider.processing === 'cloud';
  const [first] = useState(() => initial(ledger, initialAsOfDate));
  const [applied, setApplied] = useState<Applied | null>(first.applied);
  const [date, setDate] = useState(initialAsOfDate);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [categoryPage, setCategoryPage] = useState(0);
  const [historyPage, setHistoryPage] = useState(() =>
    first.applied ? lastHistoryPage(first.applied.result) : 0,
  );
  const [error, setError] = useState(first.error);
  const [message, setMessage] = useState('');
  const liveSource = useMemo(() => sourceKey(ledger), [ledger]);
  const categories = ledger.categories.filter((row) => row.type === 'expense');
  const matching = categories.filter((row) =>
    row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const categoryPages = Math.max(1, Math.ceil(matching.length / CATEGORY_PAGE_SIZE));
  const currentCategoryPage = Math.min(categoryPage, categoryPages - 1);
  const visibleCategories = matching.slice(
    currentCategoryPage * CATEGORY_PAGE_SIZE,
    (currentCategoryPage + 1) * CATEGORY_PAGE_SIZE,
  );
  const missingCategory = categoryId !== null && !categories.some((row) => row.id === categoryId);
  const changed =
    applied !== null &&
    (date.trim() !== applied.result.asOfDate || categoryId !== applied.result.filter.categoryId);
  const sourceChanged = applied !== null && applied.source !== liveSource;
  const result = applied?.result ?? null;
  const prophet = useProphetForecast({
    result,
    ownerKey,
    changed: changed || sourceChanged,
    binding: transportBinding,
  });
  const historyPages = result
    ? Math.max(1, Math.ceil(result.history.length / HISTORY_PAGE_SIZE))
    : 1;
  const currentHistoryPage = Math.min(historyPage, historyPages - 1);
  const historyRows =
    result?.history.slice(
      currentHistoryPage * HISTORY_PAGE_SIZE,
      (currentHistoryPage + 1) * HISTORY_PAGE_SIZE,
    ) ?? [];
  const apply = (refresh = false) => {
    prophet.cancel();
    try {
      const requestedDate = refresh && applied ? applied.result.asOfDate : date.trim();
      const requestedCategory = refresh && applied ? applied.result.filter.categoryId : categoryId;
      const next = calculate(ledger, requestedDate, requestedCategory);
      setApplied(next);
      setHistoryPage(lastHistoryPage(next.result));
      if (!refresh) setDate(requestedDate);
      setError('');
      setMessage(
        refresh
          ? 'The applied forecast now uses the latest recorded expenses.'
          : 'Date and category applied. Your recorded data is unchanged.',
      );
      Keyboard.dismiss();
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : 'The forecast could not be calculated.'} ${applied ? 'The previous applied result is unchanged.' : 'No prediction rows were generated.'}`,
      );
    }
  };

  return (
    <Sheet
      title="Forecast of recorded expenses"
      onClose={() => {
        prophet.cancel();
        onClose();
      }}
    >
      <Text style={[ui.body, ui.smallGap]}>
        Uses expense entries, including receipt expenses. Income and debt payments do not enter
        these projections. Configured Prophet analyses selected monthly totals. The device estimate
        is also available offline. Neither creates transactions.
      </Text>
      <Field
        label="As-of date"
        value={date}
        onChangeText={(value) => {
          if (value !== date) prophet.cancel();
          setDate(value);
          setError('');
        }}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        autoCapitalize="none"
        autoCorrect={false}
        testID="forecast-as-of-input"
        hint="The entire as-of month is excluded from training. Forecasts start in the following month."
      />
      <Text style={ui.fieldLabel}>Expense category</Text>
      <Choice
        label="All expense categories"
        selected={categoryId === null}
        onPress={() => {
          if (categoryId !== null) prophet.cancel();
          setCategoryId(null);
          setError('');
        }}
        testID="forecast-category-all"
      />
      <Field
        label="Find an expense category"
        value={query}
        onChangeText={(value) => {
          setQuery(value);
          setCategoryPage(0);
        }}
        maxLength={40}
        autoCapitalize="none"
        autoCorrect={false}
        testID="forecast-category-search"
      />
      <View style={[styles.choices, ui.smallGap]}>
        {visibleCategories.map((category) => (
          <Choice
            key={category.id}
            label={category.name}
            selected={categoryId === category.id}
            onPress={() => {
              if (categoryId !== category.id) prophet.cancel();
              setCategoryId(category.id);
              setError('');
            }}
            testID={`forecast-category-${category.id}`}
          />
        ))}
      </View>
      {matching.length === 0 ? (
        <Text style={[ui.hint, ui.smallGap]} testID="forecast-category-empty">
          No expense categories match this search.
        </Text>
      ) : null}
      {categoryPages > 1 ? (
        <View style={ui.smallGap}>
          <Text style={ui.hint} testID="forecast-category-page">
            Categories {currentCategoryPage * CATEGORY_PAGE_SIZE + 1}–
            {Math.min(matching.length, (currentCategoryPage + 1) * CATEGORY_PAGE_SIZE)} of{' '}
            {matching.length}
          </Text>
          <View style={[styles.navigation, ui.smallGap]}>
            <Action
              label="Previous categories"
              secondary
              disabled={currentCategoryPage === 0}
              onPress={() => setCategoryPage(currentCategoryPage - 1)}
              testID="forecast-category-previous"
            />
            <Action
              label="Next categories"
              secondary
              disabled={currentCategoryPage === categoryPages - 1}
              onPress={() => setCategoryPage(currentCategoryPage + 1)}
              testID="forecast-category-next"
            />
          </View>
        </View>
      ) : null}
      {missingCategory ? (
        <Text style={ui.error} testID="forecast-category-removed">
          The selected category was removed. Choose an existing expense category or All expense
          categories.
        </Text>
      ) : null}
      {changed ? (
        <Text style={[ui.hint, ui.smallGap]} testID="forecast-draft-pending">
          The date or category edit has not been applied. The results below still show the labelled
          applied selection.
        </Text>
      ) : null}
      <View style={ui.gap}>
        <Action label="Apply forecast" onPress={() => apply()} testID="forecast-apply" />
      </View>
      <FormError message={error} testID="forecast-error" />
      {message ? (
        <Text
          selectable
          style={[ui.hint, ui.smallGap]}
          testID="forecast-status"
          accessibilityLiveRegion="polite"
        >
          {message}
        </Text>
      ) : null}
      {sourceChanged ? (
        <View style={[ui.card, ui.gap]}>
          <Text style={ui.body} testID="forecast-source-changed">
            Recorded expenses or their labels changed. The displayed forecast remains the previous
            captured result.
          </Text>
          <View style={ui.smallGap}>
            <Action
              label="Refresh applied forecast"
              secondary
              onPress={() => apply(true)}
              testID="forecast-refresh"
            />
          </View>
        </View>
      ) : null}
      {transportBinding ? (
        <View style={[ui.card, ui.gap]} testID="prophet-panel">
          <Text style={ui.heading} accessibilityRole="header">
            Prophet expense forecast
          </Text>
          <Text style={[ui.body, ui.smallGap]}>
            Request a second method using only the applied currency, dates, and completed monthly
            expense totals. Transaction titles, notes, photos, and account details are not sent.
          </Text>
          {prophet.unavailable ? (
            <Text style={[ui.hint, ui.smallGap]} testID="prophet-unavailable">
              {prophet.unavailable}
            </Text>
          ) : null}
          <Text style={[ui.hint, ui.smallGap]} testID="prophet-processing">
            {cloudProphet
              ? 'When you run Prophet, completed monthly expense totals are sent to your configured backend. Individual entries, notes and photos are excluded.'
              : 'When you run local Prophet, completed monthly expense totals are processed on your connected Windows computer.'}
          </Text>
          <View style={ui.smallGap}>
            <Action
              label={
                prophet.busy
                  ? 'Fitting monthly history…'
                  : cloudProphet
                    ? 'Run Prophet forecast'
                    : 'Run local Prophet'
              }
              disabled={!prophet.canRun}
              onPress={() => {
                void prophet.run();
              }}
              testID="prophet-run"
            />
          </View>
          {prophet.busy ? (
            <View style={ui.smallGap}>
              <Action
                label="Cancel Prophet"
                secondary
                onPress={prophet.cancel}
                testID="prophet-cancel"
              />
            </View>
          ) : null}
          {prophet.message ? (
            <Text
              style={[ui.hint, ui.smallGap]}
              accessibilityLiveRegion="polite"
              testID="prophet-status"
            >
              {prophet.message}
            </Text>
          ) : null}
          {prophet.response ? (
            <View style={ui.smallGap} testID="prophet-result">
              <Text style={ui.body}>
                Prophet · {cloudProphet ? 'configured backend' : 'local Windows'} ·{' '}
                {prophet.response.trainingMonths} completed months through{' '}
                {prophet.response.trainingThroughMonth}
              </Text>
              <Text style={[ui.hint, ui.smallGap]}>
                Linear model with no seasonal components or prediction intervals. The separate
                device estimate and its historical error do not establish Prophet accuracy.
              </Text>
              {prophet.response.hasNegativePredictions ? (
                <Text style={[ui.error, ui.smallGap]} testID="prophet-negative">
                  The model produced negative estimates. They are preserved and labelled model
                  output, not possible recorded expense entries.
                </Text>
              ) : null}
              {prophet.response.forecast.map((row) => (
                <AmountRow
                  key={row.month}
                  label={monthTitle(row.month)}
                  amount={formatMoney(row.predictedMinor, prophet.response!.currency)}
                  hint={`Prophet · lead ${row.lead}. Device: ${formatMoney(result?.forecast.find((value) => value.month === row.month)?.predictedMinor ?? 0, prophet.response!.currency)}`}
                  testID={`prophet-future-${row.month}`}
                  tone="forecast"
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {result && applied ? (
        <>
          <View style={[ui.card, ui.gap]}>
            <Text style={ui.heading} accessibilityRole="header">
              Applied selection
            </Text>
            <Text selectable style={[ui.body, ui.smallGap]} testID="forecast-applied-selection">
              {applied.walletName} · {result.currency}
              {'\n'}As of {result.asOfDate}
              {'\n'}
              {result.filter.kind === 'all' ? 'All expense categories' : result.filter.categoryName}
            </Text>
            {applied.mode === 'sample' ? (
              <Text selectable style={[ui.hint, ui.smallGap]} testID="forecast-sample-label">
                Sample recorded data
              </Text>
            ) : null}
            <Text selectable style={[ui.body, ui.smallGap]} testID="forecast-training-cutoff">
              Training cutoff: {result.trainingCutoff ?? 'No earlier supported complete month'}.
            </Text>
            <Text selectable style={[ui.hint, ui.smallGap]} testID="forecast-history-counts">
              {result.eligibility.completedMonths} completed history months;{' '}
              {result.eligibility.activeMonths} months with recorded expenses. Requires at least 8
              completed months and 3 active months.
            </Text>
            <Text selectable style={[ui.hint, ui.smallGap]} testID="forecast-last-recorded">
              Last expense month through the as-of date:{' '}
              {result.lastRecordedExpenseMonth
                ? monthTitle(result.lastRecordedExpenseMonth)
                : 'none'}
              . Last completed month with an expense:{' '}
              {result.lastTrainingExpenseMonth
                ? monthTitle(result.lastTrainingExpenseMonth)
                : 'none'}
              .
            </Text>
          </View>
          <View style={[ui.card, ui.gap]}>
            <Text style={ui.heading} accessibilityRole="header">
              Excluded partial month
            </Text>
            <AmountRow
              label={monthTitle(result.partialMonth.month)}
              amount={formatMoney(result.partialMonth.expenseMinor, result.currency)}
              hint={`${result.partialMonth.startDate} through ${result.partialMonth.throughDate}; ${result.partialMonth.transactionCount} expense entries.`}
              testID="forecast-partial-amount"
              tone="partial"
            />
            <Text style={ui.hint} testID="forecast-gap-explanation">
              {monthTitle(result.partialMonth.month)} is excluded from fitting, method selection,
              and prediction rows. The first projected month is two calendar months after the last
              complete training month.
            </Text>
          </View>
          {result.status === 'insufficient-history' ? (
            <View style={[ui.card, ui.gap]} testID="forecast-insufficient">
              <Text style={ui.heading} accessibilityRole="header">
                More recorded history is needed
              </Text>
              <Text selectable style={[ui.body, ui.smallGap]}>
                {result.message}
              </Text>
              <Text style={[ui.hint, ui.smallGap]}>
                No prediction rows were generated. Income records do not make expense history
                sufficient.
              </Text>
            </View>
          ) : (
            <>
              <View style={[ui.card, ui.gap]} testID="forecast-future-panel">
                <Text style={ui.heading} accessibilityRole="header">
                  Six future months
                </Text>
                <Text style={[ui.hint, ui.smallGap]}>
                  Projected recorded expenses after the applied as-of month. These amounts are not
                  saved entries.
                </Text>
                {result.forecast.map((row) => (
                  <AmountRow
                    key={row.month}
                    label={monthTitle(row.month)}
                    amount={formatMoney(row.predictedMinor, result.currency)}
                    hint={`Lead ${row.lead} from the final complete training month`}
                    testID={`forecast-future-${row.month}`}
                    tone="forecast"
                  />
                ))}
              </View>
              {result.backtest ? (
                <View style={[ui.card, ui.gap]}>
                  <Text style={ui.heading} accessibilityRole="header">
                    Historical comparison
                  </Text>
                  <Text selectable style={[ui.body, ui.smallGap]} testID="forecast-method">
                    Selected method:{' '}
                    {FORECAST_METHODS.find((method) => method.id === result.selectedMethod)?.label}
                  </Text>
                  <Text selectable style={[ui.hint, ui.smallGap]} testID="forecast-backtest-range">
                    Two-month-ahead MAE · {result.backtest.foldCount} evaluation folds · targets{' '}
                    {monthTitle(result.backtest.firstTargetMonth)} through{' '}
                    {monthTitle(result.backtest.lastTargetMonth)}.
                  </Text>
                  <AmountRow
                    label="Selected method MAE"
                    amount={displayMae(result.backtest.selectedMaeMinor, result.currency)}
                    testID="forecast-selected-mae"
                  />
                  <AmountRow
                    label="Last-value baseline MAE"
                    amount={displayMae(result.backtest.baselineMaeMinor, result.currency)}
                    testID="forecast-baseline-mae"
                  />
                  <Text selectable style={ui.hint} testID="forecast-relative-error">
                    {result.backtest.relativeImprovementPercent === null
                      ? 'Relative error comparison unavailable because the baseline MAE is zero.'
                      : result.backtest.relativeImprovementPercent === 0
                        ? 'The selected method has the same historical error as the last-value baseline.'
                        : `${Math.abs(result.backtest.relativeImprovementPercent).toFixed(1)}% ${result.backtest.relativeImprovementPercent > 0 ? 'lower' : 'higher'} historical error than the last-value baseline.`}
                  </Text>
                  {result.backtest.candidates.map((candidate) => (
                    <AmountRow
                      key={candidate.method}
                      label={`${candidate.label}${candidate.method === result.selectedMethod ? ' (selected)' : ''}`}
                      amount={displayMae(candidate.maeMinor, result.currency)}
                      hint={`${candidate.foldCount} two-month-ahead folds`}
                      testID={`forecast-candidate-${candidate.method}`}
                    />
                  ))}
                  <Text style={[ui.hint, ui.smallGap]}>
                    MAE is the average absolute error on earlier two-month-ahead predictions.
                    Displayed averages are rounded to this currency's smallest unit. These
                    historical errors do not measure all six future months.
                  </Text>
                  <Text style={[ui.hint, ui.smallGap]}>
                    The method comparison prefers the simplest candidate close to the lowest
                    historical error. Each projection is bounded from zero to twice the largest
                    expense month among the latest six training months. This calculation limit is
                    not a confidence interval or a spending ceiling.
                  </Text>
                </View>
              ) : null}
            </>
          )}
          <View style={[ui.card, ui.gap]}>
            <Text style={ui.heading} accessibilityRole="header">
              Completed expense history
            </Text>
            <Text style={[ui.hint, ui.smallGap]}>
              History starts at the first selected expense month. Zero means no expense was recorded
              for that month and filter; it does not prove that no money was spent.
            </Text>
            {result.history.length === 0 ? (
              <Text style={[ui.body, ui.smallGap]} testID="forecast-history-empty">
                No completed expense months are available.
              </Text>
            ) : (
              <>
                <Text selectable style={[ui.hint, ui.smallGap]} testID="forecast-history-page">
                  Months {currentHistoryPage * HISTORY_PAGE_SIZE + 1}–
                  {Math.min(result.history.length, (currentHistoryPage + 1) * HISTORY_PAGE_SIZE)} of{' '}
                  {result.history.length}; {monthTitle(result.history[0].month)} through{' '}
                  {monthTitle(result.history[result.history.length - 1].month)}.
                </Text>
                {historyRows.map((row) => (
                  <AmountRow
                    key={row.month}
                    label={monthTitle(row.month)}
                    amount={formatMoney(row.expenseMinor, result.currency)}
                    hint={
                      row.transactionCount
                        ? `${row.transactionCount} recorded expense entries`
                        : 'No expenses recorded'
                    }
                    testID={`forecast-history-${row.month}`}
                  />
                ))}
                {historyPages > 1 ? (
                  <View style={[styles.navigation, ui.smallGap]}>
                    <Action
                      label="Earlier history"
                      secondary
                      disabled={currentHistoryPage === 0}
                      onPress={() => setHistoryPage(currentHistoryPage - 1)}
                      testID="forecast-history-previous"
                    />
                    <Action
                      label="Later history"
                      secondary
                      disabled={currentHistoryPage === historyPages - 1}
                      onPress={() => setHistoryPage(currentHistoryPage + 1)}
                      testID="forecast-history-next"
                    />
                  </View>
                ) : null}
              </>
            )}
          </View>
          <Text style={[ui.hint, ui.gap]} testID="forecast-scope-note">
            This is a local projection of recorded expenses. Missing transactions and changes in
            spending can alter future results. No forecast-confidence claim or real-world predictive
            validation is implied.
          </Text>
        </>
      ) : null}
    </Sheet>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    navigation: { gap: 8 },
    amountRow: {
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 4,
    },
    rowHeading: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: 8,
    },
    label: { color: colors.text, fontSize: 14, lineHeight: 21, flexShrink: 1 },
    amount: {
      color: colors.text,
      fontSize: 17,
      lineHeight: 25,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
      flexShrink: 1,
    },
    projected: { color: colors.green },
    partial: { color: colors.purple },
  });

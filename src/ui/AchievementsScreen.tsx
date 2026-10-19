import React, { useEffect, useMemo, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import {
  AchievementClock,
  AchievementEvidence,
  completeWeeklyReview,
  evaluateAchievements,
  recordCompletedDay,
  weeklyReviewSummary,
} from '../core/achievements';
import { formatMoney, Ledger, localDate } from '../core/model';
import { Action, Choice, Field, FormError, Screen } from './components';
import { ProgressBar } from './PlanScreen';
import { displayDate } from './TransactionsScreen';
import { useThemedStyles, type ThemeColors } from './theme';
import type { SaveLedger } from './useLedger';

type Props = {
  ledger: Ledger;
  saving: boolean;
  saveError: string;
  onSave: SaveLedger;
  clearSaveError: () => void;
  getClock: () => AchievementClock;
  onBack: () => void;
};
function previousDate(today: string) {
  const [year, month, day] = today.split('-').map(Number);
  return localDate(new Date(year, month - 1, day - 1));
}

function evidenceSummary(evidence: AchievementEvidence, money: (value: number) => string): string {
  switch (evidence.kind) {
    case 'first_budget':
      return 'A category budget was present when this milestone was observed.';
    case 'first_transaction':
      return `A transaction dated ${displayDate(evidence.date)} was recorded.`;
    case 'weekly_saver':
      return `${displayDate(evidence.startDate)}–${displayDate(evidence.endDate)}: ${evidence.transactionCount} entries across seven completed dates, with ${money(evidence.netMinor)} positive net cash flow.`;
    case 'budget_master':
      return `${evidence.month}: ${evidence.budgetCount} monthly budgets, ${evidence.matchedExpenseCount} matching expense entries, and ${money(evidence.totalSpentMinor)} recorded spending within the checked limits.`;
    case 'expense_tracker':
      return `${evidence.expenseCount} expenses across five consecutive dates, ${displayDate(evidence.startDate)}–${displayDate(evidence.endDate)}.`;
    case 'consistent_tracker':
      return `${evidence.transactionCount} entries across seven consecutive dates, ${displayDate(evidence.startDate)}–${displayDate(evidence.endDate)}.`;
    case 'savings_goal_achiever':
      return `Through ${displayDate(evidence.throughDate)}, recorded balance ${money(evidence.balanceMinor)} reached the ${money(evidence.targetMinor)} target.`;
    case 'no_spend_day':
      return `${displayDate(evidence.date)} was explicitly confirmed with no recorded outflow.`;
    case 'category_guru':
      return `${evidence.distinctCategoryCount} distinct category IDs were used through ${displayDate(evidence.throughDate)}. Renaming a category does not add one.`;
    case 'review_expert':
      return `Explicit reviews were recorded in the weeks starting ${evidence.weekStarts.map(displayDate).join(', ')}.`;
  }
}

export function AchievementsScreen({
  ledger,
  saving,
  saveError,
  onSave,
  clearSaveError,
  getClock,
  onBack,
}: Props) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  const [clock, setClock] = useState(getClock);
  const [date, setDate] = useState(() => previousDate(clock.today));
  const [dayError, setDayError] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [actionStatus, setActionStatus] = useState('');
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const [section, setSection] = useState<'badges' | 'check-ins'>('badges');
  useEffect(() => {
    const refresh = () => {
      const next = getClock();
      setClock((current) => (current.today === next.today ? current : next));
    };
    const timer = setInterval(refresh, 60000);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [getClock]);
  const evaluations = useMemo(() => evaluateAchievements(ledger, clock), [ledger, clock]);
  const review = useMemo(() => weeklyReviewSummary(ledger, clock), [ledger, clock]);
  const sample = ledger.mode === 'sample';
  const pendingAwards = !sample && evaluations.some((row) => row.qualified && !row.award);
  const money = (value: number) => formatMoney(value, ledger.wallet.currency);

  const confirmDay = async () => {
    if (saving || sample) return;
    setDayError('');
    clearSaveError();
    try {
      const freshClock = getClock();
      setClock(freshClock);
      const next = recordCompletedDay(ledger, date.trim(), freshClock);
      if (await onSave(next, 'Completed-day confirmation saved. Milestones updated.'))
        setActionStatus(`Confirmed ${displayDate(date.trim())} with no recorded outflow.`);
    } catch (cause) {
      setDayError(cause instanceof Error ? cause.message : 'Check the completed date.');
    }
  };
  const finishReview = async () => {
    if (saving || sample) return;
    setReviewError('');
    clearSaveError();
    try {
      const freshClock = getClock();
      if (freshClock.today !== review.throughDate) {
        setClock(freshClock);
        setReviewError('The day changed. Review the refreshed figures, then confirm again.');
        return;
      }
      setClock(freshClock);
      const next = completeWeeklyReview(ledger, freshClock);
      if (await onSave(next, 'This week’s review was saved. Milestones updated.'))
        setActionStatus('Weekly review saved once for this week.');
    } catch (cause) {
      setReviewError(
        cause instanceof Error ? cause.message : 'The weekly review could not be recorded.',
      );
    }
  };

  return (
    <Screen>
      <View style={{ marginBottom: 18 }}>
        <Action
          label="Back to wallet"
          secondary
          disabled={saving}
          onPress={onBack}
          testID="achievements-back"
        />
      </View>
      <Text style={ui.title} accessibilityRole="header">
        Achievements
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Milestones from recorded activity, not an assessment of your finances.
      </Text>
      {sample ? (
        <View style={[ui.card, ui.gap]} testID="achievements-preview">
          <Text style={ui.heading}>Sample preview</Text>
          <Text style={[ui.body, ui.smallGap]}>
            These rules describe the sample records. They do not earn permanent badges or send
            automatic notices. Choose Wallet → Start fresh to begin a local history.
          </Text>
        </View>
      ) : (
        <Text style={[ui.body, ui.smallGap]}>
          {evaluations.filter((row) => row.award).length} of {evaluations.length} milestones earned.
          Tracking started {displayDate(ledger.wallet.trackingStartedOn)}.
        </Text>
      )}
      <FormError message={saveError} testID="achievements-save-error" />
      <View style={ui.gap}>
        <Action
          label={saving ? 'Checking…' : 'Recheck milestones'}
          secondary
          disabled={saving || sample}
          onPress={() => {
            setClock(getClock());
            clearSaveError();
            void onSave(ledger, 'Milestones checked against your saved records.');
          }}
          testID="recheck-achievements"
        />
      </View>
      <View style={[ui.row, ui.gap, { flexWrap: 'wrap' }]}>
        <Choice
          label="Badges"
          selected={section === 'badges'}
          onPress={() => setSection('badges')}
          testID="achievements-badges"
        />
        <Choice
          label="Check-ins"
          selected={section === 'check-ins'}
          onPress={() => setSection('check-ins')}
          testID="achievements-actions"
        />
      </View>
      {pendingAwards ? (
        <View style={ui.gap}>
          <Text style={ui.body}>
            Some recorded activity qualifies, but its award is not yet saved.
          </Text>
          <View style={ui.smallGap}>
            <Action
              label="Retry milestone save"
              disabled={saving}
              onPress={() => {
                clearSaveError();
                void onSave(ledger, 'Milestone history saved.');
              }}
              testID="retry-achievements"
            />
          </View>
        </View>
      ) : null}
      {section === 'badges'
        ? evaluations.map((row) => (
            <View key={row.id} style={[ui.card, ui.gap]} testID={`achievement-${row.id}`}>
              <Text style={ui.heading}>{row.title}</Text>
              <Text
                style={[styles.status, row.award && { color: colors.green }]}
                testID={`achievement-status-${row.id}`}
              >
                {row.preview
                  ? row.qualified
                    ? 'Preview qualifies'
                    : 'Preview in progress'
                  : row.award
                    ? 'Earned'
                    : row.qualified
                      ? 'Awaiting saved award'
                      : 'In progress'}
              </Text>
              <Text style={[ui.body, ui.smallGap]}>{row.description}</Text>
              {row.progress ? (
                <>
                  <ProgressBar
                    value={row.progress.target > 0 ? row.progress.current / row.progress.target : 0}
                    label={`${row.title} recorded progress`}
                  />
                  <Text selectable style={ui.hint} testID={`achievement-progress-${row.id}`}>
                    {row.progress.current} of {row.progress.target}
                  </Text>
                </>
              ) : null}
              <Text style={[ui.body, ui.smallGap]}>{row.reason}</Text>
              {row.award ? (
                <>
                  <Text selectable style={[ui.hint, ui.smallGap]}>
                    Observed on {displayDate(row.award.earnedOnDate)}.
                  </Text>
                  <View style={ui.smallGap}>
                    <Action
                      label={details[row.id] ? 'Hide award details' : 'Show award details'}
                      secondary
                      onPress={() =>
                        setDetails((current) => ({ ...current, [row.id]: !current[row.id] }))
                      }
                      testID={`achievement-details-${row.id}`}
                    />
                  </View>
                  {details[row.id] ? (
                    <>
                      <Text selectable style={[ui.body, ui.smallGap]}>
                        {evidenceSummary(row.award.evidence, money)}
                      </Text>
                      <Text selectable style={[ui.hint, ui.smallGap]}>
                        Saved {new Date(row.award.earnedAtMs).toLocaleString()}. Rule:{' '}
                        {row.award.ruleVersion}. This historical award is retained if its supporting
                        entries later change.
                      </Text>
                    </>
                  ) : null}
                </>
              ) : null}
            </View>
          ))
        : null}

      {section === 'check-ins' ? (
        <>
          <View style={[ui.card, { marginTop: 28 }]}>
            <Text style={ui.heading} accessibilityRole="header">
              Confirm a no-spend day
            </Text>
            <Text style={[ui.body, ui.smallGap]}>
              Confirm a completed day with no recorded expense or debt payment. Income is allowed.
              An empty record alone does not confirm a day.
            </Text>
            <Text style={[ui.hint, ui.smallGap]}>
              Dates must be before today and on or after the tracking start,{' '}
              {displayDate(ledger.wallet.trackingStartedOn)}.
            </Text>
            <Field
              label="Completed day (YYYY-MM-DD)"
              value={date}
              editable={!saving && !sample}
              testID="no-spend-date-input"
              maxLength={10}
              autoCorrect={false}
              autoCapitalize="none"
              onChangeText={(value) => {
                setDate(value);
                setDayError('');
                clearSaveError();
              }}
            />
            <FormError message={dayError} testID="no-spend-error" />
            {!sample && ledger.wallet.trackingStartedOn >= clock.today ? (
              <Text style={[ui.hint, ui.smallGap]}>
                Tracking started today. A completed day can be confirmed from tomorrow.
              </Text>
            ) : null}
            <View style={ui.gap}>
              <Action
                label={saving ? 'Saving…' : 'Confirm completed day'}
                disabled={saving || sample || ledger.wallet.trackingStartedOn >= clock.today}
                onPress={() => {
                  void confirmDay();
                }}
                testID="confirm-no-spend"
              />
            </View>
          </View>
          <View style={[ui.card, ui.gap]}>
            <Text style={ui.heading} accessibilityRole="header">
              This week’s review
            </Text>
            <Text selectable style={[ui.body, ui.smallGap]} testID="weekly-review-period">
              {displayDate(review.weekStart)} – {displayDate(review.weekEnd)}
            </Text>
            <Text style={[ui.hint, ui.smallGap]}>
              Recorded activity from Monday through {displayDate(review.throughDate)}.
            </Text>
            <Text selectable style={[ui.body, ui.smallGap]} testID="weekly-review-expense">
              Expenses: {money(review.expenseMinor)}
            </Text>
            <Text selectable style={[ui.body, ui.smallGap]} testID="weekly-review-debt">
              Debt payments: {money(review.debtMinor)}
            </Text>
            <View style={ui.divider} testID="weekly-review-budgets">
              <Text style={ui.heading}>Budgets overlapping this week</Text>
              {review.budgets.length === 0 ? (
                <Text style={[ui.body, ui.smallGap]}>No budgets overlap this week.</Text>
              ) : (
                review.budgets.map((budget) => (
                  <View key={budget.budgetId} style={ui.divider}>
                    <Text style={styles.budgetName}>{budget.categoryName}</Text>
                    <Text style={[ui.hint, ui.smallGap]}>
                      {displayDate(budget.startDate)} – {displayDate(budget.endDate)}
                    </Text>
                    <Text selectable style={[ui.body, ui.smallGap]}>
                      Budget-period spending through {displayDate(budget.throughDate)}:{' '}
                      {money(budget.spentMinor)} of {money(budget.plannedMinor)}.
                    </Text>
                    {budget.throughDate < budget.startDate ? (
                      <Text style={[ui.hint, ui.smallGap]}>
                        This budget starts later this week. No future-dated spending is counted.
                      </Text>
                    ) : null}
                    <Text selectable style={[ui.hint, ui.smallGap]}>
                      {budget.overMinor > 0
                        ? `${money(budget.overMinor)} over budget.`
                        : `${money(budget.remainingMinor)} remaining.`}
                    </Text>
                  </View>
                ))
              )}
              <Text style={[ui.hint, ui.gap]}>
                These amounts cover each budget's own period; monthly and yearly budgets are not
                divided into weekly allowances.
              </Text>
            </View>
            {review.completedReview ? (
              <View style={ui.gap}>
                <Text selectable style={ui.body} testID="weekly-review-completed">
                  This week’s review was completed on{' '}
                  {displayDate(review.completedReview.completedOnDate)}. It counts once.
                </Text>
                <Text selectable style={[ui.hint, ui.smallGap]}>
                  Saved at completion: {money(review.completedReview.expenseMinor)} expenses,{' '}
                  {money(review.completedReview.debtMinor)} debt payments, and{' '}
                  {review.completedReview.budgetCount} overlapping budgets. Current figures above
                  may change as records are edited.
                </Text>
              </View>
            ) : null}
            <FormError message={reviewError} testID="weekly-review-error" />
            <View style={ui.gap}>
              <Action
                label={saving ? 'Saving…' : 'Complete this week’s review'}
                disabled={saving || sample || !!review.completedReview}
                onPress={() => {
                  void finishReview();
                }}
                testID="complete-weekly-review"
              />
            </View>
          </View>
          {actionStatus ? (
            <Text style={[ui.body, ui.gap]} accessibilityLiveRegion="polite">
              {actionStatus}
            </Text>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  status: { color: colors.purple, fontSize: 14, fontWeight: '600', lineHeight: 21, marginTop: 6 },
  budgetName: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
});

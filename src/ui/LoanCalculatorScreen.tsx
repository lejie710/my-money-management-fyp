import React, { useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import {
  calculateLoan,
  formatAnnualRate,
  LoanResult,
  parseAnnualRate,
  parseTermMonths,
} from '../core/loan';
import { amountInputValue, Currency, formatMoney, parseMoney } from '../core/model';
import { Action, Choice, Field, FormError, Screen } from './components';
import { colors, ui } from './theme';

type LoanDraft = { principal: string; rate: string; months: string };
type AppliedLoan = { currency: Currency; loan: LoanResult };
const blankDraft = (): LoanDraft => ({ principal: '', rate: '', months: '' });
const pageSize = 6;

function ValueRow({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={styles.valueRow}>
      <Text style={[ui.body, ui.flex]}>{label}</Text>
      <Text selectable style={styles.value} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

export function LoanCalculatorScreen({
  currency,
  onBack,
}: {
  currency: Currency;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<LoanDraft>(blankDraft);
  const [applied, setApplied] = useState<AppliedLoan | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [page, setPage] = useState(0);
  const result = applied?.loan;
  const toDraft = (value: AppliedLoan): LoanDraft => ({
    principal: amountInputValue(value.loan.inputs.principalMinor, value.currency),
    rate: formatAnnualRate(value.loan.inputs.annualRateUnits),
    months: String(value.loan.inputs.termMonths),
  });
  const resultDraft = applied ? toDraft(applied) : null;
  const changed =
    resultDraft &&
    (draft.principal !== resultDraft.principal ||
      draft.rate !== resultDraft.rate ||
      draft.months !== resultDraft.months ||
      applied!.currency !== currency);
  const money = (value: number) => formatMoney(value, applied?.currency ?? currency);
  const maxPage = result ? Math.max(0, Math.ceil(result.schedule.length / pageSize) - 1) : 0;
  const pageRows = result?.schedule.slice(page * pageSize, (page + 1) * pageSize) ?? [];

  const update = (field: keyof LoanDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError('');
  };
  const calculate = () => {
    try {
      const loan = calculateLoan({
        principalMinor: parseMoney(draft.principal, currency),
        annualRateUnits: parseAnnualRate(draft.rate),
        termMonths: parseTermMonths(draft.months),
      });
      const next = { currency, loan };
      setApplied(next);
      setDraft(toDraft(next));
      setError('');
      setPage(0);
      setStatus('Payment estimate calculated. Your wallet is unchanged.');
      Keyboard.dismiss();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the loan amounts and term.');
    }
  };
  const clear = () => {
    setDraft(blankDraft());
    setApplied(null);
    setError('');
    setPage(0);
    setShowSchedule(false);
    setStatus('Calculator cleared. Your wallet is unchanged.');
    Keyboard.dismiss();
  };

  return (
    <Screen>
      <View style={{ marginBottom: 18 }}>
        <Action label="Back to wallet" secondary onPress={onBack} testID="loan-back" />
      </View>
      <Text style={ui.title} accessibilityRole="header">
        Loan calculator
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Estimate fixed-rate monthly payments in {currency}. This calculator does not create a loan
        or change your wallet.
      </Text>
      <View style={[ui.card, ui.gap]}>
        <Field
          label={`Principal (${currency})`}
          value={draft.principal}
          testID="loan-principal-input"
          keyboardType="decimal-pad"
          maxLength={15}
          placeholder={currency === 'JPY' ? 'e.g. 1200' : 'e.g. 1200.00'}
          onChangeText={(value) => update('principal', value)}
        />
        <Field
          label="Nominal annual interest rate (%)"
          value={draft.rate}
          testID="loan-rate-input"
          keyboardType="decimal-pad"
          maxLength={12}
          placeholder="e.g. 12"
          onChangeText={(value) => update('rate', value)}
          hint="0–100%, with up to four decimal places. Zero interest is supported."
        />
        <Field
          label="Term in months"
          value={draft.months}
          testID="loan-months-input"
          keyboardType="number-pad"
          maxLength={4}
          placeholder="e.g. 12"
          onChangeText={(value) => update('months', value)}
          hint="Enter 1–600 whole months. 12 months is one year."
        />
        <FormError message={error} testID="loan-error" />
        <View style={ui.gap}>
          <Action label="Calculate payments" onPress={calculate} testID="calculate-loan" />
        </View>
        <View style={ui.smallGap}>
          <Action label="Clear calculator" secondary onPress={clear} testID="clear-loan" />
        </View>
        {status || changed ? (
          <Text
            style={[ui.hint, ui.smallGap]}
            accessibilityLiveRegion="polite"
            testID="loan-status"
          >
            {changed
              ? 'Inputs have changed. Calculate again to update the previous estimate below.'
              : status}
          </Text>
        ) : null}
      </View>
      <Text style={[ui.hint, ui.gap]}>
        Assumes monthly compounding and monthly payments, with a fixed nominal annual rate, no fees,
        and no rate changes. This is a calculation estimate, not a lender's quote.
      </Text>

      {result && applied ? (
        <>
          <View style={[ui.card, ui.gap]} testID="loan-result">
            <Text style={ui.heading} accessibilityRole="header">
              Applied payment estimate
            </Text>
            <Text selectable style={[ui.body, ui.smallGap]} testID="loan-applied-inputs">
              {money(result.inputs.principalMinor)} principal •{' '}
              {formatAnnualRate(result.inputs.annualRateUnits)}% nominal annual rate •{' '}
              {result.requestedTermMonths} requested months
            </Text>
            <Text style={[ui.hint, ui.gap]}>Regular monthly payment</Text>
            <Text selectable style={styles.payment} testID="loan-regular-payment">
              {money(result.regularPaymentMinor)}
            </Text>
            <ValueRow
              label="Adjusted final payment"
              value={money(result.finalPaymentMinor)}
              testID="loan-final-payment"
            />
            <ValueRow
              label="Actual payments"
              value={String(result.actualTermMonths)}
              testID="loan-payment-count"
            />
            <ValueRow
              label="Total interest"
              value={money(result.totalInterestMinor)}
              testID="loan-total-interest"
            />
            <ValueRow
              label="Total paid"
              value={money(result.totalPaidMinor)}
              testID="loan-total-paid"
            />
            <Text style={[ui.hint, ui.gap]}>
              Payments and each month's interest are rounded to{' '}
              {applied.currency === 'JPY' ? 'whole yen' : 'the currency’s smallest unit'}. The final
              payment clears the remaining balance and may differ from the regular payment.
            </Text>
            {result.paidOffEarly ? (
              <Text style={[ui.body, ui.smallGap]} testID="loan-early-payoff">
                Rounding pays off this amount in {result.actualTermMonths} payments instead of the
                requested {result.requestedTermMonths} months.
              </Text>
            ) : null}
            <Text selectable style={[ui.hint, ui.smallGap]}>
              Calculation: {result.calculationVersion}
            </Text>
            <View style={ui.gap}>
              <Action
                label={showSchedule ? 'Hide payment schedule' : 'Show payment schedule'}
                secondary
                onPress={() => setShowSchedule((current) => !current)}
                testID="loan-show-schedule"
              />
            </View>
          </View>
          {showSchedule ? (
            <View style={ui.gap}>
              <Text style={ui.heading} accessibilityRole="header">
                Payment schedule
              </Text>
              <Text
                style={[ui.body, ui.smallGap]}
                accessibilityLiveRegion="polite"
                testID="loan-schedule-range"
              >
                Payments {page * pageSize + 1}–
                {Math.min((page + 1) * pageSize, result.actualTermMonths)} of{' '}
                {result.actualTermMonths}
              </Text>
              <View style={[ui.row, ui.smallGap, { flexWrap: 'wrap', gap: 8 }]}>
                <Choice
                  label="First page"
                  selected={false}
                  disabled={page === 0}
                  onPress={() => setPage(0)}
                  testID="loan-schedule-first"
                />
                <Choice
                  label="Previous"
                  selected={false}
                  disabled={page === 0}
                  onPress={() => setPage((current) => Math.max(0, current - 1))}
                  testID="loan-schedule-previous"
                />
                <Choice
                  label="Next"
                  selected={false}
                  disabled={page === maxPage}
                  onPress={() => setPage((current) => Math.min(maxPage, current + 1))}
                  testID="loan-schedule-next"
                />
                <Choice
                  label="Last page"
                  selected={false}
                  disabled={page === maxPage}
                  onPress={() => setPage(maxPage)}
                  testID="loan-schedule-last"
                />
              </View>
              {pageRows.map((row) => (
                <View
                  style={[ui.card, ui.smallGap]}
                  key={row.month}
                  testID={`loan-payment-${row.month}`}
                >
                  <Text style={ui.heading}>Payment {row.month}</Text>
                  <ValueRow label="Opening balance" value={money(row.openingBalanceMinor)} />
                  <ValueRow
                    label="Payment"
                    value={money(row.paymentMinor)}
                    testID={`loan-amount-${row.month}`}
                  />
                  <ValueRow
                    label="Interest"
                    value={money(row.interestMinor)}
                    testID={`loan-interest-${row.month}`}
                  />
                  <ValueRow
                    label="Principal repaid"
                    value={money(row.principalPaidMinor)}
                    testID={`loan-principal-${row.month}`}
                  />
                  <ValueRow
                    label="Remaining balance"
                    value={money(row.closingBalanceMinor)}
                    testID={`loan-balance-${row.month}`}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : (
        <View style={[ui.card, ui.gap]} testID="loan-empty">
          <Text style={ui.heading}>Enter an amount and term to begin</Text>
          <Text style={[ui.body, ui.smallGap]}>
            Calculate to see the payment estimate and how each payment reduces the balance.
          </Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  valueRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 15 },
  value: {
    maxWidth: '48%',
    color: colors.text,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  payment: {
    color: colors.purple,
    fontSize: 30,
    lineHeight: 40,
    fontWeight: '700',
    marginTop: 5,
    fontVariant: ['tabular-nums'],
  },
});

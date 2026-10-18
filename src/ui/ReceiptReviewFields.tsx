import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { amountInputValue, formatMoney, type Ledger } from '../core/model';
import { Action, Choice, Field } from './components';
import type { ReceiptCaptureDraft } from './useReceiptCapture';
import { colors, ui } from './theme';

export function ReceiptReviewFields({
  draft,
  ledger,
  previewAvailable = true,
}: {
  draft: ReceiptCaptureDraft;
  ledger: Ledger;
  previewAvailable?: boolean;
}) {
  const [showRows, setShowRows] = useState(false);
  const [rowPage, setRowPage] = useState(0);
  const candidate = draft.candidate;
  if (!candidate || candidate.status === 'empty') return null;
  const disabled = draft.phase === 'saving';
  const categories = ledger.categories.filter((category) => category.type === 'expense');
  const foreign =
    (!!candidate.currency.suggested && candidate.currency.suggested !== ledger.wallet.currency) ||
    (candidate.currency.explicit.length > 0 &&
      !candidate.currency.explicit.includes(ledger.wallet.currency));
  const currencyBlocked = foreign || candidate.currency.unsupported.length > 0;
  const messages = [
    ...new Set([
      ...candidate.warnings,
      ...candidate.title.issues,
      ...candidate.date.issues,
      ...candidate.currency.issues,
      ...candidate.total.issues,
    ]),
  ];
  const pageCount = Math.max(1, Math.ceil(candidate.rows.length / 10));
  const page = Math.min(rowPage, pageCount - 1);
  return (
    <View style={ui.divider}>
      <Text style={ui.heading} accessibilityRole="header">
        Review the expense
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Recognized text is a suggestion. No transaction has been saved.
      </Text>
      <View style={ui.smallGap} testID="receipt-review-warnings">
        {messages.map((message) => (
          <Text selectable key={message} style={[ui.hint, { marginTop: 6 }]}>
            {message}
          </Text>
        ))}
      </View>
      <Text selectable style={[ui.body, ui.gap]} testID="receipt-currency-status">
        Wallet currency: {ledger.wallet.currency}.{' '}
        {candidate.currency.suggested
          ? `Recognized currency: ${candidate.currency.suggested}.`
          : candidate.currency.candidates.length
            ? `Possible currencies: ${candidate.currency.candidates.join(', ')}.`
            : 'No supported currency was identified.'}
        {candidate.currency.unsupported.length
          ? ` Unsupported: ${candidate.currency.unsupported.join(', ')}.`
          : ''}
      </Text>
      {currencyBlocked ? (
        <Text style={[ui.error, ui.smallGap]} testID="receipt-currency-blocked">
          This receipt cannot be confirmed into this wallet. No currency conversion or relabelling
          is performed. Use a matching wallet or a separately reviewed manual transaction.
        </Text>
      ) : null}
      <Field
        label="Expense title"
        value={draft.review.title}
        onChangeText={(value) => draft.update('title', value)}
        editable={!disabled}
        maxLength={80}
        placeholder="Enter the vendor or expense title"
        testID="receipt-title-input"
      />
      <Field
        label="Receipt date (YYYY-MM-DD)"
        value={draft.review.date}
        onChangeText={(value) => draft.update('date', value)}
        editable={!disabled}
        maxLength={10}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Enter the date printed on the receipt"
        testID="receipt-date-input"
      />
      {candidate.date.candidates.length > 1 ? (
        <View style={[ui.row, ui.smallGap, { flexWrap: 'wrap' }]}>
          {candidate.date.candidates.map((date) => (
            <Choice
              key={date}
              label={date}
              selected={draft.review.date === date}
              disabled={disabled}
              onPress={() => draft.update('date', date)}
              testID={`receipt-date-option-${date}`}
            />
          ))}
        </View>
      ) : null}
      <Field
        label={`Reviewed amount (${ledger.wallet.currency})`}
        value={draft.review.amount}
        onChangeText={(value) => draft.update('amount', value)}
        editable={!disabled && !currencyBlocked}
        keyboardType="decimal-pad"
        maxLength={15}
        placeholder="Enter the correct receipt total"
        testID="receipt-amount-input"
      />
      {candidate.total.candidates.length ? (
        <View style={ui.smallGap}>
          <Text style={ui.hint}>
            Recognized labelled totals. Choose the total shown on your receipt; several readings may
            be possible.
          </Text>
          {candidate.total.candidates.map((item, index) => (
            <View key={`${item.rowIndex}-${index}`} style={ui.smallGap}>
              <Text selectable style={ui.hint}>
                {item.text}
              </Text>
              <Action
                secondary
                label={`Use ${formatMoney(item.amountMinor, item.currency)}`}
                disabled={disabled || currencyBlocked || item.currency !== ledger.wallet.currency}
                onPress={() =>
                  draft.update('amount', amountInputValue(item.amountMinor, ledger.wallet.currency))
                }
                testID={`receipt-total-option-${index}`}
              />
            </View>
          ))}
        </View>
      ) : null}
      <Text style={ui.fieldLabel}>Expense category</Text>
      <View style={[ui.row, { flexWrap: 'wrap' }]}>
        {categories.map((category) => (
          <Choice
            key={category.id}
            label={category.name}
            selected={draft.review.categoryId === category.id}
            disabled={disabled}
            onPress={() => draft.update('categoryId', category.id)}
            testID={`receipt-category-${category.id}`}
          />
        ))}
      </View>
      <Text style={[ui.hint, { marginTop: 7 }]}>
        This saves as an ordinary expense in the selected category, so reports and budgets include
        it.
      </Text>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: draft.keepPhoto, disabled }}
        disabled={disabled}
        onPress={() => draft.setKeepPhoto(!draft.keepPhoto)}
        style={({ pressed }) => [{ minHeight: 52, paddingVertical: 12 }, pressed && ui.pressed]}
        testID="receipt-keep-photo"
      >
        <Text style={[ui.body, { color: draft.keepPhoto ? colors.green : colors.muted }]}>
          {draft.keepPhoto
            ? 'Included: keep the receipt photo with this expense'
            : 'Optional: keep the receipt photo with this expense'}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{
          checked: draft.review.confirmed,
          disabled: disabled || currencyBlocked || !previewAvailable,
        }}
        disabled={disabled || currencyBlocked || !previewAvailable}
        onPress={() => draft.setConfirmed(!draft.review.confirmed)}
        style={({ pressed }) => [{ minHeight: 56, paddingVertical: 12 }, pressed && ui.pressed]}
        testID="receipt-confirm-fields"
      >
        <Text style={[ui.body, { color: draft.review.confirmed ? colors.green : colors.text }]}>
          {draft.review.confirmed ? 'Checked: ' : 'Confirm: '}I checked the title, date, amount,
          category and {ledger.wallet.currency} currency against the receipt.
        </Text>
      </Pressable>
      <Action
        label={disabled ? 'Saving reviewed expense…' : 'Confirm and save expense'}
        disabled={disabled || currencyBlocked || !previewAvailable || !draft.review.confirmed}
        onPress={() => {
          void draft.confirm();
        }}
        testID="receipt-save-expense"
      />
      <View style={ui.gap}>
        <Action
          secondary
          label={showRows ? 'Hide recognized text' : 'Show recognized text'}
          onPress={() => setShowRows((value) => !value)}
          disabled={disabled}
          testID="receipt-toggle-text"
        />
      </View>
      {showRows ? (
        <View style={ui.smallGap}>
          {candidate.rows.slice(page * 10, page * 10 + 10).map((row) => (
            <Text
              selectable
              key={row.index}
              style={[ui.body, { marginTop: 5 }]}
              testID={`receipt-row-${row.index}`}
            >
              {row.text}
            </Text>
          ))}
          <Text style={[ui.hint, ui.smallGap]}>
            Recognized text page {page + 1} of {pageCount}.
          </Text>
          <View style={[ui.row, ui.smallGap]}>
            <View style={ui.flex}>
              <Action
                secondary
                label="Previous"
                disabled={page === 0}
                onPress={() => setRowPage(page - 1)}
                testID="receipt-text-previous"
              />
            </View>
            <View style={ui.flex}>
              <Action
                secondary
                label="Next"
                disabled={page + 1 >= pageCount}
                onPress={() => setRowPage(page + 1)}
                testID="receipt-text-next"
              />
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

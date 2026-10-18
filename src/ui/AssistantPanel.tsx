import React from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, View } from 'react-native';
import { Action, Field, FormError } from './components';
import { colors, ui } from './theme';
import type { AssistantGroup, AssistantPanelProps } from './assistantUiTypes';
import { useAssistant } from './useAssistant';

const groups: readonly { key: AssistantGroup; title: string; description: string }[] = [
  {
    key: 'allDatesBalance',
    title: 'All-dates wallet balance',
    description: 'Includes records after the selected end date.',
  },
  {
    key: 'categories',
    title: 'Expense categories',
    description: 'Up to three largest categories; shares use expense total.',
  },
  {
    key: 'budgets',
    title: 'Overlapping budgets',
    description: 'Up to three plans using their full own periods, including later records.',
  },
  {
    key: 'goal',
    title: 'Current goal target',
    description: 'Compared with the selected period closing balance.',
  },
  {
    key: 'health',
    title: 'Illustrative project score',
    description: 'The recorded cash-flow formula, with its limitations.',
  },
];

/** Content only. The parent owns scrolling, keyboard avoidance, safe area and modal/navigation. */
export function AssistantPanel(props: AssistantPanelProps) {
  const assistant = useAssistant(props);
  return (
    <View testID="assistant-panel">
      <Text style={ui.title} accessibilityRole="header">
        Ask about these records
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        A local Windows model can explain the financial facts you select. Your questions stay in
        this open conversation; only the current question and facts are sent.
      </Text>
      <View style={[ui.card, ui.gap]}>
        <Text style={ui.heading} accessibilityRole="header">
          Windows companion
        </Text>
        <Text
          style={[ui.body, ui.smallGap]}
          testID="assistant-connection-status"
          accessibilityLiveRegion="polite"
        >
          {!assistant.configured
            ? 'Companion not configured. Calculated facts are still available.'
            : assistant.turns.length
              ? 'Local model responded. An explanation can still be wrong; compare it with the facts.'
              : 'Local connection configured. Availability is checked when you ask.'}
        </Text>
        <Text style={[ui.hint, ui.smallGap]}>
          The model runs on the connected Windows computer, not on this phone. A first response may
          take longer while the model loads.
        </Text>
        {props.ledger.mode === 'sample' ? (
          <Text style={[ui.hint, ui.smallGap]} testID="assistant-sample">
            Sample wallet: these are demonstration records.
          </Text>
        ) : null}
      </View>

      <Text style={[ui.heading, ui.gap]} accessibilityRole="header">
        Choose the period
      </Text>
      <Field
        label="Start date"
        value={assistant.startDraft}
        onChangeText={assistant.setStartDraft}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        autoCapitalize="none"
        testID="assistant-start-date"
      />
      <Field
        label="End date"
        value={assistant.endDraft}
        onChangeText={assistant.setEndDraft}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        autoCapitalize="none"
        testID="assistant-end-date"
        hint="Both dates are included. Apply a valid range to update the facts and clear this conversation."
      />
      <View style={ui.smallGap}>
        <Action
          label="Apply period"
          secondary
          onPress={assistant.applyRange}
          testID="assistant-apply-period"
        />
      </View>
      <FormError
        message={assistant.selectionError || assistant.contextError}
        testID="assistant-range-error"
      />
      {assistant.hasUnappliedDates ? (
        <Text style={[ui.hint, ui.smallGap]} testID="assistant-unapplied">
          Date edits are not applied. Questions still use the period shown with the facts below.
        </Text>
      ) : null}

      <Text style={[ui.heading, ui.gap]} accessibilityRole="header">
        Optional details
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Turn on only the groups you want to include. Changing a group clears this conversation.
      </Text>
      {groups.map((group) => (
        <View key={group.key} style={styles.option}>
          <View style={ui.flex}>
            <Text style={styles.label}>{group.title}</Text>
            <Text style={[ui.hint, { marginTop: 4 }]}>{group.description}</Text>
          </View>
          <Switch
            value={assistant.include[group.key]}
            onValueChange={() => assistant.toggleGroup(group.key)}
            accessibilityLabel={`Include ${group.title.toLowerCase()}`}
            testID={`assistant-include-${group.key}`}
            trackColor={{ false: colors.border, true: colors.accent }}
            thumbColor={colors.onAccent}
          />
        </View>
      ))}

      {assistant.context ? (
        <View style={[ui.card, ui.gap]} testID="assistant-facts">
          <Text style={ui.heading} accessibilityRole="header">
            Facts available to the model
          </Text>
          <Text style={[ui.body, ui.smallGap]} testID="assistant-applied-period">
            {assistant.context.startDate} through {assistant.context.endDate}, inclusive ·{' '}
            {assistant.context.currency}
          </Text>
          {assistant.context.recordedIncomeIsZero ? (
            <Text style={[styles.knownZero, ui.smallGap]} testID="assistant-zero-income">
              Recorded income is known to be zero. Income-based ratios are undefined, not missing.
            </Text>
          ) : null}
          {assistant.context.facts.map((fact) => (
            <View key={fact.id} style={styles.fact} testID={`assistant-fact-${fact.id}`}>
              <Text style={styles.label}>{fact.label}</Text>
              <Text selectable style={[ui.body, ui.smallGap]}>
                {fact.value}
              </Text>
            </View>
          ))}
          <Text style={[ui.hint, ui.smallGap]}>
            These exact fact rows and your question are sent. Transaction titles, notes, contacts,
            locations and photos are excluded. Selected category names can appear in the optional
            groups.
          </Text>
        </View>
      ) : null}

      <Field
        label="Your question"
        value={assistant.question}
        onChangeText={assistant.setQuestion}
        placeholder="What explains the change during this period?"
        multiline
        maxLength={500}
        editable={!assistant.busy}
        textAlignVertical="top"
        style={styles.question}
        testID="assistant-question"
        hint={`${assistant.question.length}/500 characters. Each question is independent; earlier replies are not sent back to the model.`}
      />
      <View style={ui.smallGap}>
        <Action
          label="Ask local model"
          disabled={!assistant.canAsk || assistant.busy || !assistant.question.trim()}
          onPress={() => {
            void assistant.ask();
          }}
          testID="assistant-ask"
        />
      </View>
      {assistant.busy ? (
        <View style={ui.smallGap}>
          <View style={ui.row}>
            <ActivityIndicator color={colors.purple} />
            <Text
              style={[ui.body, ui.flex]}
              accessibilityLiveRegion="polite"
              testID="assistant-pending"
            >
              Waiting for the Windows model…
            </Text>
          </View>
          <View style={ui.smallGap}>
            <Action
              label="Cancel explanation"
              secondary
              onPress={assistant.cancel}
              testID="assistant-cancel"
            />
          </View>
        </View>
      ) : null}
      <FormError message={assistant.message} testID="assistant-message" />
      {assistant.retryQuestion && !assistant.busy ? (
        <View style={ui.smallGap}>
          <Action
            label="Retry last question"
            secondary
            disabled={!assistant.canAsk}
            onPress={() => {
              void assistant.retry();
            }}
            testID="assistant-retry"
          />
        </View>
      ) : null}

      <View style={ui.gap} testID="assistant-conversation">
        <Text style={ui.heading} accessibilityRole="header">
          Generated explanations
        </Text>
        <Text style={[ui.hint, ui.smallGap]}>
          Read-only explanations. No transaction, budget or goal is changed. Response checks catch
          specific known defects; they do not verify every claim.
        </Text>
        {!assistant.turns.length ? (
          <Text style={[ui.body, ui.smallGap]}>
            Ask a question to see an explanation beside its cited facts.
          </Text>
        ) : (
          assistant.turns.map((turn, index) => (
            <View key={index} style={[ui.card, ui.smallGap]} testID={`assistant-turn-${index}`}>
              <Text style={styles.label}>You asked</Text>
              <Text selectable style={[ui.body, ui.smallGap]}>
                {turn.question}
              </Text>
              <Text style={[styles.label, ui.gap]}>Local model explanation</Text>
              <Text selectable style={[ui.body, ui.smallGap]} testID={`assistant-answer-${index}`}>
                {turn.answer}
              </Text>
              <Text style={[styles.label, ui.gap]}>Facts cited by the model</Text>
              {turn.facts.map((fact) => (
                <Text key={fact.id} selectable style={[ui.hint, ui.smallGap]}>
                  {fact.label}: {fact.value}
                </Text>
              ))}
            </View>
          ))
        )}
      </View>
      <Text style={[ui.hint, ui.smallGap]}>
        Only the last three explanations remain while this context is open. Closing, switching
        wallet or changing the saved records clears them.
      </Text>
      {assistant.turns.length || assistant.retryQuestion || assistant.question ? (
        <View style={ui.smallGap}>
          <Action
            label="Clear conversation"
            secondary
            onPress={assistant.clear}
            testID="assistant-clear"
          />
        </View>
      ) : null}
      {props.onClose ? (
        <View style={ui.gap}>
          <Action
            label="Close assistant"
            secondary
            onPress={() => {
              assistant.close();
              props.onClose?.();
            }}
            testID="assistant-close"
          />
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 58,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  label: { color: colors.text, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  fact: { marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border },
  knownZero: { color: colors.green, fontSize: 14, lineHeight: 21 },
  question: { minHeight: 100 },
});

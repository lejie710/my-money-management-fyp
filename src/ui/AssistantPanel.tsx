import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, View } from 'react-native';
import { Action, Field, FormError } from './components';
import { useThemedStyles, type ThemeColors } from './theme';
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
    key: 'comparisons',
    title: 'Previous-period comparison',
    description:
      'Compare a full month with the previous month, or another range with the preceding equal number of days.',
  },
  {
    key: 'health',
    title: 'Illustrative project score',
    description: 'The recorded cash-flow formula, with its limitations.',
  },
];

/** Content only. The parent owns scrolling, keyboard avoidance, safe area and modal/navigation. */
export function AssistantPanel(props: AssistantPanelProps) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  const assistant = useAssistant(props);
  const cloud = props.provider?.engine === 'openai' || !assistant.configured;
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [showSummaries, setShowSummaries] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  return (
    <View testID="assistant-panel">
      <Text style={ui.title} accessibilityRole="header">
        Your financial assistant
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        {cloud
          ? 'OpenAI uses the selected wallet summaries to explain spending and suggest practical budgeting and saving steps. Your question, displayed facts and up to three earlier exchanges from this conversation are sent when you ask.'
          : 'The optional local model uses the selected summaries and up to three earlier exchanges to answer follow-up questions. It runs on your connected Windows computer.'}
      </Text>
      <View style={[ui.card, ui.gap]}>
        <Text style={ui.heading} accessibilityRole="header">
          {cloud ? 'OpenAI' : 'Local Windows model'}
        </Text>
        <Text
          style={[ui.body, ui.smallGap]}
          testID="assistant-connection-status"
          accessibilityLiveRegion="polite"
        >
          {!assistant.configured
            ? 'Assistant service not configured. Calculated facts are still available.'
            : assistant.turns.length
              ? 'The model responded. An explanation can still be wrong; compare it with the facts.'
              : 'Connection configured. Provider availability is checked when you ask.'}
        </Text>
        <Text style={[ui.hint, ui.smallGap]} testID="assistant-provider-disclosure">
          {!assistant.configured
            ? 'Configure an assistant in Wallet > Connections to ask questions. Calculated summaries remain available.'
            : cloud
              ? `Cloud processing by OpenAI using ${props.provider!.model}. The displayed fact rows and your question leave the device only when you ask. Your provider account's usage charges may apply.`
              : 'The model runs on the connected Windows computer, not on this phone. A first response may take longer while the model loads.'}
        </Text>
        {props.ledger.mode === 'sample' ? (
          <Text style={[ui.hint, ui.smallGap]} testID="assistant-sample">
            Sample wallet: these are demonstration records.
          </Text>
        ) : null}
      </View>

      <Text style={[ui.heading, ui.gap]} accessibilityRole="header">
        Choose the period to analyse
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

      <View style={ui.gap}>
        <Action
          label={showSummaries ? 'Hide shared summaries' : 'Review shared summaries'}
          secondary
          onPress={() => setShowSummaries((value) => !value)}
          testID="assistant-summary-toggle"
        />
        <Text style={[ui.hint, ui.smallGap]}>
          The applied period, cash flow and selected category, budget, goal and comparison summaries
          are available to the assistant. Review or adjust them before asking.
        </Text>
      </View>
      {showSummaries ? (
        <>
          <Text style={[ui.heading, ui.gap]} accessibilityRole="header">
            Optional details
          </Text>
          <Text style={[ui.body, ui.smallGap]}>
            Choose the summaries to include. Changing the period, summaries or wallet records starts
            a new conversation; saved conversations remain in device history.
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
                {assistant.context.startDate} through {assistant.context.endDate}, inclusive,{' '}
                {assistant.context.currency}
              </Text>
              {assistant.context.recordedIncomeIsZero ? (
                <Text style={[styles.knownZero, ui.smallGap]} testID="assistant-zero-income">
                  Recorded income is known to be zero. Income-based ratios are undefined, not
                  missing.
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
                These fact rows, your question and up to three earlier exchanges are sent.
                Transaction titles, notes, contacts, locations and photos are excluded. Selected
                category names can appear in the optional groups.
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      {assistant.historyEnabled ? (
        <View style={ui.gap}>
          <Action
            label={
              showHistory
                ? 'Hide saved conversations'
                : 'Saved conversations (' + assistant.history.length + ')'
            }
            secondary
            onPress={() => setShowHistory((value) => !value)}
            testID="assistant-history-toggle"
          />
          {!showHistory ? (
            <FormError
              message={assistant.historyError}
              testID="assistant-history-collapsed-error"
            />
          ) : null}
        </View>
      ) : null}
      {assistant.historyEnabled && showHistory ? (
        <View style={[ui.card, ui.gap]} testID="assistant-history">
          <Text style={ui.heading} accessibilityRole="header">
            Saved conversations
          </Text>
          <Text style={[ui.hint, ui.smallGap]}>
            Stored on this device, separately for each account. Up to twenty conversations; history
            is not synchronized to Firebase.
          </Text>
          <FormError message={assistant.historyError} testID="assistant-history-error" />
          {!assistant.historyLoaded ? (
            <View style={ui.smallGap}>
              <Action
                label="Reopen conversation history"
                secondary
                onPress={() => {
                  void assistant.refreshHistory();
                }}
                testID="assistant-history-retry"
              />
            </View>
          ) : !assistant.history.length ? (
            <Text style={[ui.body, ui.smallGap]}>
              Your first completed conversation will appear here.
            </Text>
          ) : (
            assistant.history.map((record) => (
              <View key={record.id} style={[ui.smallGap, { gap: 8 }]}>
                <Text style={styles.label}>{record.walletName}</Text>
                <Text style={ui.hint}>
                  {record.context.startDate} through {record.context.endDate}
                </Text>
                <Text style={ui.body} numberOfLines={2}>
                  {record.turns[0].question}
                </Text>
                <Text style={ui.hint}>
                  {new Date(record.updatedAt).toLocaleString()} ·{' '}
                  {record.provider.engine === 'openai' ? 'OpenAI' : 'Local model'}
                </Text>
                <Action
                  label="View conversation"
                  secondary
                  disabled={assistant.busy}
                  onPress={() => {
                    setPendingDelete(null);
                    assistant.openSaved(record.id);
                  }}
                  testID={'assistant-history-open-' + record.id}
                />
                {pendingDelete === record.id ? (
                  <>
                    <Text style={ui.body}>Delete this conversation from this device?</Text>
                    <Action
                      label="Delete this conversation"
                      danger
                      onPress={() => {
                        setPendingDelete(null);
                        void assistant.deleteSaved(record.id);
                      }}
                      testID={'assistant-history-confirm-delete-' + record.id}
                    />
                    <Action
                      label="Keep conversation"
                      secondary
                      onPress={() => setPendingDelete(null)}
                    />
                  </>
                ) : (
                  <Action
                    label="Delete conversation"
                    secondary
                    disabled={assistant.busy}
                    onPress={() => setPendingDelete(record.id)}
                    testID={'assistant-history-delete-' + record.id}
                  />
                )}
              </View>
            ))
          )}
          {assistant.historyError && assistant.turns.length ? (
            <View style={ui.smallGap}>
              <Action
                label="Retry saving this conversation"
                secondary
                disabled={assistant.busy || !assistant.historyLoaded}
                onPress={() => {
                  void assistant.saveConversation();
                }}
                testID="assistant-history-save-retry"
              />
              <Action
                label="Refresh saved history"
                secondary
                onPress={() => {
                  void assistant.refreshHistory();
                }}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {assistant.archivedConversation ? (
        <View style={[ui.card, ui.gap]} testID="assistant-history-detail">
          <Text style={ui.heading} accessibilityRole="header">
            Saved conversation
          </Text>
          <Text style={[ui.body, ui.smallGap]}>
            {assistant.archivedConversation.walletName}:{' '}
            {assistant.archivedConversation.context.startDate}
            {' through '}
            {assistant.archivedConversation.context.endDate}
          </Text>
          <Text style={[ui.hint, ui.smallGap]}>
            These answers describe the figures saved with this conversation.
            {assistant.canContinueSaved
              ? ' The current wallet, selected facts and provider still match, so you can continue.'
              : ' To ask about your current records, return to the current conversation. Historical answers are not a new assessment.'}
          </Text>
          {assistant.archivedConversation.turns.map((turn, index) => (
            <View key={index} style={ui.gap}>
              <Text style={styles.label}>You asked</Text>
              <Text selectable style={ui.body}>
                {turn.question}
              </Text>
              <Text style={[styles.label, ui.smallGap]}>Assistant</Text>
              <Text selectable style={ui.body}>
                {turn.answer}
              </Text>
              {assistant
                .archivedConversation!.context.facts.filter((fact) =>
                  turn.factIds.includes(fact.id),
                )
                .map((fact) => (
                  <Text key={fact.id} selectable style={[ui.hint, ui.smallGap]}>
                    {fact.label}: {fact.value}
                  </Text>
                ))}
            </View>
          ))}
          {assistant.canContinueSaved ? (
            <View style={ui.smallGap}>
              <Action
                label="Continue this conversation"
                onPress={assistant.continueSaved}
                testID="assistant-history-continue"
              />
            </View>
          ) : null}
          <View style={ui.smallGap}>
            <Action
              label="Return to current conversation"
              secondary
              onPress={assistant.closeSaved}
              testID="assistant-history-close"
            />
          </View>
        </View>
      ) : null}

      <Field
        label="Your question"
        value={assistant.question}
        onChangeText={assistant.setQuestion}
        placeholder="What explains the change during this period?"
        multiline
        maxLength={500}
        editable={!assistant.busy && !assistant.archivedConversation}
        textAlignVertical="top"
        style={styles.question}
        testID="assistant-question"
        hint={`${assistant.question.length}/500 characters. Follow-ups include up to three earlier exchanges from this conversation.`}
      />
      <View style={ui.smallGap}>
        <Action
          label={cloud ? 'Ask OpenAI' : 'Ask local model'}
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
              {cloud ? 'Waiting for OpenAI.' : 'Waiting for the Windows model.'}
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
          Conversation
        </Text>
        <Text style={[ui.hint, ui.smallGap]}>
          Suggestions do not change transactions, budgets or goals. Response checks catch specific
          known defects; they do not verify every claim.
        </Text>
        {!assistant.turns.length ? (
          <Text style={[ui.body, ui.smallGap]}>
            Ask about your spending or request budgeting and saving suggestions.
          </Text>
        ) : (
          assistant.turns.map((turn, index) => (
            <View key={index} style={[ui.card, ui.smallGap]} testID={`assistant-turn-${index}`}>
              <Text style={styles.label}>You asked</Text>
              <Text selectable style={[ui.body, ui.smallGap]}>
                {turn.question}
              </Text>
              <Text style={[styles.label, ui.gap]}>
                {cloud ? 'OpenAI explanation' : 'Local model explanation'}
              </Text>
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
        Conversations are saved on this device for this account when history is available. Each
        retains the period and figures it analysed. Only the latest twelve exchanges are kept per
        conversation.
      </Text>
      {assistant.turns.length || assistant.retryQuestion || assistant.question ? (
        <View style={ui.smallGap}>
          <Action
            label="Start a new conversation"
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
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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

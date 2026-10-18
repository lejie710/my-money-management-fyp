import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AccountUiState } from './accountUiTypes';
import type { useCompanionConnection } from './useCompanionConnection';
import { Action, RowAction, Screen } from './components';
import { ReceiptEntry } from './ReceiptEntry';
import { colors, ui } from './theme';

export function ConnectionsScreen({
  accountState,
  connection,
  busy,
  onBack,
  onAccount,
  onReceipt,
  onManualEntry,
  onReports,
}: {
  accountState: AccountUiState;
  connection: ReturnType<typeof useCompanionConnection>;
  busy: boolean;
  onBack(): void;
  onAccount(): void;
  onReceipt(): void;
  onManualEntry(): void;
  onReports(): void;
}) {
  const accountConfigured = accountState.provider === 'configured';
  return (
    <Screen>
      <View style={{ marginBottom: 18 }}>
        <Action label="Back to Wallet" secondary onPress={onBack} testID="connections-back" />
      </View>
      <Text style={ui.title} accessibilityRole="header">
        Connections
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Optional tools for your wallet. Everyday tracking works without a connection.
      </Text>
      <Text style={[styles.section, ui.gap]} accessibilityRole="header">
        Account
      </Text>
      <View style={styles.group}>
        <RowAction
          label={accountState.user ? 'Manage account' : 'Account access'}
          detail={
            accountConfigured ? 'Open your separate account wallet' : 'Optional local accounts'
          }
          icon="user"
          disabled={busy}
          onPress={onAccount}
          testID="connections-account"
          last
        />
      </View>
      <Text style={[ui.hint, ui.smallGap]}>
        {accountConfigured
          ? 'Account wallets stay on this device. Signing in does not upload or transfer your records.'
          : 'No account service is configured. Your current wallet works without signing in.'}
      </Text>
      <Text style={[styles.section, ui.gap]} accessibilityRole="header">
        Receipts
      </Text>
      <ReceiptEntry connection={connection} busy={busy} onOpen={onReceipt} />
      <Text style={[ui.hint, ui.smallGap]}>
        Review a photo and confirm an expense. Recognition needs the local Windows companion;
        choosing a photo alone sends nothing.
      </Text>
      <View style={ui.smallGap}>
        <Action
          label="Enter a transaction manually"
          secondary
          disabled={busy}
          onPress={onManualEntry}
          testID="connections-manual-entry"
        />
      </View>
      <Text style={[styles.section, ui.gap]} accessibilityRole="header">
        Financial assistant
      </Text>
      <View style={styles.group}>
        <RowAction
          label="Choose a report"
          detail="Review a period before asking about it"
          icon="reports"
          disabled={busy}
          onPress={onReports}
          testID="connections-assistant"
          last
        />
      </View>
      <Text style={[ui.hint, ui.smallGap]}>
        Calculated facts are available without a model. Explanations need the Windows companion in
        assistant mode and use only the facts you select and your question.
      </Text>
      {connection.phase === 'configured' ? (
        <Text style={[ui.hint, ui.smallGap]} testID="connections-assistant-status">
          A local connection is configured. Model availability is checked when you ask.
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  group: { backgroundColor: colors.surface, borderRadius: 18, overflow: 'hidden' },
});

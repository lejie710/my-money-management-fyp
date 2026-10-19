import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AccountUiState } from './accountUiTypes';
import type { useCompanionConnection } from './useCompanionConnection';
import { Action, RowAction, Screen } from './components';
import { ReceiptEntry } from './ReceiptEntry';
import { useThemedStyles, type ThemeColors } from './theme';

export function ConnectionsScreen({
  accountState,
  connection,
  busy,
  onBack,
  onAccount,
  onReceipt,
  onManualEntry,
  onReports,
  onForecast,
  onCloudBackup,
  onCloudWallet,
  cloudWalletConfigured = false,
}: {
  accountState: AccountUiState;
  connection: ReturnType<typeof useCompanionConnection>;
  busy: boolean;
  onBack(): void;
  onAccount(): void;
  onReceipt(): void;
  onManualEntry(): void;
  onReports(): void;
  onForecast?(): void;
  onCloudBackup?(): void;
  onCloudWallet?(): void;
  cloudWalletConfigured?: boolean;
}) {
  const { colors, ui, styles } = useThemedStyles(createStyles);
  const accountConfigured = accountState.provider === 'configured';
  const receiptProvider =
    connection.phase === 'configured' && connection.binding?.receipt
      ? connection.binding.providers.ocr
      : null;
  const assistantProvider =
    connection.phase === 'configured' && connection.binding?.assistant
      ? connection.binding.providers.assistant
      : null;
  return (
    <Screen>
      <View style={{ marginBottom: 18 }}>
        <Action label="Back to Wallet" secondary onPress={onBack} testID="connections-back" />
      </View>
      <Text style={ui.title} accessibilityRole="header">
        Connections
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Account storage and tools for your wallet. Guest tracking works without a connection.
      </Text>
      <Text style={[styles.section, ui.gap]} accessibilityRole="header">
        Account
      </Text>
      <View style={styles.group}>
        <RowAction
          label={accountState.user ? 'Manage account' : 'Account access'}
          detail={
            accountConfigured ? 'Open your separate account wallet' : 'Optional account wallets'
          }
          icon="user"
          disabled={busy}
          onPress={onAccount}
          testID="connections-account"
          last={!onCloudBackup && !onCloudWallet}
        />
        {onCloudWallet ? (
          <RowAction
            label="Cloud wallet"
            detail="Save status, local drafts and account storage"
            icon="wallet"
            disabled={busy}
            onPress={onCloudWallet}
            testID="connections-cloud-wallet"
            last={!onCloudBackup}
          />
        ) : null}
        {onCloudBackup ? (
          <RowAction
            label="Cloud backup"
            detail="Copy, back up or restore a wallet"
            icon="wallet"
            disabled={busy}
            onPress={onCloudBackup}
            testID="connections-cloud-backup"
            last
          />
        ) : null}
      </View>
      <Text style={[ui.hint, ui.smallGap]}>
        {cloudWalletConfigured
          ? 'Signed-in changes save to Firebase when connected. Previously downloaded records remain readable offline, and unsaved edits stay as drafts.'
          : accountConfigured
            ? 'Wallet records stay on this device until you explicitly back them up. Signing in does not upload or transfer them.'
            : 'No account service is configured. Your current wallet works without signing in.'}
      </Text>
      <Text style={[styles.section, ui.gap]} accessibilityRole="header">
        Receipts
      </Text>
      <ReceiptEntry connection={connection} busy={busy} onOpen={onReceipt} />
      <Text style={[ui.hint, ui.smallGap]} testID="connections-receipt-hint">
        Review a photo and confirm an expense.
        {!receiptProvider
          ? ' Receipt recognition is not selected. Manual entry is available.'
          : receiptProvider.processing === 'cloud'
            ? ' Google Cloud Vision receives the selected image through your configured service only when you request recognition.'
            : ' Windows OCR runs on the connected computer only when you request recognition.'}
        {' Choosing a photo alone sends nothing.'}
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
      <Text style={[ui.hint, ui.smallGap]} testID="connections-assistant-hint">
        Calculated facts are available without a model. Insights use the selected summaries, your
        question and up to three earlier exchanges from that conversation.
        {!assistantProvider
          ? ' No assistant provider is selected. Choose a report to review calculated facts.'
          : assistantProvider.processing === 'cloud'
            ? ' The selected OpenAI model receives them only when you choose Ask.'
            : ' The selected local model runs through the Windows companion only when you choose Ask.'}
      </Text>
      {connection.phase === 'configured' && connection.binding?.assistant ? (
        <Text style={[ui.hint, ui.smallGap]} testID="connections-assistant-status">
          An assistant connection is configured. Model availability is checked when you ask.
        </Text>
      ) : null}
      <Text style={[styles.section, ui.gap]} accessibilityRole="header">
        Expense forecasts
      </Text>
      <View style={styles.group}>
        <RowAction
          label="View expense forecasts"
          detail="Review recorded monthly spending"
          icon="reports"
          disabled={busy}
          onPress={onForecast ?? onReports}
          testID="connections-forecast"
          last
        />
      </View>
      <Text style={[ui.hint, ui.smallGap]}>
        Prophet uses selected monthly expense totals after your explicit request, on the configured
        backend or optional Windows helper. Device estimates remain available offline.
      </Text>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    section: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
    group: { backgroundColor: colors.surface, borderRadius: 18, overflow: 'hidden' },
  });

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Transaction } from './src/core/model';
import { Action, FormError, Sheet } from './src/ui/components';
import { CategoriesScreen } from './src/ui/CategoriesScreen';
import { TransactionEditor, newId } from './src/ui/TransactionEditor';
import { TransactionsScreen } from './src/ui/TransactionsScreen';
import { WalletScreen } from './src/ui/WalletScreen';
import { PlanScreen } from './src/ui/PlanScreen';
import { ReportsScreen } from './src/ui/ReportsScreen';
import { LoanCalculatorScreen } from './src/ui/LoanCalculatorScreen';
import { AchievementsScreen } from './src/ui/AchievementsScreen';
import { RemindersScreen } from './src/ui/RemindersScreen';
import { useThemedStyles, type ThemeColors } from './src/ui/theme';
import { ThemeProvider } from './src/ui/ThemeProvider';
import { MapPlacePicker } from './src/ui/MapPlacePicker';
import { useAccountRoot } from './src/ui/useAccountRoot';
import { AccountAccessGate, canShowAccountWallet } from './src/ui/AccountAccessGate';
import { AccountScreen, WalletAccountEntry } from './src/ui/AccountScreen';
import { ReportExportSheet } from './src/ui/ReportExportSheet';
import { TransactionExportSheet } from './src/ui/TransactionExportSheet';
import { NativeTransactionQr } from './src/ui/NativeTransactionQr';
import { ReceiptEntry } from './src/ui/ReceiptEntry';
import { ReceiptCaptureSheet } from './src/ui/ReceiptCaptureSheet';
import { AssistantPanel } from './src/ui/AssistantPanel';
import { AppIcon, type IconName } from './src/ui/AppIcon';
import { ConnectionsScreen } from './src/ui/ConnectionsScreen';
import { useCloudBackup } from './src/ui/useCloudBackup';
import { CloudBackupScreen } from './src/ui/CloudBackupScreen';
import { CloudWalletScreen } from './src/ui/CloudWalletScreen';
import { createTransactionDraftStore } from './src/drafts/transactionDrafts';
import type { ForecastTransportBinding } from './src/forecast/client';

type Tab =
  | 'transactions'
  | 'plan'
  | 'reports'
  | 'wallet'
  | 'categories'
  | 'loan'
  | 'achievements'
  | 'account'
  | 'connections'
  | 'cloud-backup'
  | 'cloud-wallet'
  | 'reminders';
const tabs: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'transactions', label: 'Activity', icon: 'activity' },
  { id: 'plan', label: 'Plan', icon: 'plan' },
  { id: 'reports', label: 'Reports', icon: 'reports' },
  { id: 'wallet', label: 'Wallet', icon: 'wallet' },
];

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}

export function AppContent() {
  const { colors, ui, styles, mode } = useThemedStyles(createStyles);
  const [tab, setTab] = useState<Tab>('transactions');
  const [assistantAccessRequested, setAssistantAccessRequested] = useState(false);
  const [editor, setEditor] = useState<{ transaction?: Transaction; sessionId: string } | null>(
    null,
  );
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const clearEditor = () => {
    editorRef.current = null;
    setEditor(null);
  };
  const account = useAccountRoot({
    hasOpenEditor: () => editorRef.current !== null,
    closeEditor: clearEditor,
    onReminderOpen: (data) => {
      setTab(
        data.kind === 'manual'
          ? 'reminders'
          : data.kind === 'achievement'
            ? 'achievements'
            : 'plan',
      );
    },
  });
  const { finance, photos, reminders, exports, companion, receipts, assistant } = account;
  const cloudWallet = account.cloudWallet;
  const editorDraftStore = useMemo(
    () =>
      editor && finance.ledger && account.deviceStorage
        ? createTransactionDraftStore(account.deviceStorage, {
            family: finance.family,
            incarnationId: finance.ledger.wallet.incarnationId,
            transactionId: editor.transaction?.id ?? null,
          })
        : undefined,
    [
      account.deviceStorage,
      finance.family,
      finance.ledger?.wallet.incarnationId,
      editor?.sessionId,
      editor?.transaction?.id,
    ],
  );
  const activeOwner = finance.ownerToken;
  const currentOwner = () => {
    const state = finance.getIdentityState();
    return (
      !!activeOwner &&
      state.ownerToken === activeOwner &&
      !state.identityPending &&
      !state.uncertain &&
      canShowAccountWallet(account.controller.getSnapshot(), activeOwner)
    );
  };
  const openCloudWallet = () => {
    if (!cloudWallet?.controller || saving || editorRef.current || receipts.hasOpenDraft()) return;
    exports.close();
    assistant.close();
    void receipts.close();
    setTab('cloud-wallet');
  };
  const cloud = useCloudBackup({
    finance,
    accountState: account.accountState,
    active: account.financialAllowed,
    hasOpenEditor: () => editorRef.current !== null || receipts.hasOpenDraft(),
  });
  const {
    ledger,
    loading,
    loadError,
    saving,
    saveError,
    status,
    save,
    restore,
    clearSaveError,
    getClock,
  } = finance;
  const openEditor = (transaction?: Transaction) => {
    exports.close();
    assistant.close();
    void receipts.close();
    clearSaveError();
    const next = { transaction, sessionId: newId('editor') };
    editorRef.current = next;
    setEditor(next);
  };
  const isWalletSubpage =
    tab === 'categories' ||
    tab === 'loan' ||
    tab === 'achievements' ||
    tab === 'reminders' ||
    tab === 'account' ||
    tab === 'connections' ||
    tab === 'cloud-backup' ||
    tab === 'cloud-wallet';
  const selectedTab = isWalletSubpage ? 'wallet' : tab;
  const accountConfigured = account.accountState.provider === 'configured';
  const receiptConfigured = companion.phase === 'configured' && Boolean(companion.binding?.receipt);
  const assistantConfigured =
    companion.phase === 'configured' && Boolean(companion.binding?.assistant);
  const forecastTransportBinding = useMemo<ForecastTransportBinding | null>(() => {
    const binding = companion.binding;
    const provider = binding?.providers.forecast;
    const expectedOwner = finance.ownerToken;
    const sourceLedger = finance.ledger;
    if (
      !binding?.forecast ||
      !provider ||
      !expectedOwner ||
      !sourceLedger ||
      !account.financialAllowed
    )
      return null;
    const expectedIdentityBinding = finance.getIdentityState().bindingToken;
    return Object.freeze({
      key: binding.key,
      transport: binding.forecast,
      provider,
      isCurrent: () => {
        const current = companion.getCurrent();
        const identity = finance.getIdentityState();
        return (
          current.phase === 'configured' &&
          current.binding === binding &&
          !identity.identityPending &&
          !identity.writeInFlight &&
          !identity.uncertain &&
          identity.ownerToken === expectedOwner &&
          identity.bindingToken === expectedIdentityBinding &&
          identity.ledger === sourceLedger &&
          canShowAccountWallet(account.controller.getSnapshot(), expectedOwner)
        );
      },
    });
  }, [
    companion.binding,
    companion.getCurrent,
    finance.ownerToken,
    finance.ledger,
    finance.getIdentityState,
    account.financialAllowed,
    account.controller,
  ]);
  const activeAccountName = account.accountState.user
    ? account.accountState.user.displayName || account.accountState.user.email || 'Account wallet'
    : 'Guest wallet';
  const headerName = accountConfigured ? activeAccountName : ledger?.wallet.name || 'My wallet';
  const idleStatus =
    status === 'Saved records are ready.' ||
    status === 'Your wallet is ready.' ||
    status === 'Sample transactions loaded. Try adding or editing an entry.';
  const openReceipt = () => {
    if (saving || editorRef.current || !account.financialAllowed) return;
    exports.close();
    assistant.close();
    clearSaveError();
    receipts.open();
  };
  useEffect(() => {
    clearEditor();
    setAssistantAccessRequested(false);
  }, [finance.ownerToken, loading, loadError]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!isWalletSubpage) return false;
      if (!saving && !account.accountState.busy)
        setTab(tab === 'cloud-backup' || tab === 'cloud-wallet' ? 'connections' : 'wallet');
      return true;
    });
    return () => subscription.remove();
  }, [isWalletSubpage, tab, saving, account.accountState.busy]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />
      {tab === 'account' ? (
        <AccountScreen controller={account.controller} onBack={() => setTab('wallet')} />
      ) : tab === 'cloud-wallet' && cloudWallet?.controller ? (
        <CloudWalletScreen
          controller={cloudWallet.controller}
          onBack={() => setTab('connections')}
          onAccount={() => setTab('account')}
        />
      ) : (
        <>
          <AccountAccessGate
            state={account.gateState}
            renderedOwnerToken={account.financialAllowed ? finance.ownerToken : null}
            onRetry={() => {
              void account.controller.retry();
            }}
            onSignOut={() => setTab('account')}
            onCloudRecovery={cloudWallet?.state.signedIn ? () => setTab('cloud-wallet') : undefined}
          >
            {loading ? (
              <View style={styles.center}>
                <ActivityIndicator size="large" color={colors.purple} />
                <Text style={[ui.body, { textAlign: 'center' }]}>Opening your local wallet…</Text>
              </View>
            ) : loadError || !ledger ? (
              <View style={styles.center}>
                <Text style={ui.title}>Your saved data could not be opened</Text>
                <Text style={ui.body}>
                  {saveError ||
                    'Saved data could not be confirmed. Check device storage, then reopen it before continuing. Recovery will not replace unreadable records with samples.'}
                </Text>
                <Action
                  label="Try again"
                  onPress={() => {
                    void restore();
                  }}
                  testID="retry-storage"
                />
              </View>
            ) : (
              <>
                <View style={styles.header}>
                  <View style={styles.brand}>
                    <View style={ui.flex}>
                      <Text style={styles.brandTitle} accessibilityLabel="My Money Management">
                        My Money
                      </Text>
                      {ledger.mode === 'sample' ? (
                        <Text style={styles.sampleHint} testID="sample-notice">
                          Sample data
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${accountConfigured ? 'Open account' : 'Open wallet settings'}. ${headerName}`}
                      accessibilityState={{ disabled: saving || account.accountState.busy }}
                      disabled={saving || account.accountState.busy}
                      onPress={() => setTab(accountConfigured ? 'account' : 'wallet')}
                      testID={accountConfigured ? 'open-header-account' : 'open-header-wallet'}
                      style={({ pressed }) => [styles.accountButton, pressed && ui.pressed]}
                    >
                      <AppIcon
                        name={accountConfigured ? 'user' : 'wallet'}
                        size={20}
                        color={colors.accent}
                      />
                      <Text
                        style={styles.accountLabel}
                        numberOfLines={2}
                        testID="wallet-active-account"
                      >
                        {headerName}
                      </Text>
                    </Pressable>
                  </View>
                  {cloudWallet?.state.signedIn && cloudWallet.state.readOnly ? (
                    <View style={ui.smallGap} testID="cloud-wallet-status-banner">
                      <Text style={ui.hint}>
                        {cloudWallet.state.message ||
                          'Cloud records need a connection check. Your drafts are retained.'}
                      </Text>
                      <Action
                        label="Check cloud wallet"
                        secondary
                        disabled={saving}
                        onPress={openCloudWallet}
                        testID="open-cloud-wallet-recovery"
                      />
                    </View>
                  ) : null}
                  {status && !idleStatus ? (
                    <Text
                      style={styles.status}
                      accessibilityLiveRegion="polite"
                      testID="save-status"
                    >
                      {status}
                    </Text>
                  ) : null}
                  {reminders.receivedMessage ? (
                    <Text style={styles.status} testID="reminder-received">
                      {reminders.receivedMessage}
                    </Text>
                  ) : null}
                  {reminders.startupError ? (
                    <Text style={styles.status}>
                      Open Reminders to retry previous-wallet notification cleanup.
                    </Text>
                  ) : null}
                  {photos.message ? (
                    <Text
                      style={styles.status}
                      accessibilityLiveRegion="polite"
                      testID="photo-cleanup-status"
                    >
                      {photos.message}
                    </Text>
                  ) : null}
                  {photos.pending ? (
                    <Action
                      label="Retry photo cleanup"
                      secondary
                      disabled={saving}
                      onPress={() => {
                        void photos.retry();
                      }}
                      testID="retry-photo-cleanup"
                    />
                  ) : null}
                  <FormError message={exports.error} testID="export-open-error" />
                  <FormError message={assistant.error} testID="assistant-open-error" />
                  <FormError message={receipts.error} testID="receipt-open-error" />
                  {receipts.cleanupPending ? (
                    <View style={ui.smallGap}>
                      <Text style={styles.status} testID="receipt-cleanup-status">
                        {receipts.cleanupMessage}
                      </Text>
                      <Action
                        label="Retry receipt image cleanup"
                        secondary
                        disabled={saving}
                        onPress={() => {
                          void receipts.retryCleanup();
                        }}
                        testID="receipt-cleanup-retry"
                      />
                    </View>
                  ) : null}
                </View>
                <View style={styles.page}>
                  {tab === 'achievements' ? (
                    <AchievementsScreen
                      key={ledger.wallet.incarnationId}
                      ledger={ledger}
                      saving={saving}
                      saveError={saveError}
                      onSave={save}
                      clearSaveError={clearSaveError}
                      getClock={getClock}
                      onBack={() => setTab('wallet')}
                    />
                  ) : null}
                  {tab === 'reminders' ? (
                    <RemindersScreen
                      key={reminders.coordinator?.ownerToken ?? 'opening'}
                      state={reminders.state}
                      coordinator={reminders.coordinator}
                      sampleMode={ledger.mode === 'sample'}
                      getBaselineKeys={reminders.getBaselineKeys}
                      onBack={() => setTab('wallet')}
                      startupError={reminders.startupError}
                      startupPending={reminders.startupPending}
                      onRetryStartup={reminders.retryStartup}
                      onResumeActiveOwner={reminders.resumeActiveOwner}
                      transitionBusy={saving}
                    />
                  ) : null}
                  {tab === 'reports' && account.financialAllowed && finance.ownerToken ? (
                    <ReportsScreen
                      key={finance.ownerToken}
                      forecastOwnerKey={finance.ownerToken}
                      getForecastToday={() => getClock().today}
                      ledger={ledger}
                      showAssistantShortcut={assistantConfigured || assistantAccessRequested}
                      forecastTransportBinding={forecastTransportBinding}
                      assistantRequested={assistantAccessRequested}
                      onExport={(range) => {
                        assistant.close();
                        exports.openReport(range);
                      }}
                      onAssistant={(range) => {
                        if (!editorRef.current && !receipts.hasOpenDraft()) {
                          exports.close();
                          assistant.open(range);
                        }
                      }}
                    />
                  ) : null}
                  {tab === 'transactions' ? (
                    <TransactionsScreen
                      receiptTools={
                        receiptConfigured ? (
                          <ReceiptEntry
                            connection={companion}
                            busy={saving}
                            compact
                            onOpen={openReceipt}
                          />
                        ) : undefined
                      }
                      ledger={ledger}
                      onAdd={() => openEditor()}
                      onEdit={openEditor}
                      onShare={(transaction) => {
                        clearEditor();
                        assistant.close();
                        void receipts.close();
                        exports.openTransaction(transaction.id);
                      }}
                    />
                  ) : null}
                  {tab === 'cloud-backup' ? (
                    <CloudBackupScreen
                      liveWallet={cloudWallet?.state.configured ?? false}
                      onCloudWallet={openCloudWallet}
                      key={finance.ownerToken ?? 'unconfigured'}
                      controller={cloud.controller}
                      onBack={() => setTab('connections')}
                      onAccount={() => setTab('account')}
                    />
                  ) : null}
                  {tab === 'connections' ? (
                    <ConnectionsScreen
                      cloudWalletConfigured={cloudWallet?.state.configured ?? false}
                      onCloudWallet={cloudWallet?.state.configured ? openCloudWallet : undefined}
                      accountState={account.accountState}
                      connection={companion}
                      busy={saving || account.accountState.busy}
                      onBack={() => setTab('wallet')}
                      onAccount={() => setTab('account')}
                      onCloudBackup={() => {
                        if (saving || editorRef.current || receipts.hasOpenDraft()) return;
                        exports.close();
                        assistant.close();
                        setTab('cloud-backup');
                      }}
                      onForecast={() => {
                        if (saving || editorRef.current || receipts.hasOpenDraft()) return;
                        exports.close();
                        assistant.close();
                        setAssistantAccessRequested(false);
                        setTab('reports');
                      }}
                      onReceipt={openReceipt}
                      onManualEntry={() => {
                        setTab('transactions');
                        openEditor();
                      }}
                      onReports={() => {
                        if (saving || editorRef.current || receipts.hasOpenDraft()) return;
                        exports.close();
                        assistant.close();
                        setAssistantAccessRequested(true);
                        setTab('reports');
                      }}
                    />
                  ) : null}
                  {tab === 'wallet' ? (
                    <WalletScreen
                      cloudAccount={cloudWallet?.state.signedIn ?? false}
                      showAccountShortcut={accountConfigured}
                      onOpenConnections={() => {
                        clearSaveError();
                        setTab('connections');
                      }}
                      accountEntry={
                        <WalletAccountEntry
                          state={account.accountState}
                          disabled={saving}
                          onOpen={() => setTab('account')}
                        />
                      }
                      ledger={ledger}
                      saving={saving}
                      saveError={saveError}
                      onSave={save}
                      clearSaveError={clearSaveError}
                      onManageCategories={() => {
                        clearSaveError();
                        setTab('categories');
                      }}
                      onOpenLoanCalculator={() => {
                        clearSaveError();
                        setTab('loan');
                      }}
                      onOpenAchievements={() => {
                        clearSaveError();
                        setTab('achievements');
                      }}
                      onOpenReminders={() => {
                        clearSaveError();
                        setTab('reminders');
                      }}
                    />
                  ) : null}
                  {tab === 'loan' ? (
                    <LoanCalculatorScreen
                      currency={ledger.wallet.currency}
                      onBack={() => setTab('wallet')}
                    />
                  ) : null}
                  {tab === 'categories' ? (
                    <CategoriesScreen
                      ledger={ledger}
                      saving={saving}
                      saveError={saveError}
                      onSave={save}
                      clearSaveError={clearSaveError}
                      onBack={() => {
                        clearSaveError();
                        setTab('wallet');
                      }}
                    />
                  ) : null}
                  {tab === 'plan' ? (
                    <PlanScreen
                      draftContext={
                        account.deviceStorage
                          ? {
                              deviceStorage: account.deviceStorage,
                              family: finance.family,
                              incarnationId: ledger.wallet.incarnationId,
                              isCurrent: currentOwner,
                            }
                          : undefined
                      }
                      ledger={ledger}
                      saving={saving}
                      saveError={saveError}
                      onSave={save}
                      clearSaveError={clearSaveError}
                    />
                  ) : null}
                </View>
                <View style={styles.tabBar} accessibilityRole="tablist">
                  {tabs.map((item) => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: selectedTab === item.id, disabled: saving }}
                      disabled={saving}
                      testID={`tab-${item.id}`}
                      onPress={() => {
                        clearSaveError();
                        exports.close();
                        assistant.close();
                        void receipts.close();
                        if (item.id !== 'reports') setAssistantAccessRequested(false);
                        setTab(item.id);
                      }}
                      style={({ pressed }) => [
                        styles.tab,
                        selectedTab === item.id && styles.selectedTab,
                        pressed && ui.pressed,
                      ]}
                    >
                      <AppIcon
                        name={item.icon}
                        size={23}
                        color={selectedTab === item.id ? colors.accent : colors.muted}
                      />
                      <Text
                        style={[styles.tabText, selectedTab === item.id && styles.selectedTabText]}
                      >
                        {item.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {editor ? (
                  <TransactionEditor
                    cloudAccount={cloudWallet?.state.signedIn ?? false}
                    draftStore={editorDraftStore}
                    isCurrent={() =>
                      editorRef.current?.sessionId === editor.sessionId && currentOwner()
                    }
                    ledger={ledger}
                    transaction={editor.transaction}
                    saving={saving}
                    saveError={saveError}
                    onSave={save}
                    clearSaveError={clearSaveError}
                    onClose={clearEditor}
                    context={{
                      sessionKey: JSON.stringify([
                        photos.familyToken,
                        ledger.wallet.incarnationId,
                        editor.sessionId,
                      ]),
                      photos: photos.photos ?? null,
                      services: photos.services ?? null,
                      renderPlacePicker: (props) => <MapPlacePicker {...props} />,
                      onCleanupMessage: (message) =>
                        photos.onCleanupMessage(finance.ownerToken!, message),
                    }}
                  />
                ) : null}
                {assistant.panel ? (
                  <Sheet
                    key={assistant.panel.sessionKey}
                    title="Financial assistant"
                    onClose={assistant.closeCurrent}
                  >
                    <AssistantPanel {...assistant.panel} onClose={assistant.closeCurrent} />
                  </Sheet>
                ) : null}
                {receipts.session ? (
                  <ReceiptCaptureSheet
                    cloudAccount={cloudWallet?.state.signedIn ?? false}
                    ledger={ledger}
                    binding={receipts.session.binding}
                    onSave={save}
                    saveError={saveError}
                    onClose={() => {
                      void receipts.closeCurrent();
                    }}
                    onManualEntry={() => openEditor()}
                  />
                ) : null}
                {exports.session?.kind === 'report' ? (
                  <ReportExportSheet
                    snapshot={exports.session.snapshot}
                    sessionKey={exports.session.sessionKey}
                    services={exports.session.controller}
                    onClose={exports.closeCurrent}
                  />
                ) : exports.session?.kind === 'transaction' ? (
                  <TransactionExportSheet
                    source={exports.session.source}
                    sessionKey={exports.session.sessionKey}
                    services={exports.session.controller}
                    renderQr={(props) => <NativeTransactionQr {...props} />}
                    onClose={exports.closeCurrent}
                  />
                ) : null}
              </>
            )}
          </AccountAccessGate>
          {!account.financialAllowed ? (
            <View style={{ padding: 20 }}>
              <Action
                label="Open account recovery"
                secondary
                onPress={() => setTab('account')}
                testID="open-account-recovery"
              />
            </View>
          ) : null}
        </>
      )}
      {(editor || receipts.hasOpenDraft()) && !account.financialAllowed ? (
        <View style={{ padding: 20, gap: 10 }}>
          <Text style={ui.body}>
            An open entry draft is blocking account recovery. Discard its unsaved edits to recheck
            the saved session.
          </Text>
          <Action
            label={
              receipts.hasOpenDraft()
                ? 'Discard receipt draft and recheck'
                : 'Discard transaction draft and recheck'
            }
            danger
            disabled={saving || account.accountState.busy}
            testID={
              receipts.hasOpenDraft()
                ? 'account-discard-receipt-recheck'
                : 'account-discard-draft-recheck'
            }
            onPress={() => {
              editorRef.current = null;
              setEditor(null);
              void receipts.close();
              void account.controller.retry();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 52,
    },
    center: {
      flex: 1,
      width: '100%',
      maxWidth: 600,
      padding: 28,
      justifyContent: 'center',
      alignItems: 'stretch',
      alignSelf: 'center',
      gap: 20,
    },
    header: {
      width: '100%',
      maxWidth: 680,
      alignSelf: 'center',
      paddingHorizontal: 20,
      paddingTop: 0,
      paddingBottom: 6,
    },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
    brandTitle: {
      color: colors.text,
      fontWeight: '600',
      fontSize: 17,
      lineHeight: 23,
      letterSpacing: -0.2,
    },
    accountButton: {
      minHeight: 48,
      maxWidth: '58%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingLeft: 12,
      paddingVertical: 6,
    },
    accountLabel: {
      color: colors.accent,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '600',
      flexShrink: 1,
    },
    sampleHint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
    status: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 2 },
    page: { flex: 1 },
    tabBar: {
      flexDirection: 'row',
      gap: 2,
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingHorizontal: 6,
      paddingTop: 5,
      paddingBottom: Platform.OS === 'ios' ? 30 : 24,
    },
    tab: {
      flex: 1,
      minHeight: 54,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
      paddingVertical: 7,
      borderRadius: 14,
      gap: 4,
    },
    selectedTab: { backgroundColor: colors.accentSoft },
    tabText: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '500',
      textAlign: 'center',
    },
    selectedTabText: { color: colors.accent, fontWeight: '600' },
  });

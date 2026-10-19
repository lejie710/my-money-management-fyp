import React, { useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Action, FormError, Screen } from './components';
import { useTheme } from './theme';
import { formatMoney } from '../core/model';
import type { CloudWalletController } from '../cloud/everydayController';

export function CloudWalletScreen({
  controller,
  onBack,
  onAccount,
}: {
  controller: CloudWalletController;
  onBack(): void;
  onAccount?(): void;
}) {
  const { ui } = useTheme();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [discardToken, setDiscardToken] = useState<string | null>(null);
  const preview = state.preview;
  return (
    <Screen>
      <Action
        label="Back to Connections"
        secondary
        onPress={onBack}
        disabled={state.busy}
        testID="cloud-wallet-back"
      />
      <Text style={[ui.title, ui.gap]}>Cloud wallet</Text>
      <Text style={[ui.body, ui.smallGap]}>
        Signed-in transactions, categories, budgets and your savings goal are confirmed by Firebase.
        Other devices read the same wallet. Your guest wallet stays on this device.
      </Text>
      {!state.configured ? (
        <Text style={[ui.body, ui.gap]}>
          Configure your own Firebase project to use an account wallet. Local tracking remains
          available.
        </Text>
      ) : !state.signedIn ? (
        <View style={ui.gap}>
          <Text style={ui.body}>
            Sign in to open your Firebase wallet. Existing device wallets are kept.
          </Text>
          {onAccount ? (
            <Action label="Open Account" onPress={onAccount} testID="cloud-wallet-account" />
          ) : null}
        </View>
      ) : (
        <>
          <View style={[ui.card, ui.gap]}>
            <Text style={ui.heading}>
              {state.readOnly ? 'Read-only until confirmed' : 'Cloud wallet ready'}
            </Text>
            <Text style={[ui.body, ui.smallGap]}>
              {state.message || 'Check the cloud wallet to confirm its latest saved version.'}
            </Text>
            {state.revision !== null ? (
              <Text style={[ui.hint, ui.smallGap]}>Confirmed revision {state.revision}</Text>
            ) : null}
            <Text style={[ui.hint, ui.smallGap]}>
              An offline view shows the last confirmed records. Edits are never reported saved
              before a server acknowledgement.
            </Text>
            {state.photosPending > 0 ? (
              <Text style={[ui.body, ui.smallGap]}>
                Some attached photos still need to download.
              </Text>
            ) : null}
          </View>
          {state.cleanupPending ? (
            <View style={[ui.card, ui.gap]}>
              <Text style={ui.body}>{state.cleanupMessage}</Text>
              <View style={ui.smallGap}>
                <Action
                  secondary
                  label="Retry photo cleanup"
                  disabled={state.busy}
                  onPress={() => {
                    void controller.retryCleanup();
                  }}
                  testID="cloud-wallet-cleanup"
                />
              </View>
            </View>
          ) : null}
          <View style={ui.gap}>
            <Action
              label="Refresh and reconcile"
              disabled={!state.canRefresh}
              onPress={() => {
                void controller.refresh();
              }}
              testID="cloud-wallet-refresh"
            />
          </View>
          <View style={[ui.card, ui.gap]}>
            <Text style={ui.heading}>Keep your existing device wallets</Text>
            <Text style={[ui.body, ui.smallGap]}>
              Copying is optional and requires an unchanged empty cloud wallet. Review the records
              and photos first. Your original account or guest wallet is never removed.
            </Text>
            <View style={ui.gap}>
              <Action
                secondary
                label="Preview this account's device wallet"
                disabled={!state.canCopy}
                onPress={() => {
                  void controller.previewCopy('local-account');
                }}
                testID="cloud-wallet-copy-local"
              />
            </View>
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Preview guest wallet copy"
                disabled={!state.canCopy}
                onPress={() => {
                  void controller.previewCopy('guest');
                }}
                testID="cloud-wallet-copy-guest"
              />
            </View>
          </View>
          {preview ? (
            <View style={[ui.card, ui.gap]}>
              <Text style={ui.heading}>Copy this wallet to Firebase?</Text>
              <Text style={[ui.body, ui.smallGap]}>{preview.walletName}</Text>
              <Text style={ui.body}>
                {preview.transactions} transactions · {preview.budgets} budgets · {preview.photos}{' '}
                photos
              </Text>
              <Text style={[ui.heading, ui.smallGap]}>
                {formatMoney(preview.balanceMinor, preview.currency)}
              </Text>
              <Text style={[ui.hint, ui.smallGap]}>
                Only the unchanged empty cloud target receives this copy. The device source is kept.
              </Text>
              <View style={ui.gap}>
                <Action
                  label="Confirm cloud copy"
                  disabled={state.busy}
                  onPress={() => {
                    void controller.confirmCopy(preview.token);
                  }}
                  testID="cloud-wallet-copy-confirm"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  secondary
                  label="Keep current wallets"
                  disabled={state.busy}
                  onPress={controller.cancelPreview}
                  testID="cloud-wallet-copy-cancel"
                />
              </View>
            </View>
          ) : null}
          {state.draft ? (
            <View style={[ui.card, ui.gap]}>
              <Text style={ui.heading}>Unfinished cloud save</Text>
              <Text style={[ui.body, ui.smallGap]}>
                {state.draft.phase === 'submitted'
                  ? 'A submitted save is unconfirmed. Reconcile or retry the same operation; it cannot be discarded as though nothing happened.'
                  : state.draft.phase === 'conflict'
                    ? 'Another device changed the wallet. The draft is retained, and has not overwritten the cloud version.'
                    : 'This device kept your unsubmitted draft. Retry deliberately when connected.'}
              </Text>
              <Text style={[ui.hint, ui.smallGap]}>
                {state.draft.transactions} transactions in draft · based on revision{' '}
                {state.draft.baseRevision}
              </Text>
              <View style={ui.gap}>
                <Action
                  label="Retry the same save"
                  disabled={!state.canRetryDraft}
                  onPress={() => {
                    void controller.retryDraft(state.draft!.token);
                  }}
                  testID="cloud-wallet-retry-draft"
                />
              </View>
              {state.canDiscardDraft ? (
                <View style={ui.smallGap}>
                  {discardToken === state.draft.token ? (
                    <Action
                      secondary
                      label="Confirm discard of this unsubmitted draft"
                      disabled={state.busy}
                      onPress={() => {
                        void controller.discardDraft(state.draft!.token);
                        setDiscardToken(null);
                      }}
                      testID="cloud-wallet-discard-confirm"
                    />
                  ) : (
                    <Action
                      secondary
                      label="Discard unsubmitted draft"
                      disabled={state.busy}
                      onPress={() => setDiscardToken(state.draft!.token)}
                      testID="cloud-wallet-discard-draft"
                    />
                  )}
                </View>
              ) : null}
            </View>
          ) : null}
          <Text style={[ui.hint, ui.gap]}>
            One cloud wallet supports up to 768 KiB of validated financial data and 100 attached
            photos. Manual backup remains a separate feature.
          </Text>
        </>
      )}
      <FormError message={state.error} testID="cloud-wallet-error" />
    </Screen>
  );
}

import React, { ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Action, FormError } from './components';
import type { AccountUiState } from './accountUiTypes';
import { colors, ui } from './theme';

export function canShowAccountWallet(state: AccountUiState, renderedOwnerToken: string | null) {
  return (
    state.phase === 'ready' &&
    state.persistence === 'confirmed' &&
    state.activeOwnerToken !== null &&
    state.activeOwnerToken === renderedOwnerToken
  );
}

/** Root must put the financial subtree behind this gate, not beneath a dismissible overlay. */
export function AccountAccessGate({
  state,
  renderedOwnerToken,
  onRetry,
  onSignOut,
  children,
}: {
  state: AccountUiState;
  renderedOwnerToken: string | null;
  onRetry: () => void;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  if (canShowAccountWallet(state, renderedOwnerToken)) return <>{children}</>;
  const loading =
    state.phase === 'restoring' || state.phase === 'opening-wallet' || state.phase === 'switching';
  const title =
    state.phase === 'restoring'
      ? 'Restoring local session…'
      : state.phase === 'opening-wallet'
        ? state.user
          ? "Opening this account's wallet…"
          : 'Opening your guest wallet…'
        : state.phase === 'switching'
          ? 'Checking account and saved records…'
          : state.phase === 'wallet-unavailable'
            ? 'This wallet could not be opened'
            : 'The saved session could not be confirmed';
  return (
    <View
      style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}
      testID="account-access-gate"
    >
      {loading ? <ActivityIndicator color={colors.purple} /> : null}
      <Text
        style={ui.title}
        testID={
          state.phase === 'opening-wallet' ? 'account-wallet-loading' : 'account-restore-loading'
        }
      >
        {title}
      </Text>
      {state.user?.email ? (
        <Text selectable style={ui.body}>
          {state.user.email}
        </Text>
      ) : null}
      <Text style={ui.body}>
        {state.message ||
          'Your saved wallets are retained. A guest or account wallet will appear only after its identity and stored data are confirmed.'}
      </Text>
      <FormError message={state.error} testID="account-session-error" />
      {state.canRetry ? (
        <Action
          secondary
          label="Check saved session"
          disabled={state.busy}
          onPress={onRetry}
          testID="account-check-session"
        />
      ) : null}
      {state.canSignOut && onSignOut ? (
        <Action
          secondary
          label="Return to guest wallet"
          disabled={state.busy}
          onPress={onSignOut}
          testID="account-recovery-sign-out"
        />
      ) : null}
    </View>
  );
}

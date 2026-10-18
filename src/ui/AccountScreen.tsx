import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Action, FormError, RowAction, Screen } from './components';
import { AccountCredentialsForm } from './AccountCredentialsForm';
import { AccountProfileForm } from './AccountProfileForm';
import { LocalResetForm } from './LocalResetForm';
import { useAccountOperation, useAccountView } from './useAccountView';
import type { AccountUiController, AccountUiState, LocalResetController } from './accountUiTypes';
import { ui } from './theme';

type Props = { controller: AccountUiController; onBack: () => void };
export function AccountScreen(props: Props) {
  const state = useAccountView(props.controller);
  return <AccountScreenContent key={state.viewToken} {...props} state={state} />;
}

function AccountScreenContent({ controller, state, onBack }: Props & { state: AccountUiState }) {
  const [route, setRoute] = useState<
    'home' | 'sign-in' | 'register' | 'profile' | 'reset' | 'sign-out'
  >('home');
  const [reset, setReset] = useState<LocalResetController | null>(null);
  const [pageError, setPageError] = useState('');
  const operation = useAccountOperation(`${state.viewToken}/account`);
  const busy = state.busy || operation.busy;
  const home = () => setRoute('home');
  const openReset = () => {
    if (!state.canRequestReset || busy) return;
    try {
      setPageError('');
      setReset(controller.createResetSession());
      setRoute('reset');
    } catch {
      setRoute('home');
      setPageError('The local reset inbox is unavailable. Check the saved session and try again.');
    }
  };
  const signOut = async () => {
    if (!state.canSignOut || busy) return;
    const result = await operation.run(() => controller.signOut());
    if (result?.ok) home();
  };
  const showAccountStatus = route === 'home' || route === 'sign-out';
  const accountError =
    pageError || state.error || (!operation.result?.ok ? (operation.result?.message ?? '') : '');
  return (
    <Screen>
      {route === 'home' ? (
        <>
          <Action
            secondary
            label="Back to Wallet"
            disabled={busy}
            onPress={onBack}
            testID="account-back"
          />
          <Text style={[ui.title, ui.gap]}>Account</Text>
          <Text style={[ui.body, ui.smallGap]}>
            {state.provider === 'unconfigured'
              ? 'Your wallet works without signing in. Accounts are an optional local connection.'
              : 'Accounts keep separate wallets on this device. Signing in does not upload or transfer your records.'}
          </Text>
          <View style={[ui.card, ui.gap]}>
            <Text style={ui.heading} testID="account-owner">
              {state.phase === 'ready'
                ? state.user?.displayName || state.user?.email || 'Wallet on this device'
                : 'Checking account access'}
            </Text>
            {state.phase === 'ready' && state.user?.email ? (
              <Text selectable style={[ui.body, ui.smallGap]}>
                {state.user.email}
              </Text>
            ) : null}
            {state.provider === 'configured' &&
            state.sessionRestored &&
            state.persistence === 'confirmed' ? (
              <Text style={[ui.hint, ui.smallGap]} testID="account-session-status">
                Session restored on this device.
              </Text>
            ) : null}
            <Text style={[ui.hint, ui.smallGap]} testID="account-service-status">
              {state.provider === 'unconfigured'
                ? 'No account service is configured in this build.'
                : state.service === 'unavailable'
                  ? 'Local account service unavailable.'
                  : state.service === 'available'
                    ? 'Local account service available.'
                    : 'Local account service has not been checked.'}
            </Text>
          </View>
          {state.profile.displayNamePending ? (
            <Text style={[ui.body, ui.smallGap]}>
              Your account was created. Its display name still needs to be saved in Profile.
            </Text>
          ) : null}
          {state.provider === 'unconfigured' ? (
            <Text style={[ui.body, ui.gap]} testID="account-setup-help">
              Local account access uses the optional Windows Auth emulator described in the project
              setup guide. You can return to your wallet and keep tracking without it.
            </Text>
          ) : null}
          {state.provider === 'configured' && state.phase === 'ready' && !state.user ? (
            <>
              <View style={ui.gap}>
                <Action
                  label="Sign in"
                  disabled={busy || !state.canSignIn}
                  onPress={() => setRoute('sign-in')}
                  testID="account-sign-in"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  secondary
                  label="Create account"
                  disabled={busy || !state.canRegister}
                  onPress={() => setRoute('register')}
                  testID="account-create"
                />
              </View>
            </>
          ) : null}
          {state.user ? (
            <View style={ui.gap}>
              <Action
                label="Edit profile"
                disabled={busy || !state.canEditProfile}
                onPress={() => setRoute('profile')}
                testID="account-edit-profile"
              />
            </View>
          ) : null}
          {state.canRequestReset ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Local password reset"
                disabled={busy}
                onPress={openReset}
                testID="account-reset"
              />
            </View>
          ) : null}
          {state.user || state.canSignOut ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Sign out to guest wallet"
                disabled={busy || !state.canSignOut}
                onPress={() => setRoute('sign-out')}
                testID="account-sign-out"
              />
            </View>
          ) : null}
          {state.canRetry ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Check saved session"
                disabled={busy}
                onPress={() => {
                  void operation.run(() => controller.retry());
                }}
                testID="account-retry"
              />
            </View>
          ) : null}
        </>
      ) : null}
      {route === 'sign-in' || route === 'register' ? (
        <AccountCredentialsForm
          key={route}
          mode={route}
          state={state}
          controller={controller}
          onBack={home}
          onReset={openReset}
        />
      ) : null}
      {route === 'profile' ? (
        <AccountProfileForm state={state} controller={controller} onBack={home} />
      ) : null}
      {route === 'reset' && reset ? (
        <LocalResetForm
          controller={reset}
          viewToken={state.viewToken}
          onBack={home}
          onSignIn={() => setRoute('sign-in')}
        />
      ) : null}
      {route === 'sign-out' ? (
        <View>
          <Text style={ui.heading}>Return to your guest wallet?</Text>
          <Text style={[ui.body, ui.smallGap]}>
            This account's saved records stay on this device. The guest wallet remains separate.
          </Text>
          <View style={ui.gap}>
            <Action
              label={busy ? 'Checking saved account state…' : 'Sign out and open guest wallet'}
              disabled={busy || !state.canSignOut}
              onPress={() => {
                void signOut();
              }}
              testID="account-sign-out-confirm"
            />
          </View>
          <View style={ui.smallGap}>
            <Action
              secondary
              label="Keep this account open"
              disabled={busy}
              onPress={home}
              testID="account-sign-out-cancel"
            />
          </View>
        </View>
      ) : null}
      {showAccountStatus && state.message && !accountError ? (
        <Text
          style={[ui.body, ui.gap]}
          accessibilityLiveRegion="polite"
          testID="account-transition-status"
        >
          {state.message}
        </Text>
      ) : null}
      {showAccountStatus && state.blockedReason ? (
        <Text style={[ui.body, ui.smallGap]}>{state.blockedReason}</Text>
      ) : null}
      {showAccountStatus ? (
        <FormError message={accountError} testID="account-status-error" />
      ) : null}
    </Screen>
  );
}

export function WalletAccountEntry({
  state,
  onOpen,
  disabled = false,
}: {
  state: AccountUiState;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <RowAction
      label="Account"
      icon="user"
      detail={
        state.phase === 'ready'
          ? state.user
            ? 'Separate local wallet for this account'
            : 'Using your guest wallet'
          : 'Review your saved session'
      }
      disabled={disabled}
      onPress={onOpen}
      testID="wallet-account"
      last
    />
  );
}

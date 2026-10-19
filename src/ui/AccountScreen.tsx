import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Action, Field, FormError, RowAction, Screen } from './components';
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
  const [requestedRoute, setRoute] = useState<
    | 'home'
    | 'sign-in'
    | 'register'
    | 'profile'
    | 'reset'
    | 'email-reset'
    | 'sign-out'
    | 'retire-session'
  >('home');
  const [retirement, setRetirement] = useState<{ token: string; viewToken: string } | null>(null);
  const retirementRef = useRef<{ token: string; viewToken: string } | null>(null);

  const [reset, setReset] = useState<LocalResetController | null>(null);
  const [pageError, setPageError] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [emailResetMessage, setEmailResetMessage] = useState('');
  const operation = useAccountOperation(`${state.viewToken}/account`);
  const busy = state.busy || operation.busy;
  const canRetire =
    !!state.canRetireSavedSession &&
    !!state.sessionRetirementToken &&
    !state.sessionRetired &&
    !!controller.retireSavedSession;
  const retirementCurrent =
    canRetire &&
    retirement !== null &&
    retirement.token === state.sessionRetirementToken &&
    retirement.viewToken === state.viewToken;
  // A changed capability/target cannot leave a stale confirmation on screen.
  const route = requestedRoute === 'retire-session' && !retirementCurrent ? 'home' : requestedRoute;
  if (!retirementCurrent) retirementRef.current = null;
  const home = () => {
    retirementRef.current = null;
    setRetirement(null);
    setRoute('home');
  };
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
  const retireSavedSession = async () => {
    if (
      !retirementCurrent ||
      !retirement ||
      retirementRef.current !== retirement ||
      busy ||
      !controller.retireSavedSession
    )
      return;
    const captured = retirement;
    const current = controller.getSnapshot();
    if (
      current.viewToken !== captured.viewToken ||
      current.sessionRetirementToken !== captured.token ||
      !current.canRetireSavedSession ||
      current.sessionRetired ||
      current.busy
    )
      return;
    const result = await operation.run(() => controller.retireSavedSession!(captured.token));
    if (result?.ok) {
      setRetirement(null);
      home();
    }
  };
  const showAccountStatus = route === 'home' || route === 'sign-out' || route === 'retire-session';
  const accountError =
    pageError || state.error || (!operation.result?.ok ? (operation.result?.message ?? '') : '');
  return (
    <Screen>
      {route === 'home' ? (
        <>
          <Action
            secondary
            label="Back to Wallet"
            disabled={busy || !!state.sessionRetired}
            onPress={onBack}
            testID="account-back"
          />
          <Text style={[ui.title, ui.gap]}>Account</Text>
          <Text style={[ui.body, ui.smallGap]}>
            {state.provider === 'unconfigured'
              ? 'Your wallet works without signing in. Accounts are an optional local connection.'
              : state.cloudAccount
                ? 'Firebase accounts keep separate wallets on this device. Cloud backup and guest copying require separate confirmation in Connections.'
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
            state.user &&
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
                  ? 'Account service unavailable.'
                  : state.service === 'available'
                    ? 'Account service available.'
                    : 'Account service has not been checked.'}
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
          {state.canRequestEmailReset ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Request password reset email"
                disabled={busy}
                onPress={() => {
                  setEmailResetMessage('');
                  setRoute('email-reset');
                }}
                testID="account-email-reset"
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
          {state.sessionRetired ? (
            <Text
              style={[ui.body, ui.gap]}
              accessibilityLiveRegion="polite"
              testID="account-session-retired"
            >
              Saved sign-in removed. Close and reopen the app to continue. Your saved wallets,
              profiles and photos have been kept.
            </Text>
          ) : null}
          {canRetire ? (
            <View style={ui.gap}>
              <Action
                secondary
                label="Remove unavailable saved sign-in"
                disabled={busy}
                onPress={() => {
                  const current = controller.getSnapshot();
                  if (
                    busy ||
                    !current.canRetireSavedSession ||
                    !current.sessionRetirementToken ||
                    current.sessionRetired ||
                    current.busy ||
                    current.viewToken !== state.viewToken
                  )
                    return;
                  operation.clear();
                  const confirmation = {
                    token: current.sessionRetirementToken,
                    viewToken: current.viewToken,
                  };
                  retirementRef.current = confirmation;
                  setRetirement(confirmation);
                  setRoute('retire-session');
                }}
                testID="account-remove-saved-sign-in"
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
      {route === 'email-reset' ? (
        <View>
          <Action secondary label="Back to Account" disabled={busy} onPress={home} />
          <Text style={[ui.title, ui.gap]}>Password reset</Text>
          <Text style={[ui.body, ui.smallGap]}>
            Request a reset from your configured Firebase project. A successful request does not
            confirm email delivery.
          </Text>
          <Field
            label="Account email"
            value={resetEmail}
            editable={!busy}
            autoCapitalize="none"
            keyboardType="email-address"
            onChangeText={(value) => {
              setResetEmail(value);
              setEmailResetMessage('');
            }}
            testID="email-reset-address"
          />
          <Action
            label={busy ? 'Requesting…' : 'Request reset email'}
            disabled={busy || !resetEmail.trim() || !controller.requestPasswordReset}
            onPress={() => {
              void operation.run(async () => {
                const result = await controller.requestPasswordReset!(resetEmail.trim());
                setEmailResetMessage(result.message);
                return result;
              });
            }}
            testID="email-reset-submit"
          />
          {emailResetMessage ? (
            <Text
              style={[ui.body, ui.gap]}
              accessibilityLiveRegion="polite"
              testID="email-reset-result"
            >
              {emailResetMessage}
            </Text>
          ) : null}
        </View>
      ) : null}
      {route === 'reset' && reset ? (
        <LocalResetForm
          controller={reset}
          viewToken={state.viewToken}
          onBack={home}
          onSignIn={() => setRoute('sign-in')}
        />
      ) : null}
      {route === 'retire-session' && retirementCurrent ? (
        <View>
          <Text style={ui.heading}>Remove this unavailable saved sign-in?</Text>
          <Text style={[ui.body, ui.smallGap]}>
            This removes only the saved sign-in from this device. It does not delete your account,
            wallets, profiles or photos. Close and reopen the app afterward, then sign in again.
          </Text>
          <View style={ui.gap}>
            <Action
              label={busy ? 'Checking saved sign-in.' : 'Remove saved sign-in'}
              disabled={busy || !retirementCurrent}
              onPress={() => {
                void retireSavedSession();
              }}
              testID="account-remove-saved-sign-in-confirm"
            />
          </View>
          <View style={ui.smallGap}>
            <Action
              secondary
              label="Keep saved sign-in"
              disabled={busy}
              onPress={() => {
                if (!busy && !controller.getSnapshot().busy) home();
              }}
              testID="account-remove-saved-sign-in-cancel"
            />
          </View>
        </View>
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

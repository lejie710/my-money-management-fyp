import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Action, Field, FormError } from './components';
import type { AccountUiController, AccountUiState } from './accountUiTypes';
import { useAccountOperation } from './useAccountView';
import { ui } from './theme';

export function AccountCredentialsForm({
  mode,
  controller,
  state,
  onBack,
  onReset,
}: {
  mode: 'sign-in' | 'register';
  controller: AccountUiController;
  state: AccountUiState;
  onBack: () => void;
  onReset: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const operation = useAccountOperation(`${state.viewToken}/${mode}`);
  const busy = state.busy || operation.busy;
  const allowed = mode === 'register' ? state.canRegister : state.canSignIn;
  const submit = async () => {
    if (busy || !allowed) return;
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    if (mode === 'register' && !name.trim()) {
      setError('Enter a display name.');
      return;
    }
    if (mode === 'register' && password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setError('');
    const result = await operation.run(() =>
      mode === 'register'
        ? controller.register({ email: email.trim(), password, displayName: name.trim() })
        : controller.signIn({ email: email.trim(), password }),
    );
    if (result?.ok || result?.pending) {
      setPassword('');
      setConfirmation('');
    }
    if (result?.ok) onBack();
  };
  return (
    <View>
      <Action
        secondary
        label="Back to Account"
        disabled={busy}
        onPress={onBack}
        testID="account-form-back"
      />
      <Text style={[ui.heading, ui.gap]}>
        {mode === 'register' ? 'Create a local demo account' : 'Sign in to a local demo account'}
      </Text>
      <Text style={[ui.body, ui.smallGap]}>
        Your guest wallet stays separate. Account access does not transfer or upload its records.
      </Text>
      {mode === 'register' ? (
        <Field
          label="Display name"
          testID="account-name"
          value={name}
          onChangeText={setName}
          maxLength={80}
          editable={!busy}
          autoComplete="name"
        />
      ) : null}
      <Field
        label="Email"
        testID="account-email"
        value={email}
        onChangeText={setEmail}
        editable={!busy}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
      />
      <Field
        label="Password"
        testID="account-password"
        value={password}
        onChangeText={setPassword}
        editable={!busy}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
        textContentType={mode === 'register' ? 'newPassword' : 'password'}
      />
      {mode === 'register' ? (
        <Field
          label="Confirm password"
          testID="account-password-confirm"
          value={confirmation}
          onChangeText={setConfirmation}
          editable={!busy}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
        />
      ) : null}
      <FormError
        message={
          error || state.error || (!operation.result?.ok ? (operation.result?.message ?? '') : '')
        }
        testID="account-error"
      />
      {state.blockedReason ? (
        <Text style={[ui.body, ui.smallGap]}>{state.blockedReason}</Text>
      ) : null}
      <View style={ui.gap}>
        <Action
          label={busy ? 'Checking account…' : mode === 'register' ? 'Create account' : 'Sign in'}
          disabled={busy || !allowed}
          onPress={() => {
            void submit();
          }}
          testID="account-submit"
        />
      </View>
      {state.canRetry ? (
        <View style={ui.smallGap}>
          <Action
            secondary
            label="Check saved session"
            disabled={busy}
            onPress={() => {
              void operation.run(() => controller.retry());
            }}
            testID="account-check-session"
          />
        </View>
      ) : null}
      {mode === 'sign-in' ? (
        <View style={ui.smallGap}>
          <Action
            secondary
            label="Local password reset"
            disabled={busy || !state.canRequestReset}
            onPress={onReset}
            testID="account-reset"
          />
        </View>
      ) : null}
    </View>
  );
}

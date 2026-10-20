import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Action, Field, FormError } from './components';
import type { LocalResetController } from './accountUiTypes';
import { useAccountOperation, useLocalResetView } from './useAccountView';
import { useTheme } from './theme';

export function LocalResetForm({
  controller,
  viewToken,
  onBack,
  onSignIn,
}: {
  controller: LocalResetController;
  viewToken: string;
  onBack: () => void;
  onSignIn: () => void;
}) {
  const { colors, ui } = useTheme();
  const state = useLocalResetView(controller);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const operation = useAccountOperation(`${viewToken}/reset`);
  const lifetime = useMemo(
    () => ({ timer: null as ReturnType<typeof setTimeout> | null, closed: false }),
    [controller],
  );
  const close = () => {
    if (!lifetime.closed) {
      lifetime.closed = true;
      controller.close();
    }
  };
  useEffect(() => {
    if (lifetime.timer !== null) {
      clearTimeout(lifetime.timer);
      lifetime.timer = null;
    }
    return () => {
      lifetime.timer = setTimeout(close, 0);
    };
  }, [controller, lifetime]);
  const busy = state.busy || operation.busy;
  const matching = !!state.email && state.email.toLowerCase() === email.trim().toLowerCase();
  const request = async () => {
    if (!email.trim()) {
      setError('Enter the local demo account email.');
      return;
    }
    setError('');
    setPassword('');
    setConfirmation('');
    await operation.run(() => controller.request(email.trim()));
  };
  const confirm = async () => {
    if (!password || password !== confirmation) {
      setError('Enter matching new passwords.');
      return;
    }
    setError('');
    const result = await operation.run(() => controller.confirm(password));
    if (result?.ok || result?.pending) {
      setPassword('');
      setConfirmation('');
    }
  };
  return (
    <View>
      <Action
        secondary
        label="Back to Account"
        disabled={busy}
        onPress={() => {
          close();
          onBack();
        }}
        testID="reset-back"
      />
      <Text style={[ui.heading, ui.gap]}>Local password reset</Text>
      <Text style={[ui.body, ui.smallGap]}>
        This demo creates a reset message in the local inbox. No email is delivered.
      </Text>
      <Field
        label="Local account email"
        value={email}
        onChangeText={(value) => {
          setEmail(value);
          setError('');
          operation.clear();
          setPassword('');
          setConfirmation('');
        }}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
        testID="reset-email"
      />
      <View style={ui.smallGap}>
        <Action
          label={
            state.phase === 'requesting' ? 'Requesting local reset…' : 'Request local reset message'
          }
          disabled={busy || !state.canRequest}
          onPress={() => {
            void request();
          }}
          testID="reset-request"
        />
      </View>
      {matching && state.messageAvailable && state.phase !== 'complete' ? (
        <View style={[ui.card, ui.gap]} testID="reset-message">
          <Text style={ui.heading}>Local inbox message</Text>
          <Text selectable style={[ui.body, ui.smallGap]}>
            Password reset for {state.email}
          </Text>
          <Text style={[ui.hint, ui.smallGap]}>
            Only this requested address is shown. The reset code stays inside this local session.
          </Text>
          {state.canVerify ? (
            <View style={ui.smallGap}>
              <Action
                secondary
                label={
                  state.phase === 'verifying' ? 'Checking message…' : 'Open and verify message'
                }
                disabled={busy}
                onPress={() => {
                  void operation.run(() => controller.verify());
                }}
                testID="reset-open-message"
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {matching && state.canRefresh ? (
        <View style={ui.smallGap}>
          <Action
            secondary
            label="Check local inbox"
            disabled={busy}
            onPress={() => {
              void operation.run(() => controller.refresh());
            }}
            testID="reset-inbox-refresh"
          />
        </View>
      ) : null}
      {matching && state.phase === 'verified' ? (
        <>
          <Field
            label="New password"
            value={password}
            onChangeText={setPassword}
            editable={!busy}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            testID="reset-password"
          />
          <Field
            label="Confirm new password"
            value={confirmation}
            onChangeText={setConfirmation}
            editable={!busy}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            testID="reset-password-confirm"
          />
          <View style={ui.smallGap}>
            <Action
              label="Set new password"
              disabled={busy || !state.canConfirm}
              onPress={() => {
                void confirm();
              }}
              testID="reset-apply"
            />
          </View>
        </>
      ) : null}
      {matching && state.phase === 'complete' ? (
        <View style={ui.gap}>
          <Text style={ui.body}>
            Password changed for {state.email}. Sign in with the new password.
          </Text>
          <View style={ui.smallGap}>
            <Action
              label="Go to sign in"
              disabled={busy}
              onPress={() => {
                close();
                onSignIn();
              }}
              testID="reset-sign-in"
            />
          </View>
        </View>
      ) : null}
      {matching && state.message ? (
        <Text style={[ui.body, ui.smallGap]} testID="reset-status">
          {state.message}
        </Text>
      ) : null}
      <FormError
        message={
          error ||
          (matching ? state.error : '') ||
          (!operation.result?.ok ? (operation.result?.message ?? '') : '')
        }
        testID="reset-error"
      />
    </View>
  );
}

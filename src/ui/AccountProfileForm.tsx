import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { validDate } from '../core/model';
import { Action, Choice, Field, FormError } from './components';
import type { AccountUiController, AccountUiState, ProfileGender } from './accountUiTypes';
import { useAccountOperation } from './useAccountView';
import { useTheme } from './theme';

const genders: { value: ProfileGender; label: string }[] = [
  { value: '', label: 'Not set' },
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'nonbinary', label: 'Nonbinary' },
  { value: 'prefer-not-to-say', label: 'Prefer not to say' },
];
export function AccountProfileForm({
  controller,
  state,
  onBack,
}: {
  controller: AccountUiController;
  state: AccountUiState;
  onBack: () => void;
}) {
  const { colors, ui } = useTheme();
  const [name, setName] = useState(state.user?.displayName ?? '');
  const [gender, setGender] = useState<ProfileGender>(state.profile.extras?.gender ?? '');
  const [birthDate, setBirthDate] = useState(state.profile.extras?.birthDate ?? '');
  const [error, setError] = useState('');
  const [extrasHydrated, setExtrasHydrated] = useState(state.profile.phase === 'ready');
  useEffect(() => {
    if (state.profile.phase !== 'ready') {
      setExtrasHydrated(false);
    } else if (!extrasHydrated) {
      setGender(state.profile.extras?.gender ?? '');
      setBirthDate(state.profile.extras?.birthDate ?? '');
      setExtrasHydrated(true);
    }
  }, [state.profile.phase, state.profile.extras, extrasHydrated]);
  const operation = useAccountOperation(`${state.viewToken}/profile`);
  const busy = state.busy || operation.busy;
  const saveName = () => {
    if (!name.trim()) {
      setError('Enter a display name, or go back without changing it.');
      return;
    }
    setError('');
    void operation.run(() => controller.updateDisplayName(name.trim()));
  };
  const saveExtras = () => {
    const date = birthDate.trim();
    if (date && (!validDate(date) || date > state.today)) {
      setError('Use a real birthday in YYYY-MM-DD format, no later than today, or leave it empty.');
      return;
    }
    setError('');
    void operation.run(() => controller.saveLocalProfile({ gender, birthDate: date || null }));
  };
  return (
    <View>
      <Action
        secondary
        label="Back to Account"
        disabled={busy}
        onPress={onBack}
        testID="profile-back"
      />
      <Text style={[ui.heading, ui.gap]}>Profile</Text>
      <Text selectable style={[ui.body, ui.smallGap]}>
        {state.user?.email}
      </Text>
      {state.profile.displayNamePending ? (
        <Text style={[ui.body, ui.smallGap]}>
          Your account is ready. Enter the display name you want and save it below.
        </Text>
      ) : null}
      <Field
        label="Display name"
        value={name}
        onChangeText={setName}
        maxLength={80}
        editable={!busy && state.canEditProfile}
        testID="profile-name"
      />
      <View style={ui.smallGap}>
        <Action
          label="Save display name"
          disabled={busy || !state.canEditProfile}
          onPress={saveName}
          testID="profile-save-name"
        />
      </View>
      <View style={ui.divider}>
        <Text style={ui.heading}>Optional local details</Text>
        <Text style={[ui.hint, ui.smallGap]}>
          These fields are optional and stay in this account's profile on this device.
        </Text>
        {state.profile.phase === 'ready' && extrasHydrated ? (
          <>
            <Text style={ui.fieldLabel}>Gender (optional)</Text>
            <View style={[ui.row, { flexWrap: 'wrap' }]} testID="profile-gender">
              {genders.map((item) => (
                <Choice
                  key={item.value}
                  label={item.label}
                  selected={gender === item.value}
                  disabled={busy || !state.canSaveLocalProfile}
                  onPress={() => setGender(item.value)}
                  testID={`profile-gender-${item.value || 'unset'}`}
                />
              ))}
            </View>
            <Field
              label="Birthday (YYYY-MM-DD, optional)"
              value={birthDate}
              onChangeText={setBirthDate}
              maxLength={10}
              editable={!busy && state.canSaveLocalProfile}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Leave empty if you prefer"
              testID="profile-birthdate"
            />
            <View style={ui.smallGap}>
              <Action
                secondary
                label="Save local details"
                disabled={busy || !state.canSaveLocalProfile}
                onPress={saveExtras}
                testID="profile-save-local"
              />
            </View>
          </>
        ) : (
          <Text style={[ui.body, ui.smallGap]}>
            {state.profile.phase !== 'unavailable'
              ? 'Opening saved profile details…'
              : 'Saved profile details could not be read. Existing data has been retained.'}
          </Text>
        )}
        <FormError message={state.profile.error} />
        {state.profile.phase === 'unavailable' ? (
          <View style={ui.smallGap}>
            <Action
              secondary
              label="Check saved profile"
              disabled={busy}
              onPress={() => {
                void operation.run(() => controller.retryProfile());
              }}
              testID="profile-retry-load"
            />
          </View>
        ) : null}
      </View>
      <FormError
        message={error || (!operation.result?.ok ? (operation.result?.message ?? '') : '')}
        testID="profile-error"
      />
      {operation.result?.ok ? (
        <Text style={[ui.body, ui.smallGap]} testID="profile-status">
          {operation.result.message}
        </Text>
      ) : null}
    </View>
  );
}

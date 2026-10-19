import React, { type ReactNode, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createAppearancePreferences,
  resolveAppearance,
  type AppearanceStore,
} from '../preferences/appearance';
import { createUi, darkPalette, lightPalette, ThemeContext, type ThemeValue } from './theme';
const preferences = createAppearancePreferences(AsyncStorage);
export function ThemeProvider({
  children,
  store = preferences,
}: {
  children: ReactNode;
  store?: AppearanceStore;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const systemScheme = useColorScheme();
  useEffect(() => {
    void store.initialize();
  }, [store]);
  useEffect(() => {
    Appearance.setColorScheme(snapshot.appearance === 'system' ? 'auto' : snapshot.appearance);
  }, [snapshot.appearance]);
  const mode = resolveAppearance(snapshot.appearance, systemScheme);
  const colors = mode === 'dark' ? darkPalette : lightPalette;
  const ui = useMemo(() => createUi(colors), [colors]);
  const value = useMemo<ThemeValue>(
    () => ({
      colors,
      ui,
      mode,
      appearance: snapshot.appearance,
      // Do not briefly reveal a previously hidden balance while preferences hydrate.
      balanceHidden: !snapshot.ready || snapshot.hideHomeBalance,
      preferencesReady: snapshot.ready,
      preferencesSaving: snapshot.saving,
      preferenceError: snapshot.error,
      setAppearance: store.setAppearance,
      setBalanceHidden: store.setBalanceHidden,
      retryPreferences: store.initialize,
    }),
    [colors, ui, mode, snapshot, store],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

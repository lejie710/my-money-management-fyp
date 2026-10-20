import { createContext, useContext, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { lightPalette, darkPalette } from './appearancePalette';
import type { AppearancePreference, AppearanceMode } from '../preferences/appearance';
export { lightPalette, darkPalette };
export type ThemeColors = { readonly [K in keyof typeof lightPalette]: string };
export const createUi = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      padding: 20,
      paddingTop: 12,
      paddingBottom: 36,
      width: '100%',
      maxWidth: 680,
      alignSelf: 'center',
    },
    title: {
      color: colors.text,
      fontSize: 32,
      lineHeight: 40,
      fontWeight: '700',
      letterSpacing: -0.8,
    },
    heading: {
      color: colors.text,
      fontSize: 17,
      lineHeight: 24,
      fontWeight: '600',
      letterSpacing: -0.2,
    },
    body: { color: colors.muted, fontSize: 15, lineHeight: 23 },
    hint: { color: colors.muted, fontSize: 13, lineHeight: 19 },
    card: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 18,
      padding: 18,
    },
    gap: { marginTop: 20 },
    smallGap: { marginTop: 10 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    between: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    flex: { flex: 1 },
    error: { color: colors.red, fontSize: 14, lineHeight: 21, marginTop: 12 },
    pressed: { opacity: 0.68 },
    disabled: { opacity: 0.5 },
    divider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.separator,
      marginTop: 24,
      paddingTop: 20,
    },
    fieldLabel: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 21,
      fontWeight: '600',
      marginTop: 18,
      marginBottom: 8,
    },
    input: {
      minHeight: 52,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.text,
      backgroundColor: colors.surface,
      fontSize: 16,
    },
    selectedText: { color: colors.accent, fontWeight: '600' },
    number: { fontVariant: ['tabular-nums'] },
  });

export type ThemeValue = {
  colors: ThemeColors;
  ui: ReturnType<typeof createUi>;
  mode: AppearanceMode;
  appearance: AppearancePreference;
  balanceHidden: boolean;
  preferencesReady: boolean;
  preferencesSaving: boolean;
  preferenceError: string;
  setAppearance(value: AppearancePreference): Promise<boolean>;
  setBalanceHidden(value: boolean): Promise<boolean>;
  retryPreferences(): Promise<boolean>;
};
export const ThemeContext = createContext<ThemeValue | null>(null);
export function useTheme(): ThemeValue {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('The app theme must be available.');
  return theme;
}
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T) {
  const theme = useTheme();
  const styles = useMemo(() => factory(theme.colors), [factory, theme.colors]);
  return { ...theme, styles };
}

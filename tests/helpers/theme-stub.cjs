const { lightPalette } = require('../../src/ui/appearancePalette');
function makeThemeStub(overrides = {}) {
  const theme = {
    colors: lightPalette,
    ui: {},
    mode: 'light',
    appearance: 'system',
    balanceHidden: false,
    preferencesReady: true,
    preferencesSaving: false,
    preferenceError: '',
    setAppearance: async () => true,
    setBalanceHidden: async () => true,
    retryPreferences: async () => true,
    ...overrides,
  };
  return {
    ...theme,
    useTheme: () => theme,
    useThemedStyles: (factory) => ({ ...theme, styles: factory(theme.colors) }),
    theme,
  };
}
module.exports = { makeThemeStub, themeStub: makeThemeStub() };

export type AppearancePreference = 'system' | 'light' | 'dark';
export type AppearanceMode = 'light' | 'dark';
export type AppearanceSnapshot = Readonly<{
  version: number;
  appearance: AppearancePreference;
  hideHomeBalance: boolean;
  ready: boolean;
  saving: boolean;
  error: string;
}>;
export interface AppearanceStore {
  getSnapshot(): AppearanceSnapshot;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<boolean>;
  setAppearance(value: AppearancePreference): Promise<boolean>;
  setBalanceHidden(value: boolean): Promise<boolean>;
}
export function resolveAppearance(
  preference: AppearancePreference,
  system: string | null | undefined,
): AppearanceMode;
export function createAppearancePreferences(storage: {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}): AppearanceStore;

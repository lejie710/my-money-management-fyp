export type OcrProvider = Readonly<
  | { engine: 'windows-media-ocr'; processing: 'local'; maxImageBytes: 10485760 }
  | { engine: 'google-cloud-vision'; processing: 'cloud'; maxImageBytes: 6291456 }
>;
export type AssistantProvider = Readonly<
  | { engine: 'lemonade'; processing: 'local'; model: 'Qwen3-4B-Instruct-2507-GGUF' }
  | { engine: 'openai'; processing: 'cloud'; model: string }
>;
export type ForecastProvider = Readonly<{
  engine: 'prophet';
  processing: 'local' | 'cloud';
  version: 'recorded-expense-prophet-v1';
  maxHistoryMonths: 120;
}>;
export type CompanionProviders = Readonly<{
  ocr: OcrProvider | null;
  assistant: AssistantProvider | null;
  forecast: ForecastProvider | null;
}>;
export type LocalCompanionProviders = Omit<CompanionProviders, 'forecast'> &
  Readonly<{ forecast: (ForecastProvider & { processing: 'local' }) | null }>;
export type HostedProviders = Readonly<{
  ocr: Extract<OcrProvider, { processing: 'cloud' }> | null;
  assistant: Extract<AssistantProvider, { processing: 'cloud' }> | null;
  forecast: (ForecastProvider & { processing: 'cloud' }) | null;
}>;
export type ProviderConfiguration =
  | { version?: 1; providers?: never }
  | { version: 2; runId?: string; providers: LocalCompanionProviders };
export const PROVIDER_HEADER: 'x-mymoney-provider';
export const LOCAL_MODEL_ID: 'Qwen3-4B-Instruct-2507-GGUF';
export const FORECAST_VERSION: 'recorded-expense-prophet-v1';
export const LEGACY_PROVIDERS: CompanionProviders;
export function validateProviders(value: unknown): LocalCompanionProviders;
export function validateHostedProviders(value: unknown): HostedProviders;
export function providersForConnection(configuration: ProviderConfiguration): CompanionProviders;
export function getProvider(
  configuration: ProviderConfiguration,
  capability: 'ocr',
): OcrProvider | null;
export function getProvider(
  configuration: ProviderConfiguration,
  capability: 'assistant',
): AssistantProvider | null;
export function getProvider(
  configuration: ProviderConfiguration,
  capability: 'forecast',
): ForecastProvider | null;
export function providerRequestBinding(
  configuration: ProviderConfiguration,
  capability: 'ocr' | 'assistant' | 'forecast',
): string | null;

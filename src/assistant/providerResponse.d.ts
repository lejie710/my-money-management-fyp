import type { AssistantProvider } from '../companion/providerContract';
export type AssistantProviderResponse = Readonly<{
  model: string;
  requestedModel?: string;
  content: string;
  finishReason: string;
  provider?: Readonly<{
    engine: 'lemonade' | 'openai';
    processing: 'local' | 'cloud';
    model: string;
    requestedModel?: string;
    backend?: 'vulkan' | 'cpu';
  }>;
}>;
export const LEGACY_ASSISTANT_PROVIDER: AssistantProvider;
export function assistantProvider(value?: AssistantProvider): AssistantProvider;
export function validateAssistantResponse(
  value: AssistantProviderResponse,
  expected?: AssistantProvider,
  legacyLocal?: boolean,
): AssistantProviderResponse;

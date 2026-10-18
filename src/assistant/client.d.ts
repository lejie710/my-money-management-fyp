import type { buildAssistantRequest } from './grounding';
import type { CompanionConnection } from '../companion/connection';
import type { AssistantProviderResponse } from './providerResponse';
export class AssistantError extends Error {
  readonly code: string;
  constructor(code: string);
}
/** Reuses the shared receipt companion connection; no extra public port/token. */
export function createAssistantClient(
  config: CompanionConnection | { url: string; token: string },
  options: {
    fetch?: typeof globalThis.fetch;
    createRequestId(): string;
    timeoutMs?: number;
  },
): {
  complete(
    payload: ReturnType<typeof buildAssistantRequest>,
    options?: { signal?: AbortSignal },
  ): Promise<AssistantProviderResponse>;
};

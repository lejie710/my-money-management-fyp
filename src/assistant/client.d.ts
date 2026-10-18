import type { buildAssistantRequest } from './grounding';
export class AssistantError extends Error {
  readonly code: string;
  constructor(code: string);
}
/** Reuses the shared receipt companion connection; no extra public port/token. */
export function createAssistantClient(
  config: { url: string; token: string },
  options: {
    fetch?: typeof globalThis.fetch;
    createRequestId(): string;
    timeoutMs?: number;
  },
): {
  complete(
    payload: ReturnType<typeof buildAssistantRequest>,
    options?: { signal?: AbortSignal },
  ): Promise<{ model: string; content: string; finishReason: string }>;
};

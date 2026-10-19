import type { AssistantContext, buildAssistantRequest, assessAnswer } from './grounding';
import type { AssistantProvider } from '../companion/providerContract';
import type { AssistantProviderResponse } from './providerResponse';
export const ASSISTANT_WAIT_MS: 125000;
export type SessionIdentity = Readonly<{
  actorKey: string;
  sessionKey: string;
  context: AssistantContext;
}>;
export type AssistantResult = (
  | { status: 'success'; response: Extract<ReturnType<typeof assessAnswer>, { accepted: true }> }
  | { status: 'rejected'; code: string }
  | {
      status:
        | 'cancelled'
        | 'stale'
        | 'busy'
        | 'invalid-question'
        | 'timeout'
        | 'invalid-provider-response'
        | 'unavailable';
    }
) & { generation: number; code?: string };
export function createAssistantSession(
  options: SessionIdentity & {
    expectedProvider?: AssistantProvider;
    /** Must compare actor, editor/chat session and immutable selected-context identity. */
    isCurrent(identity: SessionIdentity): boolean;
    /** Adapter owns generated wire request IDs, exact echo checks and bounded HTTP parsing. */
    transport(
      payload: ReturnType<typeof buildAssistantRequest>,
      options: { signal: AbortSignal },
    ): Promise<AssistantProviderResponse>;
    setTimer?: (callback: () => void, milliseconds: number) => unknown;
    clearTimer?: (timer: unknown) => void;
    createAbort?: () => AbortController;
  },
): {
  ask(
    question: string,
    history?: readonly Readonly<{ question: string; answer: string }>[],
  ): Promise<AssistantResult>;
  cancel(): void;
  close(): void;
  /** Check again immediately before displaying an awaited result. */
  isResultCurrent(result: AssistantResult): boolean;
  isBusy(): boolean;
};

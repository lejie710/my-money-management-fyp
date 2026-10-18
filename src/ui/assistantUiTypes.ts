import type { AssistantProvider } from '../companion/providerContract';
import type { Ledger } from '../core/model';
import type { AssistantContext, ContextSelection, FinancialFact } from '../assistant/grounding';
import type { createAssistantSession } from '../assistant/sessionGate';

export type AssistantTransport = Parameters<typeof createAssistantSession>[0]['transport'];
export type AssistantGroup = keyof NonNullable<ContextSelection['include']>;
export type AssistantPanelProps = {
  ledger: Ledger;
  /** Includes storage namespace, actor and wallet incarnation, without credentials. */
  actorKey: string;
  sessionKey: string;
  initialRange: { startDate: string; endDate: string };
  transport?: AssistantTransport;
  provider?: AssistantProvider;
  /** Root owner/connection guard, including the interval before the child rerenders. */
  isCurrent?: () => boolean;
  onClose?: () => void;
};
export type AssistantTurn = Readonly<{
  question: string;
  answer: string;
  facts: readonly FinancialFact[];
  context: AssistantContext;
}>;

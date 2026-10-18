import type { Ledger, Currency } from "../core/model";
export type ContextSelection = Readonly<{
  startDate: string;
  endDate: string;
  include?: Readonly<
    Partial<
      Record<
        "allDatesBalance" | "categories" | "budgets" | "goal" | "health",
        boolean
      >
    >
  >;
}>;
export type FinancialFact = Readonly<{
  id: string;
  label: string;
  value: string;
}>;
export type AssistantContext = Readonly<{
  version: 1;
  startDate: string;
  endDate: string;
  currency: Currency;
  recordedIncomeIsZero: boolean;
  selected: Readonly<
    Record<
      "allDatesBalance" | "categories" | "budgets" | "goal" | "health",
      boolean
    >
  >;
  facts: readonly FinancialFact[];
}>;
export const MODEL_ID: "Qwen3-4B-Instruct-2507-GGUF";
export const SYSTEM_PROMPT: string;
export function encodeData(value: unknown): string;
export const MAX_QUESTION_LENGTH: 500;
export const MAX_PROMPT_CHARACTERS: 6500;
export const MAX_OUTPUT_CHARACTERS: 1800;
/** No external effects; validates the ledger and copies only explicitly selected facts. */
export function buildAssistantContext(
  ledger: Ledger,
  selection: ContextSelection,
): AssistantContext;
/** Requires the original immutable context produced by buildAssistantContext, not a rehydrated object. */
export function buildAssistantRequest(
  context: AssistantContext,
  question: string,
): Readonly<{
  model: typeof MODEL_ID;
  messages: readonly Readonly<{ role: "system" | "user"; content: string }>[];
  temperature: 0;
  seed: 7;
  max_tokens: 160;
  stream: false;
}>;
export function assessAnswer(
  context: AssistantContext,
  content: unknown,
):
  | Readonly<{
      accepted: false;
      code:
        | "EMPTY_OR_OVERSIZED"
        | "INVALID_JSON"
        | "INVALID_RESPONSE"
        | "ZERO_CONFLATED_WITH_MISSING"
        | "OPENING_SCOPE_ERROR"
        | "WRITE_CLAIM";
    }>
  | Readonly<{
      accepted: true;
      answer: string;
      factIds: readonly string[];
      validation: "shape-and-known-defect-checks-only";
    }>;

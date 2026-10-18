import type { Currency } from "../core/model";
import type { FinancialFact, buildAssistantRequest } from "./grounding";
export const MODEL_ID: "Qwen3-4B-Instruct-2507-GGUF";
export const MESSAGES: Readonly<Record<string, string>>;
export class AssistantError extends Error {
  readonly code: string;
  constructor(code: string);
}
export type AssistantWire = {
  version: 1;
  requestId: string;
  templateVersion: "recorded-facts-v1";
  period: { startDate: string; endDate: string; inclusive: true };
  currency: Currency;
  facts: FinancialFact[];
  question: string;
};
export function requestId(value: unknown): value is string;
export function validateWire(value: unknown): AssistantWire;
export function payloadFromWire(
  value: unknown,
): ReturnType<typeof buildAssistantRequest>;
export function wireFromPayload(
  payload: ReturnType<typeof buildAssistantRequest>,
  id: string,
): AssistantWire;
export function renderQwenPrompt(
  payload: ReturnType<typeof buildAssistantRequest>,
): string;
export function responseFormatForPayload(
  payload: ReturnType<typeof buildAssistantRequest>,
): {
  type: "json_object";
  schema: {
    type: "object";
    properties: {
      answer: { type: "string"; minLength: 1; maxLength: 1200 };
      factIds: {
        type: "array";
        minItems: 1;
        maxItems: 8;
        items: { type: "string"; enum: string[] };
      };
    };
    required: string[];
    additionalProperties: false;
  };
};

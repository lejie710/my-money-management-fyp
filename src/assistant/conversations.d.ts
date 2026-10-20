import type { AssistantContext } from './grounding';
export type ConversationStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};
export type SavedConversation = {
  id: string;
  createdAt: number;
  updatedAt: number;
  walletId: string;
  walletName: string;
  provider: { engine: 'openai' | 'lemonade'; processing: 'cloud' | 'local'; model: string };
  context: AssistantContext;
  turns: { question: string; answer: string; factIds: string[] }[];
};
export function validateContext(value: unknown): AssistantContext;
export function validateConversation(value: unknown): SavedConversation;
export function createConversationStore(
  storage: ConversationStorage,
  ownerKey: string,
): {
  load(): Promise<SavedConversation[]>;
  save(record: SavedConversation, expectedUpdatedAt?: number | null): Promise<SavedConversation[]>;
  remove(id: string): Promise<SavedConversation[]>;
};
export const MAX_CONVERSATIONS: 20;
export const MAX_TURNS: 12;
export const MAX_STORE_CHARACTERS: 1000000;

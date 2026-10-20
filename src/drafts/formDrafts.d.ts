import type { DataFamily } from '../accounts/identity';
import type { BudgetDraft, GoalDraft } from '../core/model';
export type DraftStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
};
export type FinancialFormDraftContext = {
  deviceStorage: DraftStorage;
  family: DataFamily;
  incarnationId: string;
  isCurrent?: () => boolean;
};
export type SavedFormDraft =
  | { kind: 'budget'; entityId: string; baseFingerprint: string; fields: BudgetDraft }
  | { kind: 'goal'; entityId: string; baseFingerprint: string; fields: GoalDraft };
export type FormDraftSnapshot = { revision: number; record: SavedFormDraft | null };
export interface FinancialFormDraftStore {
  readonly key: string;
  readonly owner: Readonly<{
    familyKey: string;
    incarnationId: string;
    kind: 'budget' | 'goal';
    targetId: string | null;
  }>;
  load(): Promise<FormDraftSnapshot>;
  save(record: SavedFormDraft, expectedRevision: number): Promise<FormDraftSnapshot>;
  discard(expectedRevision: number): Promise<FormDraftSnapshot>;
}
export function validateFormDraft(value: unknown): SavedFormDraft;
export function createFinancialFormDraftStore(
  storage: DraftStorage,
  owner: {
    family: DataFamily;
    incarnationId: string;
    kind: 'budget' | 'goal';
    targetId?: string | null;
  },
): FinancialFormDraftStore;
export function createFormDraftWriter(
  store: FinancialFormDraftStore,
  initial: FormDraftSnapshot,
): {
  getSnapshot(): Readonly<{ saving: boolean; error: string; saved: boolean; revision: number }>;
  subscribe(listener: () => void): () => void;
  enqueue(record: SavedFormDraft): void;
  flush(): Promise<boolean>;
  discard(): Promise<boolean>;
  activate(): void;
  retire(): void;
};

import type { DataFamily } from '../accounts/identity';
import type { Draft, Ledger } from '../core/model';
import type { PersonSnapshot, PlaceSnapshot } from '../core/transactionContext';
export type SavedTransactionDraft = {
  baseFingerprint: string;
  transactionId: string;
  fields: Draft;
  details: { notes: string; person: PersonSnapshot | null; place: PlaceSnapshot | null };
  photoIntent: 'keep' | 'remove' | 'repick';
};
export type TransactionDraftSnapshot = { revision: number; record: SavedTransactionDraft | null };
export interface TransactionDraftStore {
  readonly key: string;
  readonly owner: Readonly<{
    familyKey: string;
    incarnationId: string;
    transactionId: string | null;
  }>;
  load(): Promise<TransactionDraftSnapshot>;
  save(record: SavedTransactionDraft, expectedRevision: number): Promise<TransactionDraftSnapshot>;
  discard(expectedRevision: number): Promise<TransactionDraftSnapshot>;
}
export function ledgerFingerprint(ledger: Ledger): string;
export function validateDraft(value: unknown): SavedTransactionDraft;
export function createTransactionDraftStore(
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
  },
  owner: { family: DataFamily; incarnationId: string; transactionId?: string | null },
): TransactionDraftStore;
export function createDraftWriter(
  store: TransactionDraftStore,
  initial: TransactionDraftSnapshot,
): {
  getSnapshot(): Readonly<{ saving: boolean; error: string; saved: boolean; revision: number }>;
  subscribe(listener: () => void): () => void;
  enqueue(record: SavedTransactionDraft): void;
  flush(): Promise<boolean>;
  discard(): Promise<boolean>;
  activate(): void;
  retire(): void;
};

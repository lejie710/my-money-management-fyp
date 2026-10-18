import { Ledger, LedgerIdentityContext } from './model';
import { PhotoRef } from './transactionContext';
export const STORAGE_KEY: string;
export const PREVIOUS_STORAGE_KEY: string;
export const VERSION_2_STORAGE_KEY: string;
export const VERSION_3_STORAGE_KEY: string;
export type PhotoReferenceSnapshot =
  { complete: true; references: PhotoRef[] } | { complete: false; reason: string };
export const LEGACY_STORAGE_KEY: string;
export const MIGRATION_STORAGE_KEYS: readonly string[];
export type StorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};
export type StorageOptions = {
  key?: string;
  legacyKey?: string | null;
  legacyKeys?: readonly string[];
  identityContext?: LedgerIdentityContext;
};
export function createLedgerStorage(
  adapter: StorageAdapter,
  options?: StorageOptions,
): {
  key: string;
  readCurrent(): Promise<Ledger | null>;
  withRetainedPhotoReferences<T>(
    work: (snapshot: PhotoReferenceSnapshot) => Promise<T>,
  ): Promise<T>;
  load(): Promise<Ledger | null>;
  save(ledger: Ledger): Promise<Ledger>;
};
export function loadOrCreateLedger(
  storage: { load(): Promise<Ledger | null>; save(ledger: Ledger): Promise<Ledger> },
  createInitialLedger: () => Ledger,
): Promise<{ ledger: Ledger; created: boolean }>;

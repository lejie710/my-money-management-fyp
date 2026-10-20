import type { Ledger } from '../core/model';
import type { LedgerStorage } from '../ui/ledgerRuntime';
import type { DataFamily } from '../accounts/identity';
import type { PhotoRef } from '../core/transactionContext';
import type { CloudWalletRecord, WalletPhoto } from './everydayFormat';
export type CloudDraft = {
  version: 1;
  familyToken: string;
  operationId: string;
  baseRevision: number;
  baseHash: string | null;
  createdAtMs: number;
  phase: 'draft' | 'submitted' | 'conflict';
  ledger: Ledger;
  record: CloudWalletRecord | null;
};
export type CloudStoreState = {
  status: string;
  busy: boolean;
  message: string;
  revision: number | null;
  readOnly: boolean;
  photosPending: number;
  draft: {
    token: string;
    phase: CloudDraft['phase'];
    baseRevision: number;
    transactions: number;
    photos: number;
  } | null;
};
export type EverydayPorts = {
  readWallet(walletId: string): Promise<unknown | null>;
  readOperation(walletId: string, operationId: string): Promise<unknown | null>;
  commitWallet(
    walletId: string,
    plan: { baseRevision: number; baseHash: string | null; record: CloudWalletRecord },
  ): Promise<unknown>;
  headPhoto(
    walletId: string,
    hash: string,
  ): Promise<{ size: number; sha256?: string; contentType?: string } | null>;
  putPhoto(walletId: string, hash: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getPhoto(walletId: string, hash: string, maxBytes: number): Promise<Uint8Array>;
};
export type EverydayFiles = {
  read(family: DataFamily, photo: PhotoRef): Promise<Uint8Array>;
  hydrate(
    family: DataFamily,
    storage: LedgerStorage,
    photos: WalletPhoto[],
    read: (item: WalletPhoto) => Promise<Uint8Array>,
    current: () => void,
  ): Promise<void>;
};
export type EverydayCloudStore = LedgerStorage & {
  kind: 'firebase-live';
  getSnapshot(): CloudStoreState;
  subscribe(listener: () => void): () => void;
  isReadOnly(): boolean;
  refresh(): Promise<Ledger | null>;
  retryDraft(token: string): Promise<Ledger>;
  discardDraft(token: string): Promise<void>;
  readDraft(): Promise<CloudDraft | null>;
};
export function createEverydayCloudStore(options: {
  family: DataFamily;
  deviceStorage: {
    getItem(k: string): Promise<string | null>;
    setItem(k: string, v: string): Promise<unknown>;
    removeItem(k: string): Promise<unknown>;
  };
  legacyStorage: LedgerStorage;
  ports(): EverydayPorts;
  files?: EverydayFiles;
  assertCurrent(family: DataFamily): void;
  now(): number;
  newId(): string;
}): EverydayCloudStore;

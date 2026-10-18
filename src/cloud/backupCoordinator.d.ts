import type { Ledger } from '../core/model';
import type { DataFamily } from '../accounts/identity';
import type { LedgerStorage } from '../ui/ledgerRuntime';
import type { CloudOwner, WalletSummary } from './backupFormat';
import type { CloudBackupIndex } from './transport';
export type CloudSetup = {
  configured: boolean;
  signedIn: boolean;
  projectId: string | null;
  mode: string | null;
  error: string;
};
export type CloudPreview = WalletSummary & {
  kind: 'backup' | 'restore' | 'guest-copy';
  createdAtMs?: number;
  includesPhotos?: boolean;
  backupId?: string;
};
export type BackupState = {
  journalBlocked: boolean;
  cleanupPending: boolean;
  cleanupMessage: string;
  busy: boolean;
  message: string;
  error: string;
  preview: CloudPreview | null;
  pending:
    (WalletSummary & { createdAtMs: number; backupId: string; includesPhotos: boolean }) | null;
  backups: CloudBackupIndex[];
  setup: CloudSetup;
};
export type BackupBinding = {
  family: DataFamily;
  ownerToken: string | null;
  ledger: Ledger;
  storage: LedgerStorage;
  allowed: boolean;
  compareAndSave(
    expectedOwnerToken: string,
    expectedLedgerJson: string,
    next: Ledger,
    message: string,
  ): Promise<boolean>;
};
export type BackupController = {
  getSnapshot(): BackupState;
  subscribe(listener: () => void): () => void;
  ownerChanged(): void;
  open(): Promise<boolean>;
  previewBackup(includePhotos: boolean): Promise<boolean>;
  confirmBackup(): Promise<boolean>;
  resumeBackup(): Promise<boolean>;
  discardPending(expectedId?: string | null): Promise<boolean>;
  listBackups(): Promise<boolean>;
  previewRestore(index: CloudBackupIndex): Promise<boolean>;
  confirmRestore(): Promise<boolean>;
  previewGuestCopy(includePhotos: boolean): Promise<boolean>;
  confirmGuestCopy(): Promise<boolean>;
  retryCleanup(): Promise<boolean>;
  clearPreview(): void;
  cancel(): void;
};
export function createBackupCoordinator(options: {
  getBinding(): BackupBinding | null;
  getSetup(): CloudSetup;
  readGuest(): Promise<{ family: DataFamily; ledger: Ledger | null }>;
  files: ReturnType<typeof import('./nativeFiles').createBackupFileServices>;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
    removeItem(key: string): Promise<unknown>;
  };
  transportFor(owner: CloudOwner): ReturnType<typeof import('./transport').createCloudTransport>;
  now?: () => number;
  newId(kind: string): string;
}): BackupController;

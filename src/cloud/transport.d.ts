import type { Currency } from '../core/model';
import type { CloudOwner, BackupSnapshot, BackupPhoto } from './backupFormat';
export type CloudBackupIndex = {
  version: 1;
  backupId: string;
  createdAtMs: number;
  currency: Currency;
  transactionCount: number;
  photoCount: number;
  snapshotBytes: number;
  snapshotHash: string;
  includesPhotos: boolean;
};
export function validateIndex(value: unknown): CloudBackupIndex;
export function createCloudTransport(options: {
  owner: CloudOwner;
  sdk: ReturnType<typeof import('./firebasePorts').createFirebasePorts>;
  timeoutMs?: number;
}): {
  list(options?: { signal?: AbortSignal }): Promise<CloudBackupIndex[]>;
  backup(
    snapshot: BackupSnapshot,
    readPhoto: (photo: BackupPhoto) => Promise<Uint8Array>,
    options?: { signal?: AbortSignal; onProgress?: (message: string) => void },
  ): Promise<CloudBackupIndex>;
  download(index: CloudBackupIndex, options?: { signal?: AbortSignal }): Promise<BackupSnapshot>;
  photo(
    snapshot: BackupSnapshot,
    photo: BackupPhoto,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array>;
};

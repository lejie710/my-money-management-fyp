import type { Ledger, Currency } from '../core/model';
import type { PhotoRef, PhotoInspection } from '../core/transactionContext';
export type CloudOwner = { projectId: string; uid: string };
export type BackupPhoto = PhotoInspection & { sha256: string; transactionIds: string[] };
export type BackupSnapshot = {
  version: 'mymoney-backup-v1';
  owner: CloudOwner;
  backupId: string;
  createdAtMs: number;
  includesPhotos: boolean;
  ledger: Ledger;
  photos: BackupPhoto[];
};
export type WalletSummary = {
  walletName: string;
  currency: Currency;
  transactions: number;
  budgets: number;
  hasGoal: boolean;
  balanceMinor: number;
  photos: number;
};
export const FORMAT: 'mymoney-backup-v1';
export const MAX_SNAPSHOT_BYTES: number, MAX_PHOTOS: number, MAX_TOTAL_PHOTO_BYTES: number;
export function utf8(text: string): Uint8Array;
export function decodeUtf8(bytes: Uint8Array): string;
export function portableLedger(value: Ledger): Ledger;
export function cloudOwner(value: unknown): CloudOwner;
export function backupId(value: unknown): string;
export function hashValue(value: unknown): string;
export function makeSnapshot(options: {
  ledger: Ledger;
  owner: CloudOwner;
  id: string;
  createdAtMs: number;
  photos?: BackupPhoto[];
  includePhotos?: boolean;
}): BackupSnapshot;
export function validateSnapshot(value: unknown, expectedOwner: CloudOwner): BackupSnapshot;
export function isEmptyTarget(ledger: Ledger): boolean;
export function restoreLedger(
  snapshot: BackupSnapshot,
  expectedOwner: CloudOwner,
  incarnationId: string,
  photoRefs?: Record<string, PhotoRef>,
): Ledger;
export function summary(ledger: Ledger): WalletSummary;

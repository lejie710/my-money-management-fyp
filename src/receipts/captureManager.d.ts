import type { ReminderOwner } from "../reminders/coordinator";
import type { PhotoInspection } from "../core/transactionContext";
export type ReceiptImageSelection = Readonly<{ id: string; uri: string }>;
export type ReceiptCaptureBytes = {
  bytes: Uint8Array;
  inspection: PhotoInspection;
};
export interface ReceiptCaptureFiles {
  readSource(uri: string): Promise<ReceiptCaptureBytes>;
  writeOwned(fileName: string, bytes: Uint8Array): Promise<void>;
  readOwned(fileName: string): Promise<ReceiptCaptureBytes>;
  statOwned(fileName: string): Promise<{ byteSize: number } | null>;
  removeOwned(fileName: string): Promise<void>;
  uriFor(fileName: string): string;
}
export type ReceiptCleanupResult = {
  deleted: number;
  retained: number;
  pending: boolean;
  message: string;
};
export type ReceiptCaptureManager = {
  readonly ownerToken: string;
  readonly sessionKey: string;
  readonly familyToken: string;
  readonly journalKey: string;
  readonly cameraAvailable: boolean;
  pickPhoto(): Promise<ReceiptImageSelection | null>;
  takePhoto(): Promise<ReceiptImageSelection | null>;
  readBytes(
    image: ReceiptImageSelection,
    options: { signal: AbortSignal },
  ): Promise<Uint8Array>;
  /** Idempotent for this binding's registered handles, including after close. */
  release(image: ReceiptImageSelection): Promise<void>;
  /** Explicitly retries released/abandoned registered snapshots in this family only. */
  retryCleanup(): Promise<ReceiptCleanupResult>;
  /** Invalidates new work and drains own reads/writes. Published images remain pinned until release, after UI closeDraft drains external permanent-photo copies. */
  close(): Promise<ReceiptCleanupResult>;
};
export function createReceiptCaptureManager(options: {
  owner: ReminderOwner;
  sessionKey: string;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
  };
  files: ReceiptCaptureFiles;
  picker: {
    cameraAvailable: boolean;
    pick(kind: "library" | "camera"): Promise<{ uri: string } | null>;
  };
  newId(): string;
  isCurrent(): boolean;
}): ReceiptCaptureManager;
export function receiptCaptureFamilyToken(owner: ReminderOwner): string;
export function receiptCaptureJournalKey(owner: ReminderOwner): string;
export const MAX_RECEIPT_CAPTURES: 8;
export class ReceiptCaptureError extends Error {
  constructor(code: string, message: string);
  readonly code: string;
}

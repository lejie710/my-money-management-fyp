import { PhotoRef, PhotoInspection } from '../core/transactionContext';
import { PhotoReferenceSnapshot } from '../core/storage';
import { ReminderScope, ReminderActor } from '../reminders/coordinator';
export type { PhotoRef, PhotoInspection } from '../core/transactionContext';
export type PhotoFamily = { scope: ReminderScope; actor: ReminderActor };
export type PickedPhoto = { uri: string };
export type PhotoDraft = { readonly id: string; readonly ownerIncarnationId: string };
export type PhotoCleanupResult = {
  deleted: number;
  retained: number;
  pending: boolean;
  message: string;
};
export type PhotoFileAdapter = {
  inspectSource(uri: string): Promise<PhotoInspection>;
  copyIntoOwned(sourceUri: string, photo: PhotoRef): Promise<void>;
  inspectOwned(photo: PhotoRef): Promise<PhotoInspection | null>;
  uriFor(photo: PhotoRef): string;
  removeOwned(photo: PhotoRef): Promise<void>;
};
export interface PhotoManager {
  readonly familyToken: string;
  readonly journalKey: string;
  initialize(): Promise<PhotoCleanupResult>;
  beginDraft(ownerIncarnationId: string): PhotoDraft;
  stage(draft: PhotoDraft, picked: PickedPhoto): Promise<PhotoRef>;
  /** Register a verified download only when its exact reference is already retained by this family. */
  importRetained(photo: PhotoRef, picked: PickedPhoto): Promise<PhotoRef>;
  closeDraft(draft: PhotoDraft): Promise<PhotoCleanupResult>;
  queueCleanup(photos: readonly PhotoRef[]): Promise<PhotoCleanupResult>;
  retryCleanup(): Promise<PhotoCleanupResult>;
  inspect(photo: PhotoRef): Promise<PhotoInspection | null>;
  uriFor(photo: PhotoRef): string;
  dispose(): void;
  /** Waits for already queued family work, including disposal, without scheduling cleanup. */
  drain(): Promise<void>;
}
export const MAX_PHOTO_ENTRIES: 20000;
export function photoFamilyToken(family: PhotoFamily): string;
export function createPhotoManager(options: {
  family: PhotoFamily;
  files: PhotoFileAdapter;
  journal: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
  };
  ledgerStorage: {
    withRetainedPhotoReferences<T>(
      work: (snapshot: PhotoReferenceSnapshot) => Promise<T>,
    ): Promise<T>;
  };
  now: () => number;
  newId: (kind: 'draft' | 'photo') => string;
}): PhotoManager;

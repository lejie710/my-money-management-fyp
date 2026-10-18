export type PersonSnapshot = { name: string; source: 'manual' | 'contacts' | 'recorded' };
export type PlaceSnapshot = { label: string; source: 'manual' | 'device' | 'map' | 'recorded' };
export type PhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';
export type PhotoInspection = {
  mimeType: PhotoMime;
  width: number;
  height: number;
  byteSize: number;
};
export type PhotoRef = PhotoInspection & {
  id: string;
  ownerIncarnationId: string;
  fileName: string;
};
export type TransactionContext = {
  notes: string;
  photo: PhotoRef | null;
  withPerson: PersonSnapshot | null;
  location: PlaceSnapshot | null;
};
export type TransactionContextPatch = {
  notes?: string | null;
  photo?: PhotoRef | null;
  withPerson?: PersonSnapshot | null;
  location?: PlaceSnapshot | null;
};
export const MAX_NOTES_LENGTH: 2000;
export const MAX_PERSON_NAME_LENGTH: 120;
export const MAX_PLACE_LABEL_LENGTH: 240;
export const MAX_PHOTO_BYTES: number;
export const MAX_PHOTO_DIMENSION: 16384;
export const MAX_PHOTO_PIXELS: 40000000;
export const MIME_EXTENSIONS: Readonly<Record<PhotoMime, string>>;
export function validatePhotoInspection(value: unknown): PhotoInspection;
export function validatePhotoRef(value: unknown, ownerIncarnationId?: string): PhotoRef;
export function photoKey(photo: PhotoRef): string;
export function samePhotoRef(left: PhotoRef, right: PhotoRef): boolean;
export function emptyTransactionContext(): TransactionContext;
export function validateTransactionContext(
  value: unknown,
  ownerIncarnationId?: string,
): TransactionContext;
export function contextForTransaction(transaction: {
  context?: TransactionContext;
}): TransactionContext;
export function normalizeContextPatch(
  patch: TransactionContextPatch | null,
): TransactionContextPatch | null;
export function applyContextPatch<T extends { context?: TransactionContext }>(
  transaction: T,
  patch: TransactionContextPatch | null,
  ownerIncarnationId: string,
): T & { context: TransactionContext };
export function promoteLegacyContext<T extends { context?: TransactionContext }>(
  transaction: T,
  ownerIncarnationId?: string,
): T;

import type { PhotoManager } from '../attachments/photoManager';
import type { ReceiptClient } from '../receipts/client';

/** Validated, immutable app-owned temporary image; never a bare provider URI. */
export type ReceiptImageSelection = { readonly id: string; readonly uri: string };
export type ReceiptCaptureServices = {
  cameraAvailable: boolean;
  pickPhoto(): Promise<ReceiptImageSelection | null>;
  /** Uses the device camera; the owned emulator uses its virtual scene, never the host webcam. */
  takePhoto(): Promise<ReceiptImageSelection | null>;
  readBytes(image: ReceiptImageSelection, options: { signal: AbortSignal }): Promise<Uint8Array>;
  /** Deletes only this service's temporary snapshot, never the selected gallery original. */
  release(image: ReceiptImageSelection): Promise<void>;
};
export type ReceiptUiBinding = {
  sessionKey: string;
  photos: PhotoManager | null;
  capture: ReceiptCaptureServices;
  client: ReceiptClient | null;
  today: string;
  onCleanupMessage?: (message: string) => void;
  onPhotoCleanupMessage?: (message: string) => void;
  /** Exact root owner/session/connection binding; checked before every UI effect. */
  isCurrent?: () => boolean;
  /** Root can synchronously abort the draft before a hidden native callback completes. */
  attachLifecycle?: (close: () => Promise<void>) => () => void;
};

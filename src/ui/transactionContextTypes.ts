import type { PersonSnapshot, PlaceSnapshot } from '../core/transactionContext';
import type { PickedPhoto, PhotoManager } from '../attachments/photoManager';
import type { ReactNode } from 'react';

export type PlaceCandidate = {
  label: string | null;
  coordinate: { latitude: number; longitude: number };
  source: 'device' | 'map';
  capturedAtMs: number;
  accuracyMeters: number | null;
};

export type TransactionContextServices = {
  /** Returns only a supported, inspected local asset; never an unvalidated preview URI. */
  pickPhoto(): Promise<PickedPhoto | null>;
  pickContactName(): Promise<PersonSnapshot | null>;
  currentPlace(): Promise<PlaceCandidate>;
  placeAt(coordinate: { latitude: number; longitude: number }): Promise<PlaceCandidate>;
};

export type PlacePickerProps = {
  initialLabel: string;
  services: Pick<TransactionContextServices, 'currentPlace' | 'placeAt'>;
  sessionKey: string;
  onConfirm: (place: PlaceSnapshot) => void;
  onCancel: () => void;
};
export type RenderPlacePicker = (props: PlacePickerProps) => ReactNode;
export type TransactionContextBinding = {
  sessionKey: string;
  photos: PhotoManager | null;
  services: TransactionContextServices | null;
  renderPlacePicker?: RenderPlacePicker;
  /** Bind/filter this callback to sessionKey so retired-owner cleanup cannot alter new-owner UI. */
  onCleanupMessage?: (message: string) => void;
};

export type Coordinate = Readonly<{ latitude: number; longitude: number }>;
export type PlaceCandidate = Readonly<{
  label: string | null;
  coordinate: Coordinate;
  source: 'map' | 'device';
  capturedAtMs: number;
  accuracyMeters: number | null;
}>;
export const MAX_PLACE_LABEL_LENGTH: 240;
export const PLACE_LOOKUP_TIMEOUT_MS: 50000;
export function coordinateFromMap(value: unknown): Coordinate;
export function validatePlaceCandidate(
  value: unknown,
  source: 'map' | 'device',
  requestedCoordinate?: Coordinate,
): PlaceCandidate;
export function confirmedPlace(label: string, candidate: PlaceCandidate | null): PlaceSnapshot;
export function loadMapRuntime<T>(options: {
  platform: string;
  isExpoGo: boolean;
  getNativeModule(name: string): unknown;
  loadRuntime(): T;
}): { available: false; message: string } | { available: true; runtime: T };
export type LookupResult<T> = (
  { status: 'success'; value: T } | { status: 'cancelled' | 'timeout' | 'error' }
) & { requestId: number };
export function createPlaceLookup(options?: {
  timeoutMs?: number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): {
  run<T>(work: () => Promise<T>): Promise<LookupResult<T>>;
  cancel(): void;
  isCurrent(result: { requestId: number }): boolean;
};
import type { PlaceSnapshot } from '../core/transactionContext';
export type { PlaceSnapshot } from '../core/transactionContext';

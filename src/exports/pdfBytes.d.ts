import type { PhotoInspection } from '../core/transactionContext';
export function isPdfHeader(bytes: Uint8Array): boolean;
export const PDF_TAIL_SCAN_BYTES: 2048;
export const PDF_XREF_SCAN_BYTES: 1024;
export function readPdfEnvelope(
  header: Uint8Array,
  tail: Uint8Array,
  byteSize: number,
): { xrefOffset: number } | null;
export function isPdfXrefStart(bytes: Uint8Array): boolean;
export function validatePdfFileName(name: string): string;
export function validateCacheUri(uri: string, cacheUri: string, excludedRoot?: string): string;
export function photoDataUrl(bytes: Uint8Array, expected: PhotoInspection): string;

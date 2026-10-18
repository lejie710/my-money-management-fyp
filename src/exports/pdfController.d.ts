import type { ReminderOwner } from '../reminders/coordinator';
import type { ReportExportSnapshot, TransactionExportSnapshot, ExportImage } from '../core/exports';
export type ExportSnapshot = ReportExportSnapshot | TransactionExportSnapshot;
export type PdfArtifact = Readonly<{
  id: string;
  ownerToken: string;
  kind: 'report' | 'transaction';
  fileName: string;
  uri: string;
  byteSize: number;
  pageCount: number;
  createdAtMs: number;
}>;
export type PdfInspection = { byteSize: number; pdfHeaderValid: boolean };
export type PdfAdapter = {
  printHtml(html: string): Promise<{ uri: string; numberOfPages: number }>;
  inspectPdf(uri: string): Promise<PdfInspection | null>;
  uriFor(fileName: string): string;
  retainOwnedPdf(sourceUri: string, fileName: string): Promise<void>;
  removeOwned(fileName: string): Promise<void>;
  cacheUsage(): Promise<{ count: number; byteSize: number }>;
  sharingAvailable(): Promise<boolean>;
  sharePdf(uri: string): Promise<void>;
  previewPdf?(uri: string): Promise<void>;
};
export type PdfCleanupResult = { deleted: number; retained: number; pending: boolean };
export interface PdfController {
  readonly ownerToken: string;
  readonly journalKey: string;
  prepare(snapshot: ExportSnapshot): Promise<{ artifact: PdfArtifact; warning?: string }>;
  share(artifact: PdfArtifact): Promise<{ status: 'requested' | 'unavailable' }>;
  preview(artifact: PdfArtifact): Promise<{ status: 'requested' | 'unavailable' }>;
  prune(): Promise<PdfCleanupResult>;
  /** Suppresses pending UI completions; does not cancel native work or delete a shared file. */
  close(): void;
}
export const MAX_PDF_BYTES: number;
export const MIN_PDF_BYTES: 64;
export const MAX_PDF_CACHE_BYTES: number;
export const MAX_PDF_FILES: 20;
export const MAX_PDF_PAGES: 500;
export const PDF_RETENTION_MS: number;
export class PdfExportError extends Error {
  constructor(code: string, message: string);
  readonly code: string;
}
export function pdfJournalKey(owner: ReminderOwner): string;
export function createPdfController(options: {
  owner: ReminderOwner;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
  };
  adapter: PdfAdapter;
  buildHtml(snapshot: ExportSnapshot, image?: ExportImage): string;
  prepareImage?(
    snapshot: TransactionExportSnapshot,
  ): Promise<{ image: ExportImage; warning?: string }>;
  isCurrent(): boolean;
  now(): number;
  newId(): string;
}): PdfController;

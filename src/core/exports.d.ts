import { Currency, Ledger, TransactionType } from './model';
import { PhotoRef, PhotoMime, TransactionContext } from './transactionContext';
export type ContextSelection = {
  notes: boolean;
  withPerson: boolean;
  location: boolean;
  photo: boolean;
};
export const DEFAULT_CONTEXT_SELECTION: Readonly<ContextSelection>;
export const MAX_QR_UTF8_BYTES: 1024;
export const MAX_EXPORT_CATEGORY_ROWS: 500;
export const MAX_EXPORT_MONTHS: 120;
export const MAX_EXPORT_HTML_BYTES: number;
export type ExportBase = {
  readonly version: 1;
  readonly createdAtMs: number;
  readonly mode: 'sample' | 'local';
  readonly walletName: string;
  readonly currency: Currency;
};
export type ExportCategory = {
  readonly categoryName: string;
  readonly type: TransactionType;
  readonly amountMinor: number;
  readonly typeTotalMinor: number;
  readonly shareOfType: number;
  readonly transactionCount: number;
};
export type ExportMonth = {
  readonly month: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly netMinor: number;
  readonly isPartialPeriod: boolean;
};
export type ReportExportSnapshot = ExportBase & {
  readonly kind: 'report';
  readonly startDate: string;
  readonly endDate: string;
  readonly openingMinor: number;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly debtMinor: number;
  readonly outflowMinor: number;
  readonly netMinor: number;
  readonly closingMinor: number;
  readonly currentBalanceMinor: number;
  readonly transactionCount: number;
  readonly hasActivity: boolean;
  readonly categoryBreakdown: readonly ExportCategory[];
  readonly monthly: readonly ExportMonth[];
};
export type TransactionExportSnapshot = ExportBase & {
  readonly kind: 'transaction';
  readonly title: string;
  readonly type: TransactionType;
  readonly date: string;
  readonly amountMinor: number;
  readonly categoryName: string;
  readonly selection: Readonly<ContextSelection>;
  readonly details: Readonly<{
    notes?: string;
    withPerson?: string | null;
    location?: string | null;
  }>;
  /** Private preparation reference only when photo is selected. Never printed or put in QR. */
  readonly attachment: Readonly<PhotoRef> | null;
};
/** Private UI selection source, not an output format. Captures one transaction only. */
export type TransactionExportSource = ExportBase & {
  readonly kind: 'transaction-export-source';
  readonly title: string;
  readonly type: TransactionType;
  readonly date: string;
  readonly amountMinor: number;
  readonly categoryName: string;
  readonly context: Readonly<TransactionContext>;
};
export type ExportImage =
  | {
      status: 'ready';
      dataUrl: string;
      mimeType: PhotoMime;
      width: number;
      height: number;
      byteSize: number;
    }
  | { status: 'unavailable'; reason: 'missing' | 'unreadable' };
export type QrSummary = {
  kind: 'mymoney.transaction-summary';
  version: 1;
  title: string;
  type: TransactionType;
  currency: Currency;
  amountMinor: number;
  fractionDigits: 0 | 2;
  date: string;
  category: string;
  details?: { notes?: string; withPerson?: string; location?: string };
};
export type QrPayloadResult =
  | {
      ok: true;
      payload: string;
      byteLength: number;
      maxBytes: 1024;
      summary: Readonly<QrSummary>;
    }
  | { ok: false; reason: 'too-large'; byteLength: number; maxBytes: 1024 };
export function createReportExportSnapshot(
  ledger: Ledger,
  startDate: string,
  endDate: string,
  nowMs: number,
): ReportExportSnapshot;
export function createTransactionExportSnapshot(
  ledger: Ledger,
  transactionId: string,
  selection?: Partial<ContextSelection>,
  nowMs?: number,
): TransactionExportSnapshot;
export function captureTransactionExportSource(
  ledger: Ledger,
  transactionId: string,
  nowMs: number,
): TransactionExportSource;
export function selectTransactionExportSnapshot(
  source: TransactionExportSource,
  selection?: Partial<ContextSelection>,
): TransactionExportSnapshot;
export function buildReportHtml(snapshot: ReportExportSnapshot): string;
export function buildTransactionHtml(
  snapshot: TransactionExportSnapshot,
  image?: ExportImage,
): string;
export function buildTransactionQr(
  snapshot: TransactionExportSnapshot,
  selection?: Partial<Pick<ContextSelection, 'notes' | 'withPerson' | 'location'>>,
): QrPayloadResult;
export function escapeHtml(value: string): string;
export function utf8ByteLength(value: string): number;

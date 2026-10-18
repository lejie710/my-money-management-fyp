import { Currency, Ledger, Transaction } from './model';
export type OcrWord = {
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  confidence?: number | null;
  detectedLanguages?: readonly { languageCode: string; confidence: number | null }[];
  polygon?: readonly { x: number; y: number }[];
};
export type OcrResult = {
  version: 1;
  provider: 'windows-media-ocr' | 'google-cloud-vision';
  language: string;
  detectedLanguages?: readonly { languageCode: string; confidence: number | null }[];
  pageConfidence?: number | null;
  geometry?: 'axis-aligned-envelope-with-original-polygon';
  width: number;
  height: number;
  elapsedMs: number;
  textAngle: number | null;
  words: readonly OcrWord[];
};
export type OcrRow = {
  index: number;
  text: string;
  bounds: OcrWord['bounds'];
  words: readonly OcrWord[];
};
export type ReceiptCandidate = {
  version: 1;
  provider: 'windows-media-ocr' | 'google-cloud-vision';
  reviewRequired: true;
  status: 'empty' | 'review';
  rows: readonly OcrRow[];
  title: { suggested: string | null; issues: readonly string[] };
  date: {
    suggested: string | null;
    candidates: readonly string[];
    issues: readonly string[];
  };
  currency: {
    suggested: Currency | null;
    candidates: readonly Currency[];
    explicit: readonly Currency[];
    unsupported: readonly string[];
    issues: readonly string[];
  };
  total: {
    suggestedMinor: number | null;
    candidates: readonly {
      rowIndex: number;
      text: string;
      amountMinor: number;
      currency: Currency;
    }[];
    issues: readonly string[];
  };
  warnings: readonly string[];
};
export type ReceiptReview = {
  title: string;
  date: string;
  amount: string;
  categoryId: string;
  currency: Currency;
  confirmed: boolean;
};
export const MAX_OCR_WORDS: number;
export const MAX_OCR_TEXT_LENGTH: number;
export function validateOcrResult(value: unknown): OcrResult;
export function groupOcrRows(value: OcrResult): readonly OcrRow[];
export function parseReceipt(
  value: OcrResult,
  options: { walletCurrency: Currency; today: string },
): ReceiptCandidate;
/** Returns a normal expense transaction only. No storage, attachment copying, or ledger writes. */
export function reviewedReceiptTransaction(
  ledger: Ledger,
  candidate: ReceiptCandidate,
  review: ReceiptReview,
  id: string,
): Transaction;

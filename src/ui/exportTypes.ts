import type { ReactNode } from 'react';
import type { ReportExportSnapshot, TransactionExportSnapshot } from '../core/exports';

export type ExportSnapshot = ReportExportSnapshot | TransactionExportSnapshot;
export type PdfArtifact = {
  id: string;
  ownerToken: string;
  kind: 'report' | 'transaction';
  fileName: string;
  uri: string;
  byteSize: number;
  pageCount: number;
  createdAtMs: number;
};
export type PdfUiServices = {
  prepare(snapshot: ExportSnapshot): Promise<{ artifact: PdfArtifact; warning?: string }>;
  share(artifact: PdfArtifact): Promise<{ status: 'requested' | 'unavailable' }>;
  /** Explicit native system print/preview action; never called automatically. */
  preview?(artifact: PdfArtifact): Promise<{ status: 'requested' | 'unavailable' }>;
};
export type QrRenderProps = {
  value: string;
  size: number;
  quietZone: number;
  ecl: 'M';
  color: '#000000';
  backgroundColor: '#FFFFFF';
  onError: (cause?: unknown) => void;
};
export type RenderTransactionQr = (props: QrRenderProps) => ReactNode;

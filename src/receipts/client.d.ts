import { OcrResult } from "../core/receipt";
export class ReceiptClientError extends Error {
  code: string;
  constructor(code: string);
}
export type ReceiptConnection = { url: string; token: string };
export type ReceiptClient = {
  recognize(
    bytes: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<OcrResult>;
};
export function createReceiptClient(
  config: ReceiptConnection,
  options?: { fetch?: typeof globalThis.fetch; timeoutMs?: number },
): ReceiptClient;

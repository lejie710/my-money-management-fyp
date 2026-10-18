import type { CloudConfiguration } from './config';
import type { CloudOwner } from './backupFormat';
export const MAX_RESPONSE_BYTES: number;
export function createStorageUploader(options: {
  configuration: CloudConfiguration;
  owner: CloudOwner;
  fetchImpl: typeof fetch;
  getToken(): Promise<string>;
  assertCurrent(): unknown;
  timeoutMs?: number;
  now?(): number;
}): (
  path: string,
  bytes: Uint8Array,
  metadata: { contentType: string; sha256: string },
  signal?: AbortSignal,
) => Promise<void>;

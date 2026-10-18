export type CompanionConnection = Readonly<{
  version: 1;
  runId: string;
  url: "http://127.0.0.1:8787/v1/recognize";
  token: string;
}>;
export const MAX_COMPANION_CONNECTION_BYTES: 4096;
export class CompanionConnectionError extends Error {
  readonly code: "INVALID_CONNECTION" | "CONNECTION_UNAVAILABLE";
  constructor(code?: "INVALID_CONNECTION" | "CONNECTION_UNAVAILABLE");
}
/** Pure bounded ASCII JSON parser. No IO, logs, request or financial mutation. */
export function parseCompanionConnection(
  bytes: Uint8Array,
): CompanionConnection;

import type { HostedConfiguration, HostedMetadata } from './contract';
import type { AssistantTransport } from '../ui/assistantUiTypes';
import type { ReceiptClient } from '../receipts/client';
import type { ForecastTransport } from '../forecast/client';
export type AuthenticatedServiceBinding = Readonly<{
  projectId: string;
  uid: string;
  ownerToken: string;
  viewToken: string;
  getIdToken(forceRefresh?: boolean): Promise<string>;
  isCurrent(): boolean;
}>;
export class HostedServiceError extends Error {
  code: string;
  constructor(code: string);
}
export function createHostedSession(options: {
  configuration: HostedConfiguration;
  auth: AuthenticatedServiceBinding;
  fetch?: typeof globalThis.fetch;
  createRequestId?: () => string;
  timeoutMs?: number;
}): Readonly<{
  connect(): Promise<HostedMetadata>;
  assistant: AssistantTransport;
  receipt: ReceiptClient;
  forecast: ForecastTransport;
  isCurrent(): boolean;
  close(): void;
}>;

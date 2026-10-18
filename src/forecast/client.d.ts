import type { CompanionConnection } from '../companion/connection';
import type { ForecastProvider } from '../companion/providerContract';
import type { ForecastInput, ProphetResponse } from './protocol';
export { ForecastError } from './protocol';
export type { ForecastInput, ProphetResponse, ForecastProvider };
export type ForecastTransport = (
  input: ForecastInput,
  options: { signal: AbortSignal },
) => Promise<ProphetResponse>;
export type ForecastTransportBinding = Readonly<{
  key: object;
  transport: ForecastTransport;
  provider: ForecastProvider;
  isCurrent: () => boolean;
}>;
export function createForecastClient(
  configuration: CompanionConnection,
  options?: { fetch?: typeof fetch; createRequestId?: () => string; timeoutMs?: number },
): Readonly<{ forecast: ForecastTransport }>;

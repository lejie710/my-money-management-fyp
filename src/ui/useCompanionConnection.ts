import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { readPrivateCompanionConnection } from '../companion/expoConnection';
import { createReceiptClient, type ReceiptClient } from '../receipts/client';
import { createAssistantClient } from '../assistant/client';
import type { AssistantTransport } from './assistantUiTypes';
import { createForecastClient, type ForecastTransportBinding } from '../forecast/client';
import { providersForConnection, type CompanionProviders } from '../companion/providerContract';

declare const __DEV__: boolean;
declare const process: { env: { EXPO_PUBLIC_LOCAL_COMPANION?: string } };
export const localCompanionEnabled = __DEV__ && process.env.EXPO_PUBLIC_LOCAL_COMPANION === '1';
export type CompanionClientBinding = Readonly<{
  key: object;
  receipt: ReceiptClient | null;
  assistant: AssistantTransport | null;
  forecast: ForecastTransportBinding['transport'] | null;
  providers: CompanionProviders;
}>;
let requestSequence = 0;
const requestId = () =>
  `ask-${Date.now().toString(36)}-${(++requestSequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export type CompanionConnectionView = Readonly<{
  phase: 'disabled' | 'not-configured' | 'checking' | 'configured' | 'unavailable';
  revision: number;
  message: string;
  binding: CompanionClientBinding | null;
}>;
type Context = {
  alive: boolean;
  pending: boolean;
  revision: number;
  read: typeof readPrivateCompanionConnection;
  enabled: boolean;
};

/** Local file read only. Client construction does not send a request or prove reachability. */
export function useCompanionConnection({
  enabled = localCompanionEnabled,
  read = readPrivateCompanionConnection,
}: { enabled?: boolean; read?: typeof readPrivateCompanionConnection } = {}) {
  const context = useRef<Context | null>(null);
  const current = useRef<CompanionConnectionView>({
    phase: enabled ? 'not-configured' : 'disabled',
    revision: 0,
    message: enabled
      ? 'No local companion connection has been read.'
      : 'Optional connections are not enabled in this build.',
    binding: null,
  });
  const [view, setView] = useState(current.current);
  const publish = (next: CompanionConnectionView) => {
    current.current = Object.freeze(next);
    setView(current.current);
  };
  const check = async (entry: Context) => {
    if (
      !entry.alive ||
      context.current !== entry ||
      entry.pending ||
      !enabled ||
      entry.read !== read ||
      entry.enabled !== enabled
    )
      return;
    entry.pending = true;
    const revision = ++entry.revision;
    publish({
      phase: 'checking',
      revision,
      message: 'Checking the private local companion configuration…',
      binding: null,
    });
    try {
      const configuration = await read();
      if (!entry.alive || context.current !== entry || revision !== entry.revision) return;
      if (!configuration) {
        publish({
          phase: 'not-configured',
          revision,
          message: 'Pair the Windows companion, then choose Recheck connection.',
          binding: null,
        });
        return;
      }
      const providers = providersForConnection(configuration);
      const receipt = providers.ocr ? createReceiptClient(configuration) : null;
      const assistant = providers.assistant
        ? createAssistantClient(configuration, {
            createRequestId: requestId,
          }).complete
        : null;
      const forecast = providers.forecast
        ? createForecastClient(configuration, {
            createRequestId: requestId,
          }).forecast
        : null;
      publish({
        phase: 'configured',
        revision,
        message:
          'Windows companion configured. Availability is checked when you request each selected service.',
        binding: Object.freeze({ key: Object.freeze({}), receipt, assistant, forecast, providers }),
      });
    } catch {
      if (entry.alive && context.current === entry && revision === entry.revision)
        publish({
          phase: 'unavailable',
          revision,
          message:
            'The private companion configuration could not be confirmed. Recheck after pairing.',
          binding: null,
        });
    } finally {
      entry.pending = false;
    }
  };
  useLayoutEffect(() => {
    const entry: Context = {
      alive: true,
      pending: false,
      revision: current.current.revision + 1,
      read,
      enabled,
    };
    context.current = entry;
    if (enabled) void check(entry);
    else
      publish({
        phase: 'disabled',
        revision: entry.revision,
        message: 'Optional connections are not enabled in this build. Manual entry is available.',
        binding: null,
      });
    return () => {
      entry.alive = false;
      entry.revision++;
      if (context.current === entry) {
        context.current = null;
        current.current = { ...current.current, binding: null, revision: entry.revision };
      }
    };
  }, [enabled, read]);
  const getCurrent = useCallback(() => current.current, []);
  const recheck = useCallback(() => {
    const entry = context.current;
    return entry ? check(entry) : Promise.resolve();
  }, [enabled, read]);
  return { ...view, enabled, getCurrent, recheck };
}

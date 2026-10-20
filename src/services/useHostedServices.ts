import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import type { CompanionConnectionView, CompanionClientBinding } from '../ui/useCompanionConnection';
import { createHostedSession, type AuthenticatedServiceBinding } from './client';
import type { HostedConfiguration } from './contract';
import { readHostedServiceConfiguration } from './configuration';
type Session = ReturnType<typeof createHostedSession>;
export function useHostedServices({
  auth,
  configuration,
  read = readHostedServiceConfiguration,
}: {
  auth: AuthenticatedServiceBinding | null;
  configuration?: HostedConfiguration | null;
  read?: () => HostedConfiguration | null;
}) {
  const latest = useRef(auth);
  latest.current = auth;
  const revision = useRef(0),
    active = useRef<Session | null>(null),
    alive = useRef(true);
  const current = useRef<CompanionConnectionView>({
    phase: 'not-configured',
    revision: 0,
    message: 'Hosted services have not been checked.',
    binding: null,
  });
  const [view, setView] = useState(current.current);
  const publish = (value: CompanionConnectionView) => {
    current.current = Object.freeze(value);
    setView(current.current);
  };
  const origin = configuration?.origin,
    projectId = configuration?.projectId,
    mode = configuration?.mode;
  const recheck = useCallback(async () => {
    const generation = ++revision.current;
    active.current?.close();
    active.current = null;
    const selected = latest.current;
    publish({
      phase: 'checking',
      revision: generation,
      message: 'Checking authenticated service configuration.',
      binding: null,
    });
    let session: Session | null = null;
    try {
      const config = configuration === undefined ? read() : configuration;
      if (!config) {
        publish({
          phase: 'not-configured',
          revision: generation,
          message: 'No hosted backend is configured.',
          binding: null,
        });
        return;
      }
      if (!selected || !selected.isCurrent()) {
        publish({
          phase: 'not-configured',
          revision: generation,
          message: 'Sign in to use the configured cloud services.',
          binding: null,
        });
        return;
      }
      const valid = () =>
        alive.current &&
        revision.current === generation &&
        latest.current?.ownerToken === selected.ownerToken &&
        latest.current?.viewToken === selected.viewToken &&
        selected.isCurrent();
      session = createHostedSession({
        configuration: config,
        auth: { ...selected, isCurrent: valid },
        fetch: expoFetch as typeof globalThis.fetch,
      });
      active.current = session;
      const metadata = await session.connect();
      if (!valid()) {
        session.close();
        return;
      }
      const binding: CompanionClientBinding = Object.freeze({
        key: Object.freeze({}),
        receipt: metadata.providers.ocr ? session.receipt : null,
        assistant: metadata.providers.assistant ? session.assistant : null,
        forecast: metadata.providers.forecast ? session.forecast : null,
        providers: metadata.providers,
      });
      publish({
        phase: 'configured',
        revision: generation,
        message:
          'Authenticated cloud services configured. Requests are sent only when you choose a feature.',
        binding,
      });
    } catch {
      session?.close();
      if (alive.current && revision.current === generation)
        publish({
          phase: 'unavailable',
          revision: generation,
          message:
            'Cloud services could not be verified. Local wallet tracking remains available; recheck deliberately.',
          binding: null,
        });
    }
  }, [
    auth?.ownerToken,
    auth?.viewToken,
    origin,
    projectId,
    mode,
    configuration === undefined,
    read,
  ]);
  useLayoutEffect(() => {
    alive.current = true;
    void recheck();
    return () => {
      alive.current = false;
      revision.current++;
      active.current?.close();
      active.current = null;
      current.current = { ...current.current, binding: null, revision: revision.current };
    };
  }, [recheck]);
  const getCurrent = useCallback(() => current.current, []);
  return { ...view, enabled: true, getCurrent, recheck };
}

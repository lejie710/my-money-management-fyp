import { useMemo } from 'react';
import { useCompanionConnection, localCompanionEnabled } from '../ui/useCompanionConnection';
import { useHostedServices } from './useHostedServices';
import { readHostedServiceConfiguration } from './configuration';
import type { AuthenticatedServiceBinding } from './client';
import type { HostedConfiguration } from './contract';
declare const process: {
  env: {
    EXPO_PUBLIC_SERVICES_MODE?: string;
    EXPO_PUBLIC_SERVICES_ORIGIN?: string;
    EXPO_PUBLIC_SERVICES_PROJECT_ID?: string;
  };
};
type Selection = { requested: boolean; configuration: HostedConfiguration | null; error: boolean };
export function readServiceSelection(): Selection {
  const mode = process.env.EXPO_PUBLIC_SERVICES_MODE;
  if (mode === 'off') return { requested: false, configuration: null, error: false };
  const requested =
    mode !== undefined ||
    !!process.env.EXPO_PUBLIC_SERVICES_ORIGIN ||
    !!process.env.EXPO_PUBLIC_SERVICES_PROJECT_ID;
  if (!requested) return { requested: false, configuration: null, error: false };
  try {
    const configuration = readHostedServiceConfiguration();
    if (!configuration) throw Error();
    return { requested: true, configuration, error: false };
  } catch {
    return { requested: true, configuration: null, error: true };
  }
}
const invalidConfiguration = (): never => {
  throw new Error('Hosted backend configuration is incomplete or invalid.');
};
export function useServiceConnection({ auth }: { auth: AuthenticatedServiceBinding | null }) {
  // Expo public configuration is fixed for this application build/reload.
  const selection = useMemo(readServiceSelection, []);
  const local = useCompanionConnection({ enabled: localCompanionEnabled && !selection.requested });
  const hosted = useHostedServices({
    auth,
    configuration: selection.error ? undefined : selection.configuration,
    read: selection.error ? invalidConfiguration : readHostedServiceConfiguration,
  });
  return selection.requested
    ? { ...hosted, source: 'hosted' as const }
    : { ...local, source: 'local' as const };
}

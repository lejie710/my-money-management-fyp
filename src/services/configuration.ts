import { validateServiceConfiguration, type HostedConfiguration } from './contract';
declare const __DEV__: boolean;
declare const process: {
  env: {
    EXPO_PUBLIC_SERVICES_ORIGIN?: string;
    EXPO_PUBLIC_SERVICES_PROJECT_ID?: string;
    EXPO_PUBLIC_SERVICES_MODE?: string;
  };
};
// These are public location/project identifiers. Provider credentials never belong here.
export function readHostedServiceConfiguration(): HostedConfiguration | null {
  const origin = process.env.EXPO_PUBLIC_SERVICES_ORIGIN;
  const projectId = process.env.EXPO_PUBLIC_SERVICES_PROJECT_ID;
  const mode = process.env.EXPO_PUBLIC_SERVICES_MODE || 'hosted';
  if (!origin && !projectId) return null;
  if (mode === 'emulator' && !__DEV__)
    throw new Error('Emulator services require a development build.');
  return validateServiceConfiguration({ version: 1, origin, projectId, mode });
}

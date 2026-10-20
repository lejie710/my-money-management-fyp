import type { CompanionProviders } from '../companion/providerContract';
export type HostedConfiguration = Readonly<{
  version: 1;
  mode: 'hosted' | 'emulator';
  origin: string;
  projectId: string;
}>;
export type HostedMetadata = Readonly<{
  version: 1;
  serviceId: string;
  projectId: string;
  uid: string;
  providers: CompanionProviders;
}>;
export const HOSTED_PROVIDER_HEADER: 'x-mymoney-hosted-provider';
export function validateServiceConfiguration(value: unknown): HostedConfiguration;
export function validateServiceMetadata(
  value: unknown,
  expected: { projectId: string; uid: string },
): HostedMetadata;
export function hostedProviderBinding(
  metadata: HostedMetadata,
  capability: 'assistant' | 'ocr' | 'forecast',
): string;
export function validProjectId(value: unknown): boolean;
export function validOwnerUid(value: unknown): boolean;

export type CloudConfiguration = Readonly<{
  mode: 'hosted' | 'emulator';
  firebase: Readonly<{
    apiKey: string;
    projectId: string;
    appId: string;
    authDomain: string;
    storageBucket: string;
  }>;
  emulators: Readonly<{ auth: number; firestore: number; storage: number }> | null;
}>;
export function validateCloudConfiguration(value: unknown): CloudConfiguration;

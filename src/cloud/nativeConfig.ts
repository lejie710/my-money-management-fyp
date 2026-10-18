import { validateCloudConfiguration, type CloudConfiguration } from './config';
declare const process: { env: Record<string, string | undefined> };
export function configuredFirebase(): { configuration: CloudConfiguration | null; error: string } {
  const mode = process.env.EXPO_PUBLIC_FIREBASE_MODE;
  if (!mode || mode === 'off') return { configuration: null, error: '' };
  try {
    return {
      configuration: validateCloudConfiguration({
        mode,
        firebase: {
          apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
          projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
          appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
          authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
          storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
        },
        ...(mode === 'emulator'
          ? {
              emulators: {
                auth: Number(process.env.EXPO_PUBLIC_FIREBASE_AUTH_PORT),
                firestore: Number(process.env.EXPO_PUBLIC_FIREBASE_FIRESTORE_PORT),
                storage: Number(process.env.EXPO_PUBLIC_FIREBASE_STORAGE_PORT),
              },
            }
          : {}),
      }),
      error: '',
    };
  } catch {
    return {
      configuration: null,
      error:
        'Firebase backup setup is incomplete. Check the optional Firebase setup guide; local tracking remains available.',
    };
  }
}

import type { AccountAuthAdapter } from './coordinator';
import type { DataScope } from './identity';
import type { createGuardedAuthPersistence } from './guardedPersistence';
import type { LocalResetController } from '../ui/accountUiTypes';
export type ScopedAuthStorage = Parameters<typeof createGuardedAuthPersistence>[0];
export type FirebaseSdkBridge = Pick<
  typeof import('firebase/app'),
  'getApps' | 'initializeApp' | 'deleteApp'
> &
  Pick<
    typeof import('firebase/auth'),
    | 'initializeAuth'
    | 'getReactNativePersistence'
    | 'connectAuthEmulator'
    | 'beforeAuthStateChanged'
    | 'onAuthStateChanged'
    | 'signInWithEmailAndPassword'
    | 'createUserWithEmailAndPassword'
    | 'signOut'
    | 'updateProfile'
    | 'sendPasswordResetEmail'
    | 'verifyPasswordResetCode'
    | 'confirmPasswordReset'
  >;
export const CONFIG: Readonly<{ apiKey: 'demo-fyp-local'; projectId: 'demo-fyp-local' }>;
export const EMULATOR_URL: 'http://127.0.0.1:9099';
export type LocalFirebaseAuthAdapter = AccountAuthAdapter & {
  createResetSession(): LocalResetController;
};
export function createFirebaseAuthAdapter(options: {
  runtime: object;
  scope: DataScope;
  storage: ScopedAuthStorage;
  sdk: FirebaseSdkBridge;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): LocalFirebaseAuthAdapter;

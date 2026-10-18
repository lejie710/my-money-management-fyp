import { initializeApp, getApps, deleteApp } from 'firebase/app';
import {
  initializeAuth,
  getReactNativePersistence,
  connectAuthEmulator,
  beforeAuthStateChanged,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
} from 'firebase/auth';
import { createFirebaseAuthAdapter, type ScopedAuthStorage } from './firebaseAdapter';
import type { DataScope } from './identity';

/** No cloud config input: this binding is deliberately local-emulator only. */
export function createLocalFirebaseAuthAdapter(options: {
  runtime: object;
  scope: DataScope;
  storage: ScopedAuthStorage;
}) {
  return createFirebaseAuthAdapter({
    ...options,
    sdk: {
      initializeApp,
      getApps,
      deleteApp,
      initializeAuth,
      getReactNativePersistence,
      connectAuthEmulator,
      beforeAuthStateChanged,
      onAuthStateChanged,
      signInWithEmailAndPassword,
      createUserWithEmailAndPassword,
      signOut,
      updateProfile,
      sendPasswordResetEmail,
      verifyPasswordResetCode,
      confirmPasswordReset,
    },
  });
}

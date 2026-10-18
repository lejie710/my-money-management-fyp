import type {
  Auth,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
} from 'firebase/auth';
import type { LocalResetController } from '../ui/accountUiTypes';
export type ResetSdkBridge = {
  sendPasswordResetEmail: typeof sendPasswordResetEmail;
  verifyPasswordResetCode: typeof verifyPasswordResetCode;
  confirmPasswordReset: typeof confirmPasswordReset;
};
export function createLocalResetController(options: {
  sdk: ResetSdkBridge;
  auth: () => Auth;
  isCurrent: () => boolean;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  fetchImpl?: typeof fetch;
}): LocalResetController;
export const INBOX_URL: 'http://127.0.0.1:9099/emulator/v1/projects/demo-fyp-local/oobCodes';
export const MAX_INBOX_BYTES: number;

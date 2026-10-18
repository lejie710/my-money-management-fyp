/** Presentation contract only. The coordinator owns identity, persistence and financial barriers. */
export type AccountUserView = { uid: string; email: string | null; displayName: string | null };
export type AccountResult = { ok: boolean; pending: boolean; message: string };
export type ProfileGender = '' | 'female' | 'male' | 'nonbinary' | 'prefer-not-to-say';
export type LocalProfileExtras = { gender: ProfileGender; birthDate: string | null };
export type AccountUiState = {
  /** Changes for a replaced scope/actor/binding, never for an ordinary status-message update. */
  viewToken: string;
  provider: 'configured' | 'unconfigured';
  cloudAccount?: boolean;
  phase:
    | 'restoring'
    | 'opening-wallet'
    | 'ready'
    | 'switching'
    | 'session-unavailable'
    | 'wallet-unavailable';
  user: AccountUserView | null;
  persistence: 'confirmed' | 'unconfirmed';
  /** Complete confirmed scope+actor+wallet incarnation; never inferred from an email. */
  activeOwnerToken: string | null;
  sessionRestored: boolean;
  service: 'available' | 'unavailable' | 'unchecked';
  busy: boolean;
  operation:
    'sign-in' | 'register' | 'sign-out' | 'profile' | 'reconcile' | 'retire-session' | null;
  message: string;
  error: string;
  blockedReason: string;
  canSignIn: boolean;
  canRegister: boolean;
  canSignOut: boolean;
  canEditProfile: boolean;
  canSaveLocalProfile: boolean;
  canRequestReset: boolean;
  canRequestEmailReset?: boolean;
  canRetry: boolean;
  canRetireSavedSession?: boolean;
  sessionRetirementToken?: string | null;
  sessionRetired?: boolean;
  /** Captured calendar date for profile validation; refreshed by the root coordinator. */
  today: string;
  profile: {
    phase: 'loading' | 'ready' | 'unavailable';
    extras: LocalProfileExtras | null;
    displayNamePending: boolean;
    error: string;
  };
};

export type LocalResetState = {
  phase:
    | 'idle'
    | 'requesting'
    | 'awaiting-message'
    | 'verifying'
    | 'verified'
    | 'confirming'
    | 'complete'
    | 'unavailable';
  /** Only the address this reset session explicitly requested; never an account listing. */
  email: string;
  messageAvailable: boolean;
  message: string;
  error: string;
  busy: boolean;
  canRequest: boolean;
  canRefresh: boolean;
  canVerify: boolean;
  canConfirm: boolean;
};
export interface LocalResetController {
  getSnapshot(): LocalResetState;
  subscribe(listener: () => void): () => void;
  request(email: string): Promise<AccountResult>;
  refresh(): Promise<AccountResult>;
  verify(): Promise<AccountResult>;
  confirm(newPassword: string): Promise<AccountResult>;
  /** Invalidates this view's callbacks/code. Never signs out or deletes a wallet. */
  close(): void;
}
export interface AccountUiController {
  getSnapshot(): AccountUiState;
  subscribe(listener: () => void): () => void;
  signIn(input: { email: string; password: string }): Promise<AccountResult>;
  register(input: { email: string; password: string; displayName: string }): Promise<AccountResult>;
  signOut(): Promise<AccountResult>;
  /** Explicit recovery only; removes a confirmed unavailable sign-in, never financial records. */
  retireSavedSession?(token: string): Promise<AccountResult>;
  updateDisplayName(name: string): Promise<AccountResult>;
  saveLocalProfile(extras: LocalProfileExtras): Promise<AccountResult>;
  /** Reopens saved profile/session state; never silently repeats a failed profile mutation. */
  retryProfile(): Promise<AccountResult>;
  retry(): Promise<AccountResult>;
  /** Pure session allocation; request() performs the first intentional reset effect. */
  requestPasswordReset?(email: string): Promise<AccountResult>;
  createResetSession(): LocalResetController;
}

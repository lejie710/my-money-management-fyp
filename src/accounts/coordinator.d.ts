import { Ledger, LedgerIdentityContext } from '../core/model';
import { ReminderOwner } from '../reminders/coordinator';
import { DataScope, DataFamily, AccountUser } from './identity';
import { FamilyLedgerStorage } from './familyStorage';
import { LocalProfileExtras, createProfileStore } from './profileStore';
export type ConfirmedIdentity = {
  user: AccountUser | null;
  persistence: 'confirmed' | 'unconfirmed';
  service: 'available' | 'unavailable' | 'unchecked';
  mutationPending: boolean;
  recovery?: 'retry' | 'restart';
  sessionRetirementToken?: string | null;
  sessionRetired?: boolean;
};
/** A stable root-owned SDK binding; never returns tokens, passwords, raw User or session bytes. */
export interface AccountAuthAdapter {
  /** Install this persistent guard through beforeAuthStateChanged before restoring/publishing SDK identities. */
  initialize(beforeIdentityChange: () => Promise<void>): Promise<ConfirmedIdentity>;
  confirmIdentity(): Promise<ConfirmedIdentity>;
  /** Signals changes only; the coordinator explicitly requests initial confirmation. */
  subscribe(listener: () => void): () => void;
  signIn(input: { email: string; password: string }): Promise<void>;
  register(input: { email: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  retireSavedSession?(token: string): Promise<{ retired: boolean }>;
  updateDisplayName(expectedUid: string, name: string): Promise<void>;
}
export type AccessResult = { ok: boolean; pending: boolean; message: string };
export type ActivatedWallet = {
  family: DataFamily;
  owner: ReminderOwner;
  ownerToken: string;
  ledger: Ledger;
  storage: FamilyLedgerStorage;
};
export type FinancialLease = object;
export type FinancialActivationResult = AccessResult & {
  /** Actual result after optional restore-time achievement reconciliation through commitLedger. */
  durableLedger?: Ledger;
  /** The financial write/readback outcome is unknown. Retries must read only the active family key. */
  walletWriteUnconfirmed?: boolean;
};
export interface FinancialAccountAccess {
  /** Synchronous recheck: same held lease, no in-flight/uncertain financial write. Holding a lease alone is insufficient. */
  isIdentityLeaseReady(lease: FinancialLease): boolean;
  /** MUST synchronously freeze the ref-backed write/restore/editor gate before its first await. */
  prepareIdentityChange(context: {
    reason: 'restore' | 'mutation' | 'reconcile';
    activeOwnerToken: string | null;
  }): Promise<{ ok: true; lease: FinancialLease } | { ok: false; message: string }>;
  /** Hydrate target hooks and initialize owner baselines while the lease remains held. Check isCurrent before publishing effects. */
  activate(
    lease: FinancialLease,
    target: ActivatedWallet,
    isCurrent: () => boolean,
  ): Promise<FinancialActivationResult>;
  /** Resume only the exact prior owner after coordinator readCurrent validation. */
  resume(
    lease: FinancialLease,
    target: ActivatedWallet,
    isCurrent: () => boolean,
  ): Promise<FinancialActivationResult>;
  /** Synchronous; only called after durable identity, ledger and owner activation are confirmed. */
  release(lease: FinancialLease): void;
}
export type AccessView = {
  readonly phase:
    'restoring' | 'ready' | 'switching' | 'session-unavailable' | 'wallet-unavailable';
  readonly provider: 'local-emulator' | 'firebase-cloud' | 'unconfigured';
  readonly family: DataFamily | null;
  readonly user: AccountUser | null;
  readonly activeOwnerToken: string | null;
  readonly operation:
    'sign-in' | 'register' | 'sign-out' | 'profile' | 'profile-extras' | 'retire-session' | null;
  readonly persistence: 'confirmed' | 'unconfirmed';
  readonly sessionRestored: boolean;
  readonly recovery: 'retry' | 'restart';
  readonly sessionRetirementToken?: string | null;
  readonly sessionRetired?: boolean;
  readonly service: 'available' | 'unavailable' | 'unchecked';
  readonly message: string;
  readonly profileNamePending: boolean;
  readonly profileExtras: LocalProfileExtras | null;
  readonly profileExtrasStatus: 'none' | 'ready' | 'unavailable' | 'uncertain';
  readonly capabilities: {
    signIn: boolean;
    register: boolean;
    signOut: boolean;
    editProfile: boolean;
    saveProfileExtras: boolean;
    retry: boolean;
    retireSession?: boolean;
  };
};
export type AccountCoordinator = {
  getSnapshot(): AccessView;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<AccessResult>;
  signIn(input: { email: string; password: string }): Promise<AccessResult>;
  register(input: { email: string; password: string; displayName: string }): Promise<AccessResult>;
  signOut(): Promise<AccessResult>;
  retireSavedSession(token: string): Promise<AccessResult>;
  updateDisplayName(name: string): Promise<AccessResult>;
  saveProfileExtras(extras: LocalProfileExtras): Promise<AccessResult>;
  /** Root calls only after a same-family financial commit and required owner activation are confirmed. No writes or scheduling. */
  observeCommittedWallet(family: DataFamily, ledger: Ledger): boolean;
  /** Reconciles identity and stored data; never repeats sign-in, registration, sign-out, or profile mutations. */
  retry(): Promise<AccessResult>;
  /** Removes this handle's observers; does not cancel an SDK request, sign out, or release an unresolved lease. */
  dispose(): void;
};
export function createAccountCoordinator(options: {
  /** Reuse this exact object and its dependencies across Strict Mode/remounts. */
  runtime: object;
  scope: DataScope;
  firebaseProjectId?: string;
  auth: AccountAuthAdapter | null;
  financial: FinancialAccountAccess;
  storageForFamily(family: DataFamily): FamilyLedgerStorage;
  profileForFamily(family: DataFamily): ReturnType<typeof createProfileStore>;
  createGuestLedger?: () => Ledger;
  identityContext?: LedgerIdentityContext;
}): AccountCoordinator;

import type { Ledger } from '../core/model';
import type { createLedgerStorage } from '../core/storage';
import type { AchievementClock } from '../core/achievements';
import type { LedgerTransitionGuard } from '../core/commitLedger';
import type { DataFamily } from '../accounts/identity';
export type LedgerStorage = ReturnType<typeof createLedgerStorage> & {
  kind?: 'firebase-live';
  isReadOnly?(): boolean;
  saveWithExpected?(current: Ledger, next: Ledger): Promise<Ledger>;
  readDraft?(): Promise<{
    operationId: string;
    phase: 'draft' | 'submitted' | 'conflict';
    ledger: Ledger;
  } | null>;
  retryDraft?(token: string): Promise<Ledger>;
};
export type CommitObserver = (
  previous: Ledger,
  committed: Ledger,
  clock: AchievementClock,
) => void | Promise<void>;
export type LedgerView = {
  ledger: Ledger | null;
  loading: boolean;
  loadError: boolean;
  saving: boolean;
  saveError: string;
  status: string;
  family: DataFamily;
  storage: LedgerStorage;
  ownerToken: string | null;
  bindingToken: object;
  identityPending: boolean;
  uncertain: boolean;
};
export type IdentityTarget = {
  family: DataFamily;
  storage: LedgerStorage;
  ledger: Ledger;
  ownerToken: string;
};
export type IdentityAdoptionResult = {
  ok: boolean;
  pending: boolean;
  message: string;
  durableLedger?: Ledger;
  walletWriteUnconfirmed?: boolean;
};
export function createLedgerRuntime(options: {
  runtime: object;
  family: DataFamily;
  storage: LedgerStorage;
  createInitialLedger: () => Ledger;
  getClock: () => AchievementClock;
  validateConfiguration?: () => void;
  trace?: (stage: string) => void;
}): {
  getSnapshot(): LedgerView;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<boolean>;
  restore(bindingToken: object, expectedOwnerToken: string | null): Promise<boolean>;
  save(
    bindingToken: object,
    expectedOwnerToken: string | null,
    next: Ledger,
    message: string,
  ): Promise<boolean>;
  compareAndSave(
    expectedOwnerToken: string,
    expectedLedgerJson: string,
    next: Ledger,
    message: string,
  ): Promise<boolean>;
  getClock(): AchievementClock;
  retryCloudDraft(token: string): Promise<boolean>;
  clearSaveError(bindingToken: object): void;
  registerTransitionGuard(bindingToken: object, guard: LedgerTransitionGuard): () => void;
  registerCommitObserver(bindingToken: object, observer: CommitObserver): () => void;
  acquireIdentityLease(): { ok: true; lease: object } | { ok: false; message: string };
  isIdentityLeaseReady(lease: object): boolean;
  adoptIdentityTarget(
    lease: object,
    target: IdentityTarget,
    isCurrent: () => boolean,
  ): Promise<IdentityAdoptionResult>;
  releaseIdentityLease(lease: object, expectedOwnerToken: string | null): boolean;
  getIdentityState(): {
    family: DataFamily;
    storage: LedgerStorage;
    ledger: Ledger | null;
    ownerToken: string | null;
    identityPending: boolean;
    writeInFlight: boolean;
    uncertain: boolean;
    bindingToken: object;
  };
};

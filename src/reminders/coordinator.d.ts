// Public owner-bound reminder coordinator contract.
// Coordinator/store files: src/reminders/store.js and coordinator.js.
// Expo adapter: src/reminders/expoAdapter.ts. Hook: src/ui/useReminders.ts.

export type ReminderScope =
  { readonly kind: 'canonical' } | { readonly kind: 'test'; readonly namespace: string };

export type ReminderActor =
  | { readonly kind: 'local' }
  | { readonly kind: 'firebase'; readonly uid: string }
  | { readonly kind: 'firebase-hosted'; readonly projectId: string; readonly uid: string };

export type ReminderOwner = {
  readonly scope: ReminderScope;
  readonly actor: ReminderActor;
  readonly incarnationId: string;
};

export type ReminderDraft = {
  readonly title: string;
  readonly body: string;
  /** Absolute Unix milliseconds. A manual reminder must still be in the future. */
  readonly scheduledAtMs: number;
};

export const MAX_REMINDER_TITLE_LENGTH: 80;
export const MAX_REMINDER_BODY_LENGTH: 240;
export const MAX_MANUAL_REMINDERS: 100;
export const MAX_REMINDER_DELAY_SECONDS: 31536000;
/** Strict whole seconds, 1 through 31,536,000; no partial/exponent/decimal syntax. */
export function parseReminderDelay(text: string): number;

export type AutomaticPreferences = {
  readonly budgets: boolean;
  readonly goal: boolean;
  readonly achievements: boolean;
};

export type AutomaticNotice = {
  readonly key: string;
  readonly kind: 'budget' | 'goal' | 'achievement';
  readonly title: string;
  readonly body: string;
  readonly occurredAtMs: number;
};

export type ReminderPermission = {
  readonly status: 'unknown' | 'granted' | 'denied' | 'unavailable';
  readonly canAskAgain: boolean;
  /** null means not yet checked or not applicable on this platform. */
  readonly channelEnabled: boolean | null;
};

export type ReminderOperationResult = {
  readonly ok: boolean;
  /** An uncertain/pending outcome is never ok:true. */
  readonly pending: boolean;
  readonly message: string;
  readonly reminderId?: string;
};

export type ReminderRow = {
  readonly id: string;
  readonly revision: number;
  /** For an edit, these remain the previous committed values until success. */
  readonly title: string;
  readonly body: string;
  readonly scheduledAtMs: number;
  readonly status:
    'scheduled' | 'paused' | 'elapsed' | 'creating' | 'editing' | 'deleting' | 'error';
  readonly pendingAction: 'create' | 'edit' | 'delete' | null;
  readonly pendingDraft: ReminderDraft | null;
  readonly message: string | null;
  readonly canRetry: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
};

export type AutomaticNoticeError = {
  readonly key: string;
  readonly kind: AutomaticNotice['kind'];
  readonly message: string;
};

export type ReminderViewState = {
  readonly ownerToken: string;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly lastError: string | null;
  readonly ownerPaused: boolean;
  readonly cleanupPending: boolean;
  readonly permission: ReminderPermission;
  readonly reminders: readonly ReminderRow[];
  readonly busyReminderIds: readonly string[];
  readonly automatic: AutomaticPreferences;
  readonly automaticNoticeErrors: readonly AutomaticNoticeError[];
};

export type ReminderNotificationData = {
  readonly origin: 'mmm-reminders-v1';
  readonly ownerToken: string;
  readonly reminderId: string;
  readonly revision: number;
  readonly operationId: string;
  readonly kind: 'manual' | AutomaticNotice['kind'];
  readonly eventKey?: string;
};

export type ReminderNotificationRequest = {
  readonly identifier: string;
  readonly title: string;
  readonly body: string;
  /** null is permitted only for immediate automatic notices. */
  readonly scheduledAtMs: number | null;
  readonly data: ReminderNotificationData;
};

/** Adapter normalizes Expo requests; foreign metadata remains untrusted. */
export type ScheduledNotification = {
  readonly identifier: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly scheduledAtMs: number | null;
  readonly data: unknown;
};

export type NotificationAdapter = {
  /** Create/update only this app's intended channel; do not request a token. */
  ensureChannel(): Promise<void>;
  getPermission(): Promise<ReminderPermission>;
  requestPermission(): Promise<ReminderPermission>;
  listScheduled(): Promise<readonly ScheduledNotification[]>;
  schedule(request: ReminderNotificationRequest): Promise<string>;
  cancel(identifier: string): Promise<void>;
};

export type ReminderKeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
};

// Opaque, validated owner-bound store. UI must not call internal load/save methods.
declare const reminderStoreBrand: unique symbol;
export interface ReminderStore {
  readonly [reminderStoreBrand]: true;
  readonly key: string;
  readonly ownerToken: string;
}

// store.js exports
/** Strict validation; fixed-order tuple encoding, not ambiguous concatenation. */
export function encodeReminderOwner(owner: ReminderOwner): string;
/** Reject malformed JSON, wrong tuple shape/tags/types, blank IDs, and excess lengths. */
export function decodeReminderOwner(token: unknown): ReminderOwner;
export function sameReminderScope(left: ReminderScope, right: ReminderScope): boolean;
export function reminderStorageKey(owner: ReminderOwner): string;
export function createReminderStore(
  adapter: ReminderKeyValueStorage,
  owner: ReminderOwner,
): ReminderStore;

export type ReminderCoordinatorOptions = {
  readonly owner: ReminderOwner;
  readonly store: ReminderStore;
  readonly notifications: NotificationAdapter;
  readonly now: () => number;
  readonly newId: (kind: 'reminder' | 'operation') => string;
  /** Immutable for this wallet incarnation. Suppresses automatic notices, not manual reminders. */
  readonly sampleMode: boolean;
};

export interface ReminderCoordinator {
  readonly ownerToken: string;
  /** Stable reference until a state publication; no side effects or cloning per read. */
  getSnapshot(): ReminderViewState;
  /** Listener takes no arguments, as required by useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
  /** Records current historical event keys without emitting notices; never prompts. */
  initialize(baselineKeys: readonly string[]): Promise<ReminderOperationResult>;
  create(draft: ReminderDraft): Promise<ReminderOperationResult>;
  edit(reminderId: string, draft: ReminderDraft): Promise<ReminderOperationResult>;
  remove(reminderId: string): Promise<ReminderOperationResult>;
  retry(reminderId: string): Promise<ReminderOperationResult>;
  reconcile(): Promise<ReminderOperationResult>;
  /** Explicit UI action only; other methods may check permission but must not prompt. */
  requestPermission(): Promise<ReminderOperationResult>;
  /** Baseline keys prevent enabling a preference from announcing historical milestones. */
  setAutomaticPreferences(
    preferences: AutomaticPreferences,
    baselineKeys: readonly string[],
  ): Promise<ReminderOperationResult>;
  /** Call only after the financial save succeeded; stale owner token is rejected. */
  observeFinancialEvents(
    ownerToken: string,
    events: readonly AutomaticNotice[],
  ): Promise<ReminderOperationResult>;
  /** Reject new mutations, drain current work, persist pause intent, cancel owned requests. */
  quiesceAndCancelOwner(): Promise<ReminderOperationResult>;
  /** Explicit compensation/reactivation of the same owner; never replay elapsed reminders. */
  resumeOwner(): Promise<ReminderOperationResult>;
  /** Stops new calls and UI publication. Does not cancel reminders merely on navigation. */
  dispose(): void;
}

// coordinator.js exports
/** Construction is pure: no reads, writes, prompts, timers, or native calls. */
export function createReminderCoordinator(options: ReminderCoordinatorOptions): ReminderCoordinator;

export type RetirementFailure = {
  readonly ownerToken: string;
  readonly identifier: string;
  readonly message: string;
};
export type RetirementResult = {
  readonly ok: boolean;
  readonly canceledCount: number;
  readonly retiredOwnerTokens: readonly string[];
  readonly failures: readonly RetirementFailure[];
};

/**
 * Root-only startup sweep after the active ledger owner is durably hydrated.
 * Strictly decodes metadata and matches the supplied application scope.
 * Cancels inactive owner requests only; never schedules or modifies any store.
 * Current owner, foreign scope/origin, and invalid metadata are untouched.
 * Safe to repeat: disappearance after cancellation is not delivery evidence.
 */
export function retireInactiveNotifications(options: {
  readonly scope: ReminderScope;
  readonly activeOwner: ReminderOwner;
  readonly notifications: NotificationAdapter;
  /** Root generation guard; stop if this startup owner is no longer active. */
  readonly stillActive?: () => boolean;
}): Promise<RetirementResult>;

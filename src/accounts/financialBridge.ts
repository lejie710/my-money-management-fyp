import type {
  FinancialAccountAccess,
  FinancialLease,
  ActivatedWallet,
  FinancialActivationResult,
} from './coordinator';
import type { useLedger } from '../ui/useLedger';
import type { useWalletPhotos } from '../ui/useWalletPhotos';
import type { useWalletReminders } from '../ui/useWalletReminders';

export type FinancialRootBinding = {
  ledger: ReturnType<typeof useLedger>;
  photos: ReturnType<typeof useWalletPhotos>;
  reminders: ReturnType<typeof useWalletReminders>;
  hasOpenEditor(): boolean;
  closeEditor(): void;
  closeExports(): void;
};
const failed = (
  message = 'Owner preparation is still pending. Check saved account access before continuing.',
): FinancialActivationResult => ({ ok: false, pending: true, message });
const good = (): FinancialActivationResult => ({ ok: true, pending: false, message: '' });
type Held = {
  lease: FinancialLease;
  prepared: boolean;
  retiredOwner: string | null;
  activating: boolean;
  readyOwner: string | null;
};

/** Root binding changes are explicit; this bridge owns no financial or SDK storage. */
export function createFinancialAccountBridge({ timeoutMs = 15000 }: { timeoutMs?: number } = {}) {
  let binding: FinancialRootBinding | null = null,
    revision = 0,
    held: Held | null = null;
  const listeners = new Set<() => void>();
  const pulse = () => {
    for (const listener of [...listeners]) listener();
  };
  const current = (isCurrent: () => boolean) => {
    try {
      return isCurrent();
    } catch {
      return false;
    }
  };
  const waitFor = (
    predicate: (value: FinancialRootBinding) => boolean,
    isCurrent: () => boolean,
  ): Promise<FinancialRootBinding | null> =>
    new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: FinancialRootBinding | null) => {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(value);
      };
      const check = () => {
        if (!current(isCurrent)) return finish(null);
        if (binding && predicate(binding)) finish(binding);
      };
      timer = setTimeout(() => finish(null), timeoutMs);
      listeners.add(check);
      check();
    });
  const bounded = async <T>(work: Promise<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  async function retire(cell: Held, isCurrent: () => boolean) {
    const actual = binding?.ledger.getIdentityState();
    if (!binding || !actual || !current(isCurrent)) return failed();
    if (cell.prepared && cell.retiredOwner === actual.ownerToken) return good();
    cell.prepared = false;
    cell.readyOwner = null;
    let ownerBinding = binding;
    if (
      ownerBinding.reminders.state?.loadError &&
      ownerBinding.reminders.coordinator &&
      actual.ownerToken
    ) {
      const checked = await bounded(
        ownerBinding.reminders.coordinator.initialize(ownerBinding.reminders.getBaselineKeys()),
      );
      if (!checked?.ok || checked.pending || !current(isCurrent)) return failed();
      const refreshed = await waitFor(
        (value) =>
          value.ledger.ownerToken === actual.ownerToken &&
          !!value.reminders.state &&
          !value.reminders.state.loading &&
          !value.reminders.state.loadError,
        isCurrent,
      );
      if (!refreshed) return failed();
      ownerBinding = refreshed;
    }
    if (ownerBinding.reminders.startupError && actual.ownerToken) {
      const previousRevision = revision;
      ownerBinding.reminders.retryStartup();
      const refreshed = await waitFor(
        (value) =>
          revision > previousRevision &&
          value.ledger.ownerToken === actual.ownerToken &&
          !value.reminders.identityOpening,
        isCurrent,
      );
      if (!refreshed) return failed();
      ownerBinding = refreshed;
    }
    // The lease already freezes writes. Both invalidations start before awaiting either effect.
    ownerBinding.closeExports();
    ownerBinding.closeEditor();
    const photoDrain = ownerBinding.photos.suspendForIdentity(actual.ownerToken);
    const reminders = actual.ownerToken
      ? ownerBinding.reminders.quiesceForIdentity(actual.ownerToken)
      : Promise.resolve({ ok: true, pending: false, message: '' });
    try {
      const results = await bounded(Promise.all([photoDrain, reminders]));
      if (!results || !current(isCurrent) || held !== cell) return failed();
      if (results[0].pending || !results[1].ok || results[1].pending) return failed();
      cell.prepared = true;
      cell.retiredOwner = actual.ownerToken;
      return good();
    } catch {
      return failed();
    }
  }
  async function readyOwner(
    target: ActivatedWallet,
    isCurrent: () => boolean,
  ): Promise<FinancialActivationResult> {
    const first = await waitFor(
      (value) =>
        value.ledger.ownerToken === target.ownerToken &&
        value.photos.ownerToken === target.ownerToken,
      isCurrent,
    );
    if (!first || !first.photos.resumeAfterIdentity(target.family)) return failed();
    const opened = await waitFor(
      (value) =>
        value.ledger.ownerToken === target.ownerToken &&
        value.photos.ownerToken === target.ownerToken &&
        !!value.photos.photos &&
        value.reminders.coordinator?.ownerToken === target.ownerToken &&
        !!value.reminders.state &&
        !value.reminders.state.loading &&
        (!!value.reminders.state.loadError || !value.reminders.identityOpening),
      isCurrent,
    );
    if (!opened || opened.reminders.state?.loadError) return failed();
    try {
      if (opened.reminders.state?.ownerPaused) {
        const resumed = await bounded(opened.reminders.resumeForIdentity(target.ownerToken));
        if (!resumed?.ok || resumed.pending || !current(isCurrent)) return failed();
      }
      const results = await bounded(
        Promise.all([
          opened.photos.readyForIdentity(target.ownerToken, isCurrent),
          opened.reminders.readyForIdentity(target.ownerToken, isCurrent),
        ]),
      );
      if (
        !results ||
        results[0].pending ||
        !results[1].ok ||
        results[1].pending ||
        !current(isCurrent)
      )
        return failed();
      return good();
    } catch {
      return failed();
    }
  }
  const activate: FinancialAccountAccess['activate'] = async (lease, target, isCurrent) => {
    const cell = held;
    if (!cell || cell.lease !== lease || cell.activating || !binding || !current(isCurrent))
      return failed();
    cell.activating = true;
    try {
      const retired = await retire(cell, isCurrent);
      if (!retired.ok) return retired;
      if (!binding || !current(isCurrent)) return failed();
      const adopted = await binding.ledger.adoptIdentityTarget(lease, target, isCurrent);
      if (!adopted.ok || adopted.pending) return adopted;
      // Once target resources are active, this lease cannot authorize another SDK publication.
      cell.prepared = false;
      const ready = await readyOwner(
        { ...target, ledger: adopted.durableLedger ?? target.ledger },
        isCurrent,
      );
      if (!ready.ok) return { ...ready, durableLedger: adopted.durableLedger };
      cell.readyOwner = target.ownerToken;
      return { ...ready, durableLedger: adopted.durableLedger };
    } finally {
      cell.activating = false;
    }
  };
  const financial: FinancialAccountAccess = {
    async prepareIdentityChange(context) {
      const root = binding;
      if (!root || held || root.hasOpenEditor())
        return {
          ok: false,
          message: 'Finish or close the open transaction editor before changing accounts.',
        };
      const actual = root.ledger.getIdentityState();
      if (actual.ownerToken !== context.activeOwnerToken)
        return { ok: false, message: 'Wait for this saved wallet owner to finish opening.' };
      const acquired = root.ledger.acquireIdentityLease();
      if (!acquired.ok) return acquired;
      const cell: Held = {
        lease: acquired.lease,
        prepared: false,
        retiredOwner: null,
        activating: false,
        readyOwner: null,
      };
      held = cell;
      try {
        await retire(cell, () => held === cell);
      } catch {
        cell.prepared = false;
      }
      // Even partial cleanup returns its held lease; SDK readiness stays false until repaired.
      return { ok: true, lease: cell.lease };
    },
    isIdentityLeaseReady(lease) {
      return (
        !!held &&
        held.lease === lease &&
        held.prepared &&
        !held.activating &&
        !!binding &&
        binding.ledger.isIdentityLeaseReady(lease)
      );
    },
    activate,
    resume: activate,
    release(lease) {
      const cell = held,
        root = binding;
      if (
        !cell ||
        cell.lease !== lease ||
        cell.activating ||
        !cell.readyOwner ||
        !root ||
        root.ledger.getIdentityState().ownerToken !== cell.readyOwner ||
        !root.ledger.releaseIdentityLease(lease, cell.readyOwner)
      )
        throw new Error('The exact activated wallet lease could not be released.');
      held = null;
    },
  };
  return {
    financial,
    bind(value: FinancialRootBinding) {
      binding = value;
      revision++;
      pulse();
      return () => {
        if (binding === value) {
          binding = null;
          revision++;
          pulse();
        }
      };
    },
    async recoverSavedWallet() {
      const root = binding;
      if (!root) return false;
      const actual = root.ledger.getIdentityState();
      if (actual.identityPending) return true;
      if (actual.writeInFlight) return false;
      return root.ledger.uncertain || root.ledger.loadError ? root.ledger.restore() : true;
    },
    async confirmCommittedOwner(target: ActivatedWallet, isCurrent: () => boolean) {
      if (held || !binding || binding.ledger.getIdentityState().ownerToken !== target.ownerToken)
        return false;
      return (await readyOwner(target, () => !held && current(isCurrent))).ok;
    },
    hasHeldLease: () => held !== null,
  };
}

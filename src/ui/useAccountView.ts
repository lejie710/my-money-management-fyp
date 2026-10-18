import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AccountResult, AccountUiController, LocalResetController } from './accountUiTypes';

export function useAccountView(controller: AccountUiController) {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  // Root owns initialization/disposal. Mounting a screen must not start or repeat Auth work.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
export function useLocalResetView(controller: LocalResetController) {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** A UI duplicate/late-result guard, never a substitute for the coordinator's operation queue. */
export function useAccountOperation(viewToken: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AccountResult | null>(null);
  const session = useRef<{ active: boolean; busy: boolean; token: string } | null>(null);
  const latestToken = useRef(viewToken);
  latestToken.current = viewToken;
  useLayoutEffect(() => {
    const current = { active: true, busy: false, token: viewToken };
    session.current = current;
    setBusy(false);
    setResult(null);
    return () => {
      current.active = false;
      if (session.current === current) session.current = null;
    };
  }, [viewToken]);
  const run = async (work: () => Promise<AccountResult>) => {
    const current = session.current;
    if (
      !current?.active ||
      current.busy ||
      current.token !== viewToken ||
      latestToken.current !== viewToken
    )
      return null;
    current.busy = true;
    setBusy(true);
    setResult(null);
    try {
      const outcome = await work();
      if (!current.active || session.current !== current || latestToken.current !== viewToken)
        return null;
      setResult(outcome);
      return outcome;
    } catch {
      if (!current.active || session.current !== current || latestToken.current !== viewToken)
        return null;
      const outcome = {
        ok: false,
        pending: true,
        message:
          'The operation could not be confirmed. Check the saved session before trying another account action.',
      };
      setResult(outcome);
      return outcome;
    } finally {
      current.busy = false;
      if (current.active && session.current === current) setBusy(false);
    }
  };
  return {
    busy,
    result,
    run,
    clear: () => {
      if (latestToken.current === viewToken) setResult(null);
    },
  };
}

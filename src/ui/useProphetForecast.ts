import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExpenseForecast } from '../core/forecast';
import {
  ForecastError,
  inputFromForecast,
  validateResult,
  type ForecastInput,
  type ProphetResponse,
} from '../forecast/protocol';
import type { ForecastTransportBinding } from '../forecast/client';

type View = { key: object; busy: boolean; response: ProphetResponse | null; message: string };
export function useProphetForecast({
  result,
  ownerKey,
  changed,
  binding,
}: {
  result: ExpenseForecast | null;
  ownerKey: string;
  changed: boolean;
  binding?: ForecastTransportBinding | null;
}) {
  const prepared = useMemo<{ input: ForecastInput | null; message: string }>(() => {
    if (!result) return { input: null, message: 'Apply a valid date and expense category first.' };
    try {
      return { input: inputFromForecast(result), message: '' };
    } catch (error) {
      return {
        input: null,
        message: error instanceof Error ? error.message : 'The selected history is unavailable.',
      };
    }
  }, [result]);
  const key = useMemo(
    () => ({}),
    [ownerKey, prepared.input, changed, binding?.key, binding?.transport],
  );
  const latest = useRef({ key, binding });
  latest.current = { key, binding };
  const alive = useRef(false);
  const active = useRef<{ key: object; abort: AbortController } | null>(null);
  const [stored, setStored] = useState<View>({ key, busy: false, response: null, message: '' });
  const current = () => {
    try {
      return (
        alive.current &&
        latest.current.key === key &&
        !!ownerKey &&
        !changed &&
        latest.current.binding === binding &&
        !!binding?.isCurrent()
      );
    } catch {
      return false;
    }
  };
  const validBinding = (() => {
    try {
      return !!binding?.isCurrent();
    } catch {
      return false;
    }
  })();
  const view =
    stored.key === key && validBinding ? stored : { key, busy: false, response: null, message: '' };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      active.current?.abort.abort();
      active.current = null;
    };
  }, []);
  useEffect(() => {
    active.current?.abort.abort();
    active.current = null;
    setStored({ key, busy: false, response: null, message: '' });
    return () => {
      if (active.current?.key === key) {
        active.current.abort.abort();
        active.current = null;
      }
    };
  }, [key]);
  const run = async () => {
    if (!current() || !binding || !prepared.input || active.current) return false;
    const entry = { key, abort: new AbortController() };
    active.current = entry;
    setStored((old) => ({
      key,
      busy: true,
      response: old.key === key ? old.response : null,
      message: '',
    }));
    try {
      const response = await binding.transport(prepared.input, { signal: entry.abort.signal });
      if (!current() || active.current !== entry || entry.abort.signal.aborted) return false;
      const validated = validateResult(response, {
        ...prepared.input,
        requestId: response.requestId,
      });
      setStored({
        key,
        busy: false,
        response: validated,
        message: 'Prophet completed the selected monthly history. Your records are unchanged.',
      });
      return true;
    } catch (error) {
      if (current() && active.current === entry && !entry.abort.signal.aborted)
        setStored((old) => ({
          key,
          busy: false,
          response: old.key === key ? old.response : null,
          message:
            error instanceof ForecastError
              ? error.message
              : 'Prophet could not complete this request.',
        }));
      return false;
    } finally {
      if (active.current === entry) active.current = null;
    }
  };
  const cancel = () => {
    const entry = active.current;
    if (entry?.key === key) {
      entry.abort.abort();
      active.current = null;
    }
    if (alive.current && latest.current.key === key)
      setStored((old) => ({
        key,
        busy: false,
        response: old.key === key ? old.response : null,
        message: 'Request cancelled. No late result will be shown.',
      }));
  };
  return {
    ...view,
    run,
    cancel,
    configured: !!binding && validBinding,
    canRun: current() && !!prepared.input && !view.busy,
    unavailable:
      !binding || !validBinding
        ? 'Connect Prophet in Wallet > Connections. The device forecast remains available.'
        : changed
          ? 'Apply the edited selection or refresh changed records before requesting Prophet.'
          : prepared.message,
  };
}

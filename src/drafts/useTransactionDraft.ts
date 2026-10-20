import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  createDraftWriter,
  type SavedTransactionDraft,
  type TransactionDraftSnapshot,
  type TransactionDraftStore,
} from './transactionDrafts';
const absent = Object.freeze({ saving: false, error: '', saved: false, revision: 0 });
const noSubscribe = () => () => {};
const getAbsent = () => absent;
export function useTransactionDraft({
  store,
  initial,
  value,
  isCurrent,
}: {
  store?: TransactionDraftStore;
  initial: TransactionDraftSnapshot;
  value: SavedTransactionDraft;
  isCurrent?: () => boolean;
}) {
  const writer = useMemo(
    () => (store ? createDraftWriter(store, initial) : null),
    [store, initial],
  );
  const state = useSyncExternalStore(
    writer?.subscribe ?? noSubscribe,
    writer?.getSnapshot ?? getAbsent,
    getAbsent,
  );
  const original = useRef(JSON.stringify(value));
  const changed = useRef(!!initial.record);
  const latest = useRef(value);
  latest.current = value;
  const bytes = JSON.stringify(value);
  useEffect(() => {
    writer?.activate();
    return () => {
      writer?.retire();
    };
  }, [writer]);
  useEffect(() => {
    if (!writer || !(isCurrent?.() ?? true)) return;
    if (bytes !== original.current) changed.current = true;
    if (changed.current) writer.enqueue(value);
  }, [writer, bytes]);
  return {
    ...state,
    enabled: !!writer,
    async flush() {
      if (!writer) return true;
      if (!(isCurrent?.() ?? true)) return false;
      if (changed.current || JSON.stringify(latest.current) !== original.current) {
        changed.current = true;
        writer.enqueue(latest.current);
      }
      return writer.flush();
    },
    // Called only after the same editor's finance save has been confirmed.
    complete: () => (writer ? writer.discard() : Promise.resolve(true)),
  };
}

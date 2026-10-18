import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Ledger } from '../core/model';
import { contextForTransaction, photoKey } from '../core/transactionContext';
import {
  createPhotoManager,
  photoFamilyToken,
  type PhotoManager,
  type PhotoCleanupResult,
} from '../attachments/photoManager';
import { createPhotoFileAdapter } from '../attachments/photoFiles';
import { createContextServices } from '../attachments/services';
import { encodeReminderOwner } from '../reminders/store';
import type { DataFamily } from '../accounts/identity';
import type { LedgerStorage } from './ledgerRuntime';
import type { TransactionContextServices } from './transactionContextTypes';
import { localLedgerFamily, localLedgerStorage } from './useLedger';

type Journal = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
};
type Options = { family?: DataFamily; ledgerStorage?: LedgerStorage; journalStorage?: Journal };
type Binding = {
  photos: PhotoManager;
  services: TransactionContextServices;
  familyToken: string;
  storage: LedgerStorage;
  initialization: Promise<PhotoCleanupResult>;
};
const stopped = (message: string): PhotoCleanupResult => ({
  deleted: 0,
  retained: 0,
  pending: true,
  message,
});

export function useWalletPhotos(ledger: Ledger | null, active: boolean, options: Options = {}) {
  const requestedFamily = options.family ?? localLedgerFamily;
  const familyToken = photoFamilyToken(requestedFamily);
  const family = useMemo<DataFamily>(
    () => JSON.parse(JSON.stringify(requestedFamily)),
    [familyToken],
  );
  if (!options.ledgerStorage && familyToken !== photoFamilyToken(localLedgerFamily))
    throw new Error('Account photos require their exact family ledger storage.');
  const storage = options.ledgerStorage ?? localLedgerStorage;
  const journal = options.journalStorage ?? AsyncStorage;
  const [binding, setBinding] = useState<Binding | null>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const suspended = useRef(false);
  const enabled = active && !!ledger && !suspended.current;
  const activeRef = useRef(enabled);
  activeRef.current = enabled;
  const familyRef = useRef(familyToken);
  familyRef.current = familyToken;
  const storageRef = useRef(storage);
  storageRef.current = storage;
  const currentOwner = useRef(
    ledger ? encodeReminderOwner({ ...family, incarnationId: ledger.wallet.incarnationId }) : null,
  );
  currentOwner.current = ledger
    ? encodeReminderOwner({ ...family, incarnationId: ledger.wallet.incarnationId })
    : null;
  const incarnationRef = useRef(ledger?.wallet.incarnationId);
  incarnationRef.current = ledger?.wallet.incarnationId;
  const bindingRef = useRef<Binding | null>(null);
  const suspensionRef = useRef<Promise<PhotoCleanupResult> | null>(null);
  const suspensionDone = useRef(true);
  const contextRef = useRef({ family, familyToken, storage, journal });
  contextRef.current = { family, familyToken, storage, journal };
  const isCurrent = (value: Binding) =>
    activeRef.current &&
    !suspended.current &&
    bindingRef.current === value &&
    familyRef.current === value.familyToken &&
    storageRef.current === value.storage;
  useEffect(() => {
    if (!enabled) {
      setBinding(null);
      return;
    }
    let alive = true;
    const files = createPhotoFileAdapter(encodeURIComponent(familyToken));
    const photos = createPhotoManager({
      family,
      files,
      journal,
      ledgerStorage: storage,
      now: Date.now,
      newId: (kind) =>
        `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
    });
    const next: Binding = {
      photos,
      services: createContextServices(files),
      familyToken,
      storage,
      initialization: photos.initialize(),
    };
    bindingRef.current = next;
    setBinding(next);
    setPending(false);
    setMessage('');
    void next.initialization
      .then((result) => {
        if (alive && isCurrent(next)) {
          setPending(result.pending);
          setMessage(result.pending ? result.message : '');
        }
      })
      .catch(() => {
        if (alive && isCurrent(next)) {
          setPending(true);
          setMessage(
            'Photo storage needs another check. Saved financial records remain available.',
          );
        }
      });
    return () => {
      alive = false;
      if (bindingRef.current === next) bindingRef.current = null;
      photos.dispose();
    };
  }, [enabled, familyToken, storage, journal, epoch]);

  const previous = useRef<{
    familyToken: string;
    storage: LedgerStorage;
    ledger: Ledger | null;
  } | null>(null);
  useEffect(() => {
    const old = previous.current;
    previous.current = { familyToken, storage, ledger };
    if (
      !binding ||
      !isCurrent(binding) ||
      !ledger ||
      !old?.ledger ||
      old.ledger === ledger ||
      old.familyToken !== familyToken ||
      old.storage !== storage
    )
      return;
    const currentKeys = new Set(
      ledger.transactions.flatMap((row) => {
        const photo = contextForTransaction(row).photo;
        return photo ? [photoKey(photo)] : [];
      }),
    );
    const retired = old.ledger.transactions.flatMap((row) => {
      const photo = contextForTransaction(row).photo;
      return photo && !currentKeys.has(photoKey(photo)) ? [photo] : [];
    });
    if (!retired.length) return;
    let alive = true;
    void binding.photos
      .queueCleanup(retired)
      .then((result) => {
        if (alive && isCurrent(binding) && result.pending) {
          setPending(true);
          setMessage(result.message);
        }
      })
      .catch(() => {
        if (alive && isCurrent(binding)) {
          setPending(true);
          setMessage('Records saved. Unused photo cleanup is pending.');
        }
      });
    return () => {
      alive = false;
    };
  }, [ledger, binding, familyToken, storage]);
  const onCleanupMessage = useCallback(
    (owner: string, text: string) => {
      if (
        binding &&
        isCurrent(binding) &&
        (currentOwner.current === owner || incarnationRef.current === owner)
      ) {
        setPending(true);
        setMessage(text);
      }
    },
    [binding],
  );
  const retry = useCallback(async () => {
    if (!binding || !isCurrent(binding)) return;
    const owner = currentOwner.current;
    try {
      const result = await binding.photos.retryCleanup();
      if (isCurrent(binding) && currentOwner.current === owner) {
        setPending(result.pending);
        setMessage(result.pending ? result.message : 'Unused photo storage checked.');
      }
    } catch {
      if (isCurrent(binding) && currentOwner.current === owner) {
        setPending(true);
        setMessage('Photo cleanup is still pending. Saved records are unchanged.');
      }
    }
  }, [binding]);
  const suspendForIdentity = useCallback(
    (expectedOwnerToken: string | null): Promise<PhotoCleanupResult> => {
      if (currentOwner.current !== expectedOwnerToken)
        return Promise.resolve(stopped('Photo ownership changed before account preparation.'));
      if (suspended.current && suspensionRef.current) return suspensionRef.current;
      const current = bindingRef.current;
      suspended.current = true;
      activeRef.current = false;
      bindingRef.current = null;
      setBinding(null);
      setEpoch((value) => value + 1);
      suspensionDone.current = false;
      try {
        const context = contextRef.current;
        // A remounted hook can have no visible binding while the prior binding's
        // family queue still drains. Pure construction + drain performs no new IO.
        const photos =
          current?.photos ??
          createPhotoManager({
            family: context.family,
            files: createPhotoFileAdapter(encodeURIComponent(context.familyToken)),
            journal: context.journal,
            ledgerStorage: context.storage,
            now: Date.now,
            newId: (kind) =>
              `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
          });
        if (current) photos.dispose();
        const promise = photos.drain().then(
          () => {
            suspensionDone.current = true;
            return {
              deleted: 0,
              retained: 0,
              pending: false,
              message:
                'Previous photo operations have settled; reference-safe cleanup state is retained.',
            };
          },
          () => stopped('Previous photo operations are still unresolved.'),
        );
        suspensionRef.current = promise;
        return promise;
      } catch {
        const promise = Promise.resolve(stopped('Previous photo ownership could not be checked.'));
        suspensionRef.current = promise;
        return promise;
      }
    },
    [],
  );
  const resumeAfterIdentity = useCallback((expectedFamily: DataFamily) => {
    if (photoFamilyToken(expectedFamily) !== familyRef.current || !suspensionDone.current)
      return false;
    if (!suspended.current) return true;
    suspended.current = false;
    suspensionRef.current = null;
    setEpoch((value) => value + 1);
    return true;
  }, []);
  const visible = binding && isCurrent(binding) ? binding : null;
  return {
    photos: visible?.photos,
    services: visible?.services,
    familyToken,
    ownerToken: currentOwner.current,
    message: visible ? message : '',
    pending: visible ? pending : false,
    retry,
    onCleanupMessage,
    suspendForIdentity,
    resumeAfterIdentity,
    suspended: suspended.current,
    async readyForIdentity(
      expectedOwnerToken: string,
      isOwnerCurrent: () => boolean,
    ): Promise<PhotoCleanupResult> {
      const current = bindingRef.current;
      if (
        !current ||
        !isCurrent(current) ||
        currentOwner.current !== expectedOwnerToken ||
        !isOwnerCurrent()
      )
        return stopped('Photos are still opening for this exact owner.');
      try {
        const result = await current.initialization;
        return isCurrent(current) && currentOwner.current === expectedOwnerToken && isOwnerCurrent()
          ? result
          : stopped('Photo ownership changed during activation.');
      } catch {
        return stopped(
          'Photo ownership metadata could not be checked. Existing files are retained.',
        );
      }
    },
  };
}

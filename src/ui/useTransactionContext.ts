import { useEffect, useRef, useState } from 'react';
import {
  contextForTransaction,
  normalizeContextPatch,
  type PersonSnapshot,
  type PhotoRef,
  type PlaceSnapshot,
  type TransactionContext,
  type TransactionContextPatch,
} from '../core/transactionContext';
import type { PhotoDraft, PhotoManager, PickedPhoto } from '../attachments/photoManager';
import type { PlaceCandidate, TransactionContextServices } from './transactionContextTypes';

type PhotoEdit = { kind: 'keep' } | { kind: 'remove' } | { kind: 'selected'; picked: PickedPhoto };
type Operation = 'photo' | 'person' | 'place';
type Session = {
  active: boolean;
  revision: Record<Operation, number>;
  manager: PhotoManager | null;
  draft: PhotoDraft | null;
  staged: { uri: string; photo: PhotoRef } | null;
  locked: boolean;
};
type Options = {
  /** The editor must be keyed by the complete family, incarnation and transaction identity. */
  sessionKey: string;
  ownerIncarnationId: string;
  initial: { context?: TransactionContext };
  photos: PhotoManager | null;
  services: TransactionContextServices | null;
  onCleanupMessage?: (message: string) => void;
};

export function useTransactionContext({
  sessionKey,
  ownerIncarnationId,
  initial,
  photos,
  services,
  onCleanupMessage,
}: Options) {
  const [original] = useState(() => contextForTransaction(initial));
  const [notes, setNotes] = useState(original.notes);
  const [person, setPerson] = useState<PersonSnapshot | null>(original.withPerson);
  const [place, setPlace] = useState<PlaceSnapshot | null>(original.location);
  const [photoEdit, setPhotoEdit] = useState<PhotoEdit>({ kind: 'keep' });
  const [personCandidate, setPersonCandidate] = useState<PersonSnapshot | null>(null);
  const [placeCandidate, setPlaceCandidate] = useState<PlaceCandidate | null>(null);
  const [pending, setPending] = useState<Operation | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef<Session | null>(null);
  const cleanupRef = useRef(onCleanupMessage);
  cleanupRef.current = onCleanupMessage;

  const release = async (session: Session) => {
    if (!session.draft || !session.manager) return;
    const draft = session.draft;
    session.draft = null;
    try {
      const result = await session.manager.closeDraft(draft);
      if (result.pending) cleanupRef.current?.(result.message);
    } catch {
      cleanupRef.current?.('Photo cleanup is pending. Saved financial records are unchanged.');
    }
  };

  useEffect(() => {
    const session: Session = {
      active: true,
      revision: { photo: 0, person: 0, place: 0 },
      manager: photos,
      draft: null,
      staged: null,
      locked: false,
    };
    sessionRef.current = session;
    return () => {
      session.active = false;
      void release(session);
    };
  }, [sessionKey, photos]);

  const current = () => {
    const session = sessionRef.current;
    if (!session?.active) throw new Error('This transaction editor is no longer active.');
    return session;
  };
  const invalidate = (kind: Operation) => {
    const session = current();
    if (session.locked) return false;
    session.revision[kind]++;
    setPending((value) => (value === kind ? null : value));
    setError('');
    return true;
  };
  const run = async <T>(kind: Operation, request: () => Promise<T>, apply: (result: T) => void) => {
    const session = current();
    if (session.locked) return;
    const revision = ++session.revision[kind];
    const valid = () =>
      session.active &&
      sessionRef.current === session &&
      session.revision[kind] === revision &&
      !session.locked;
    setPending(kind);
    setError('');
    try {
      const result = await request();
      if (valid()) apply(result);
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : 'The optional detail could not be loaded. You can enter it manually.',
        );
    } finally {
      if (valid()) setPending((value) => (value === kind ? null : value));
    }
  };

  const preparePatch = async () => {
    const session = current();
    if (session.locked) throw new Error('This transaction is already being saved.');
    // Validate the entire textual draft before staging any file.
    const patch = normalizeContextPatch({
      notes,
      withPerson: person,
      location: place,
    })!;
    session.locked = true;
    session.revision.photo++;
    session.revision.person++;
    session.revision.place++;
    setPending(null);
    setPreparing(true);
    try {
      let photo = photoEdit.kind === 'remove' ? null : original.photo;
      if (photoEdit.kind === 'selected') {
        if (!session.manager)
          throw new Error('Photo storage is not ready. Keep this draft and try again.');
        if (!session.draft) session.draft = session.manager.beginDraft(ownerIncarnationId);
        if (session.staged?.uri !== photoEdit.picked.uri) {
          const staged = await session.manager.stage(session.draft, photoEdit.picked);
          if (!session.active || sessionRef.current !== session)
            throw new Error('This transaction editor changed before the photo was ready.');
          session.staged = { uri: photoEdit.picked.uri, photo: staged };
        }
        photo = session.staged.photo;
      }
      if (!session.active || sessionRef.current !== session)
        throw new Error('This transaction editor is no longer active.');
      return {
        patch: { ...patch, photo } as TransactionContextPatch,
        isCurrent: () => session.active && sessionRef.current === session,
        complete: (committed: boolean) => finishCommit(session, committed, false),
      };
    } catch (cause) {
      if (session.active && sessionRef.current === session) {
        session.locked = false;
        setPreparing(false);
      }
      throw cause;
    }
  };

  const finishCommit = async (session: Session, committed: boolean, deleted: boolean) => {
    if (!committed) {
      if (session.active && sessionRef.current === session) {
        session.locked = false;
        setPreparing(false);
      }
      return;
    }
    session.active = false;
    await release(session);
    if (original.photo && (deleted || photoEdit.kind !== 'keep') && session.manager) {
      try {
        const result = await session.manager.queueCleanup([original.photo]);
        if (result.pending) cleanupRef.current?.(result.message);
      } catch {
        cleanupRef.current?.('Transaction saved. Previous photo cleanup is pending.');
      }
    }
  };

  return {
    notes,
    person,
    place,
    photoEdit,
    originalPhoto: original.photo,
    personCandidate,
    placeCandidate,
    pending,
    preparing,
    error,
    setError,
    preparePatch,
    prepareDeletion() {
      const session = current();
      if (session.locked) throw new Error('This transaction is already being saved.');
      session.locked = true;
      session.revision.photo++;
      session.revision.person++;
      session.revision.place++;
      setPending(null);
      setPreparing(true);
      return {
        isCurrent: () => session.active && sessionRef.current === session,
        complete: (committed: boolean) => finishCommit(session, committed, true),
      };
    },
    setNotes(value: string) {
      if (!current().locked) {
        setNotes(value);
        setError('');
      }
    },
    setPersonName(name: string) {
      if (invalidate('person')) {
        setPersonCandidate(null);
        setPerson(name ? { name, source: 'manual' } : null);
      }
    },
    setPlaceLabel(label: string) {
      if (invalidate('place')) {
        setPlaceCandidate(null);
        setPlace(label ? { label, source: 'manual' } : null);
      }
    },
    removePhoto() {
      if (invalidate('photo')) setPhotoEdit({ kind: 'remove' });
    },
    async pickPhoto() {
      if (!services) {
        setError('The photo library is unavailable in this build.');
        return;
      }
      await run(
        'photo',
        () => services.pickPhoto(),
        (value) => {
          if (value) {
            // A new selection can reuse a provider/cache URI with different bytes.
            // Only an unchanged Save retry may reuse the previously verified copy.
            current().staged = null;
            setPhotoEdit({ kind: 'selected', picked: value });
          }
        },
      );
    },
    async pickPerson() {
      if (!services) {
        setError('Contacts are unavailable. Enter the name manually.');
        return;
      }
      await run(
        'person',
        () => services.pickContactName(),
        (value) => {
          if (value)
            setPersonCandidate(normalizeContextPatch({ withPerson: value })!.withPerson ?? null);
        },
      );
    },
    confirmPerson() {
      if (personCandidate && invalidate('person')) {
        setPerson({ ...personCandidate });
        setPersonCandidate(null);
      }
    },
    cancelPerson() {
      if (invalidate('person')) setPersonCandidate(null);
    },
    async locatePlace() {
      if (!services) {
        setError('Location is unavailable. Enter the place manually.');
        return;
      }
      await run(
        'place',
        () => services.currentPlace(),
        (value) => {
          if (!value.label?.trim()) {
            setError('No address was returned. Enter a place label manually.');
            return;
          }
          const place = normalizeContextPatch({
            location: { label: value.label, source: value.source },
          })!.location!;
          setPlaceCandidate({ ...value, label: place.label });
        },
      );
    },
    confirmPlace() {
      if (placeCandidate?.label && invalidate('place')) {
        setPlace({
          label: placeCandidate.label,
          source: placeCandidate.source,
        });
        setPlaceCandidate(null);
      }
    },
    cancelPlace() {
      if (invalidate('place')) setPlaceCandidate(null);
    },
    acceptMapPlace(value: PlaceSnapshot) {
      if (invalidate('place')) {
        setPlace({ label: value.label, source: value.source });
        setPlaceCandidate(null);
      }
    },
    invalidatePlace() {
      invalidate('place');
      setPlaceCandidate(null);
    },
    close() {
      const session = current();
      if (session.locked) return false;
      session.active = false;
      void release(session);
      return true;
    },
  };
}

export type TransactionContextDraft = ReturnType<typeof useTransactionContext>;

import { useLayoutEffect, useRef, useState } from 'react';
import {
  amountInputValue,
  patchTransactionContext,
  saveTransaction,
  type Ledger,
  type Transaction,
} from '../core/model';
import {
  parseReceipt,
  reviewedReceiptTransaction,
  type ReceiptCandidate,
  type ReceiptReview,
} from '../core/receipt';
import type { PhotoDraft, PhotoRef } from '../attachments/photoManager';
import { newId } from './TransactionEditor';
import type { SaveLedger } from './useLedger';
import type { ReceiptImageSelection, ReceiptUiBinding } from './receiptUiTypes';

type Phase = 'empty' | 'selecting' | 'selected' | 'recognizing' | 'review' | 'blank' | 'saving';
type Session = {
  key: string;
  ownerIncarnationId: string;
  capture: ReceiptUiBinding['capture'];
  photos: ReceiptUiBinding['photos'];
  client: ReceiptUiBinding['client'];
  providerKey: string;
  active: boolean;
  revision: number;
  saving: boolean;
  selecting: boolean;
  image: ReceiptImageSelection | null;
  abort: AbortController | null;
  photoDraft: PhotoDraft | null;
  staged: { imageId: string; photo: PhotoRef } | null;
  closing: Promise<void> | null;
};
type Options = {
  ledger: Ledger;
  binding: ReceiptUiBinding;
  onSave: SaveLedger;
  onClose: () => void;
  /** Root may supply the shared future provenance helper; never store raw OCR here. */
  prepareReceiptOrigin?: (transaction: Transaction, captureId: string) => Transaction;
};
const emptyReview = (ledger: Ledger): ReceiptReview => ({
  title: '',
  date: '',
  amount: '',
  categoryId: '',
  currency: ledger.wallet.currency,
  confirmed: false,
});

export function useReceiptCapture({
  ledger,
  binding,
  onSave,
  onClose,
  prepareReceiptOrigin,
}: Options) {
  const renderKey = binding.sessionKey;
  const renderOwner = ledger.wallet.incarnationId;
  const renderCapture = binding.capture;
  const renderPhotos = binding.photos;
  const providerKey = JSON.stringify(binding.provider ?? null);
  const providerRef = useRef({ key: providerKey, client: binding.client });
  providerRef.current = { key: providerKey, client: binding.client };
  const [phase, setPhase] = useState<Phase>('empty');
  const [image, setImage] = useState<ReceiptImageSelection | null>(null);
  const [candidate, setCandidate] = useState<ReceiptCandidate | null>(null);
  const [review, setReview] = useState<ReceiptReview>(() => emptyReview(ledger));
  const [keepPhoto, setKeepPhoto] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [transactionId] = useState(() => newId('transaction'));
  const sessionRef = useRef<Session | null>(null);
  const ownerRef = useRef(ledger.wallet.incarnationId);
  ownerRef.current = ledger.wallet.incarnationId;
  const keyRef = useRef(binding.sessionKey);
  keyRef.current = binding.sessionKey;
  const cleanupRef = useRef(binding.onCleanupMessage);
  cleanupRef.current = binding.onCleanupMessage;

  const releaseImage = async (selected: ReceiptImageSelection) => {
    try {
      await binding.capture.release(selected);
    } catch {
      cleanupRef.current?.(
        'The temporary receipt image needs a cleanup retry. Saved financial records are unchanged.',
      );
    }
  };
  const releaseSession = (session: Session) => {
    if (session.closing) return session.closing;
    session.abort?.abort();
    session.abort = null;
    const draft = session.photoDraft,
      selected = session.image;
    session.photoDraft = null;
    session.image = null;
    session.closing = (async () => {
      if (draft && binding.photos) {
        try {
          const result = await binding.photos.closeDraft(draft);
          if (result.pending)
            (binding.onPhotoCleanupMessage ?? cleanupRef.current)?.(result.message);
        } catch {
          (binding.onPhotoCleanupMessage ?? cleanupRef.current)?.(
            'Owned receipt-photo cleanup is pending. Saved records are retained.',
          );
        }
      }
      if (selected) await releaseImage(selected);
    })();
    return session.closing;
  };
  useLayoutEffect(() => {
    const session: Session = {
      key: binding.sessionKey,
      ownerIncarnationId: ledger.wallet.incarnationId,
      capture: binding.capture,
      photos: binding.photos,
      client: binding.client,
      providerKey,
      active: true,
      revision: 0,
      saving: false,
      selecting: false,
      image: null,
      abort: null,
      photoDraft: null,
      staged: null,
      closing: null,
    };
    sessionRef.current = session;
    const closeDraft = () => {
      session.active = false;
      session.revision++;
      return releaseSession(session);
    };
    const detach = binding.attachLifecycle?.(closeDraft);
    setImage(null);
    setCandidate(null);
    setReview(emptyReview(ledger));
    setPhase('empty');
    setKeepPhoto(false);
    setError('');
    setMessage('');
    return () => {
      detach?.();
      void closeDraft();
    };
  }, [
    binding.sessionKey,
    binding.capture,
    binding.photos,
    binding.client,
    providerKey,
    ledger.wallet.incarnationId,
  ]);
  const valid = (session: Session, revision: number) =>
    session.active &&
    sessionRef.current === session &&
    session.revision === revision &&
    keyRef.current === session.key &&
    ownerRef.current === session.ownerIncarnationId &&
    providerRef.current.key === session.providerKey &&
    providerRef.current.client === session.client &&
    (binding.isCurrent?.() ?? true);
  const currentSession = () => {
    const session = sessionRef.current;
    return session?.active &&
      session.key === renderKey &&
      session.ownerIncarnationId === renderOwner &&
      session.capture === renderCapture &&
      session.photos === renderPhotos &&
      session.providerKey === providerKey &&
      session.client === binding.client &&
      keyRef.current === renderKey &&
      ownerRef.current === renderOwner &&
      (binding.isCurrent?.() ?? true)
      ? session
      : null;
  };

  const select = async (kind: 'library' | 'camera') => {
    const session = currentSession();
    if (!session?.active || session.saving || session.selecting) return;
    if (kind === 'camera' && !binding.capture.cameraAvailable) {
      setError('Camera capture is unavailable in this build. Choose a receipt image instead.');
      return;
    }
    session.abort?.abort();
    session.abort = null;
    const revision = ++session.revision;
    const previousPhase = candidate
      ? candidate.status === 'empty'
        ? 'blank'
        : 'review'
      : session.image
        ? 'selected'
        : 'empty';
    session.selecting = true;
    setPhase('selecting');
    setError('');
    setMessage('');
    try {
      const selected = await (kind === 'camera'
        ? binding.capture.takePhoto()
        : binding.capture.pickPhoto());
      if (!valid(session, revision)) {
        if (selected) void releaseImage(selected);
        return;
      }
      if (!selected) {
        setPhase(previousPhase);
        return;
      }
      const previous = session.image;
      session.image = selected;
      session.staged = null;
      setImage(selected);
      setCandidate(null);
      setReview(emptyReview(ledger));
      setKeepPhoto(false);
      setPhase('selected');
      if (previous) void releaseImage(previous);
    } catch (cause) {
      if (valid(session, revision)) {
        setPhase(previousPhase);
        setError(
          cause instanceof Error
            ? cause.message
            : 'The receipt image could not be selected. Try again or use manual entry.',
        );
      }
    } finally {
      session.selecting = false;
    }
  };
  const recognize = async () => {
    const session = currentSession();
    if (!session?.active || session.saving || session.selecting || !session.image || session.abort)
      return;
    if (!binding.client) {
      setError(
        'Receipt recognition is not connected. Pair the selected provider first, or enter the transaction manually.',
      );
      return;
    }
    const selected = session.image,
      revision = ++session.revision,
      abort = new AbortController();
    session.abort = abort;
    setPhase('recognizing');
    setError('');
    setMessage('');
    try {
      const bytes = await binding.capture.readBytes(selected, {
        signal: abort.signal,
      });
      if (!valid(session, revision) || abort.signal.aborted) return;
      const recognized = await binding.client.recognize(bytes, {
        signal: abort.signal,
      });
      if (!valid(session, revision) || abort.signal.aborted) return;
      if (binding.provider && recognized.provider !== binding.provider.engine)
        throw new Error('The receipt provider changed. Reopen capture after pairing again.');
      const parsed = parseReceipt(recognized, {
        walletCurrency: ledger.wallet.currency,
        today: binding.today,
      });
      setCandidate(parsed);
      setReview({
        title: parsed.title.suggested ?? '',
        date: parsed.date.suggested ?? '',
        amount:
          parsed.total.suggestedMinor === null
            ? ''
            : amountInputValue(parsed.total.suggestedMinor, ledger.wallet.currency),
        categoryId: '',
        currency: ledger.wallet.currency,
        confirmed: false,
      });
      setPhase(parsed.status === 'empty' ? 'blank' : 'review');
      setMessage(
        parsed.status === 'empty'
          ? 'No text was recognized. No fields or transaction were created.'
          : 'Suggestions are ready. Check them against the image before confirming.',
      );
    } catch (cause) {
      if (valid(session, revision) && !abort.signal.aborted) {
        setPhase(
          candidate
            ? candidate.status === 'empty'
              ? 'blank'
              : 'review'
            : session.image
              ? 'selected'
              : 'empty',
        );
        setError(
          cause instanceof Error
            ? cause.message
            : 'Receipt recognition failed. Your image and previous reviewed fields were kept; retry deliberately or use manual entry.',
        );
      }
    } finally {
      if (session.abort === abort) session.abort = null;
    }
  };
  const cancelRecognition = () => {
    const session = currentSession();
    if (!session?.active || session.saving) return;
    session.revision++;
    session.abort?.abort();
    session.abort = null;
    setPhase(
      candidate
        ? candidate.status === 'empty'
          ? 'blank'
          : 'review'
        : session.image
          ? 'selected'
          : 'empty',
    );
    setMessage(
      binding.provider?.processing === 'cloud'
        ? 'Stopped waiting for recognition. Google Cloud Vision may already have processed the image; cancellation does not guarantee charges are avoided. No transaction was created.'
        : 'Stopped waiting for recognition. No transaction was created.',
    );
    setError('');
  };
  const update = (field: 'title' | 'date' | 'amount' | 'categoryId', value: string) => {
    const session = currentSession();
    if (
      !session?.active ||
      session.saving ||
      session.selecting ||
      session.abort ||
      phase !== 'review'
    )
      return;
    setReview((current) => ({ ...current, [field]: value, confirmed: false }));
    setError('');
  };
  const confirm = async () => {
    const session = currentSession();
    if (
      !session?.active ||
      session.saving ||
      session.selecting ||
      session.abort ||
      phase !== 'review' ||
      !session.image ||
      !candidate ||
      candidate.status !== 'review'
    )
      return;
    const revision = session.revision,
      selected = session.image;
    session.saving = true;
    setPhase('saving');
    setError('');
    try {
      let transaction = reviewedReceiptTransaction(ledger, candidate, review, transactionId);
      if (prepareReceiptOrigin) transaction = prepareReceiptOrigin(transaction, selected.id);
      if (keepPhoto) {
        if (!binding.photos)
          throw new Error(
            'Photo storage is not ready. Retry, or turn off Keep photo before confirming.',
          );
        if (!session.photoDraft)
          session.photoDraft = binding.photos.beginDraft(ledger.wallet.incarnationId);
        if (session.staged?.imageId !== selected.id) {
          const photo = await binding.photos.stage(session.photoDraft, {
            uri: selected.uri,
          });
          if (!valid(session, revision)) return;
          session.staged = { imageId: selected.id, photo };
        }
        transaction = patchTransactionContext(transaction, { photo: session.staged.photo }, ledger);
      }
      if (!valid(session, revision)) return;
      const saved = await onSave(
        saveTransaction(ledger, transaction),
        'Reviewed receipt expense saved.',
      );
      if (saved) {
        const active = valid(session, revision);
        session.active = false;
        void releaseSession(session);
        if (active) onClose();
      } else if (valid(session, revision)) setPhase('review');
    } catch (cause) {
      if (valid(session, revision)) {
        setPhase('review');
        setError(
          cause instanceof Error
            ? cause.message
            : 'Check the reviewed receipt fields and try again.',
        );
      }
    } finally {
      session.saving = false;
    }
  };
  return {
    phase,
    image,
    candidate,
    review,
    keepPhoto,
    error,
    message,
    select,
    recognize,
    cancelRecognition,
    update,
    confirm,
    setConfirmed(confirmed: boolean) {
      const session = currentSession();
      if (
        phase === 'review' &&
        session?.active &&
        !session.saving &&
        !session.selecting &&
        !session.abort
      )
        setReview((current) => ({ ...current, confirmed }));
    },
    setKeepPhoto(value: boolean) {
      const session = currentSession();
      if (
        phase === 'review' &&
        session?.active &&
        !session.saving &&
        !session.selecting &&
        !session.abort
      ) {
        setKeepPhoto(value);
        setReview((current) => ({ ...current, confirmed: false }));
      }
    },
    close() {
      const session = currentSession();
      if (!session?.active || session.saving) return false;
      session.active = false;
      session.revision++;
      void releaseSession(session);
      return true;
    },
  };
}
export type ReceiptCaptureDraft = ReturnType<typeof useReceiptCapture>;

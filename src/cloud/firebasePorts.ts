import {
  initializeFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  orderBy,
  limit,
  setDoc,
  runTransaction,
  type Firestore,
} from 'firebase/firestore';
import {
  getStorage,
  connectStorageEmulator,
  ref,
  getMetadata,
  getBytes,
  deleteObject,
  type FirebaseStorage,
} from 'firebase/storage';
import { createStorageUploader } from './storageUpload';
import { decodeRecord, validateOperation } from './everydayFormat';
import type { LocalFirebaseAuthAdapter } from '../accounts/firebaseAdapter';
const bindings = new WeakMap<object, { db: Firestore; files: FirebaseStorage }>();
export function createFirebasePorts(
  getContext: LocalFirebaseAuthAdapter['getSdkContext'],
  owner: { projectId: string; uid: string },
  fetchImpl?: typeof fetch,
) {
  const context = () => {
    const value = getContext();
    if (value.uid !== owner.uid || value.configuration.firebase.projectId !== owner.projectId)
      throw new Error('The cloud account changed. Reopen Cloud Backup.');
    return value;
  };
  const services = () => {
    const value = context();
    let binding = bindings.get(value.app);
    if (!binding) {
      const db = initializeFirestore(value.app, { experimentalForceLongPolling: true });
      const files = getStorage(value.app, `gs://${value.configuration.firebase.storageBucket}`);
      if (value.configuration.emulators) {
        connectFirestoreEmulator(db, '127.0.0.1', value.configuration.emulators.firestore);
        connectStorageEmulator(files, '127.0.0.1', value.configuration.emulators.storage);
      }
      binding = { db, files };
      bindings.set(value.app, binding);
    }
    return binding;
  };
  const record = (id: string) => doc(services().db, 'users', owner.uid, 'walletBackups', id);
  const checkedPath = (path: string) => {
    const backup = path.startsWith(`users/${owner.uid}/walletBackups/`) && !path.includes('..');
    const prefix = `users/${owner.uid}/walletFiles/`;
    const wallet =
      path.startsWith(prefix) &&
      /^(main|test-[a-f0-9]{64})\/[a-f0-9]{64}$/.test(path.slice(prefix.length));
    if (!backup && !wallet) throw new Error('Cloud object ownership is invalid.');
    return ref(services().files, path);
  };
  const walletId = (value: string) => {
    if (!/^(main|test-[a-f0-9]{64})$/.test(value)) throw new Error('Invalid cloud wallet scope.');
    return value;
  };
  const walletDoc = (id: string) => doc(services().db, 'users', owner.uid, 'wallets', walletId(id));
  const operationDoc = (id: string, operationId: string) => {
    if (!/^wallet-[a-z0-9-]{16,96}$/.test(operationId))
      throw new Error('Invalid cloud save operation.');
    return doc(
      services().db,
      'users',
      owner.uid,
      'wallets',
      walletId(id),
      'operations',
      operationId,
    );
  };
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('The server request is unconfirmed. Reconcile before retrying.')),
            20000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const api = {
    async readWallet(id: string) {
      const result = await bounded(getDocFromServer(walletDoc(id)));
      context();
      return result.exists() ? result.data() : null;
    },
    async readOperation(id: string, operationId: string) {
      const result = await bounded(getDocFromServer(operationDoc(id, operationId)));
      context();
      return result.exists() ? result.data() : null;
    },
    async commitWallet(
      id: string,
      plan: { baseRevision: number; baseHash: string | null; record: Record<string, any> },
    ) {
      const candidate = decodeRecord(plan.record, owner).record;
      return bounded(
        runTransaction(
          services().db,
          async (transaction) => {
            context();
            const receiptRef = operationDoc(id, candidate.operationId);
            const receipt = await transaction.get(receiptRef);
            context();
            const target = walletDoc(id);
            const existing = await transaction.get(target);
            context();
            const current = existing.exists() ? decodeRecord(existing.data(), owner).record : null;
            if (receipt.exists()) {
              const known = validateOperation(receipt.data(), owner, candidate.operationId);
              if (
                known.payloadHash !== candidate.payloadHash ||
                known.revision !== candidate.revision ||
                !current ||
                current.revision < known.revision
              )
                throw new Error('The cloud operation receipt does not match this save.');
              return current;
            }
            if (
              (current?.revision ?? 0) !== plan.baseRevision ||
              (current?.payloadHash ?? null) !== plan.baseHash ||
              candidate.revision !== plan.baseRevision + 1
            )
              throw new Error('Another device changed this cloud wallet.');
            context();
            transaction.set(target, candidate);
            transaction.set(receiptRef, {
              version: 1,
              ownerUid: owner.uid,
              operationId: candidate.operationId,
              revision: candidate.revision,
              payloadHash: candidate.payloadHash,
            });
            return candidate;
          },
          { maxAttempts: 3 },
        ),
      );
    },
    async headPhoto(id: string, hash: string) {
      return bounded(api.head(`users/${owner.uid}/walletFiles/${walletId(id)}/${hash}`));
    },
    async putPhoto(id: string, hash: string, bytes: Uint8Array, contentType: string) {
      return api.put(`users/${owner.uid}/walletFiles/${walletId(id)}/${hash}`, bytes, {
        contentType,
        sha256: hash,
      });
    },
    async getPhoto(id: string, hash: string, maxBytes: number) {
      return bounded(api.get(`users/${owner.uid}/walletFiles/${walletId(id)}/${hash}`, maxBytes));
    },
    async getIndex(id: string) {
      const result = await getDocFromServer(record(id));
      context();
      return result.exists() ? result.data() : null;
    },
    async listIndices(count: number) {
      const result = await getDocsFromServer(
        query(
          collection(services().db, 'users', owner.uid, 'walletBackups'),
          orderBy('createdAtMs', 'desc'),
          limit(count),
        ),
      );
      context();
      return result.docs.map((item) => item.data());
    },
    async createIndex(id: string, value: Record<string, unknown>) {
      await setDoc(record(id), value);
      context();
    },
    async head(path: string) {
      try {
        const value = await getMetadata(checkedPath(path));
        context();
        return {
          size: value.size,
          contentType: value.contentType,
          sha256: value.customMetadata?.sha256,
        };
      } catch (error) {
        if ((error as { code?: string })?.code === 'storage/object-not-found') return null;
        throw new Error(
          'Cloud storage metadata could not be read. Check the connection and access rules.',
        );
      }
    },
    async put(
      path: string,
      bytes: Uint8Array,
      metadata: { contentType: string; sha256: string },
      signal?: AbortSignal,
    ) {
      checkedPath(path);
      const value = context();
      const upload = createStorageUploader({
        configuration: value.configuration,
        owner,
        fetchImpl: fetchImpl ?? (require('expo/fetch') as typeof import('expo/fetch')).fetch,
        assertCurrent: context,
        async getToken() {
          const current = context();
          const user = current.auth.currentUser;
          if (!user || user.uid !== owner.uid) throw new Error('Cloud account is unavailable.');
          const token = await user.getIdToken();
          context();
          return token;
        },
      });
      await upload(path, bytes, metadata, signal);
      context();
    },
    async get(path: string, maxBytes: number) {
      const bytes = await getBytes(checkedPath(path), maxBytes);
      context();
      return new Uint8Array(bytes);
    },
    async remove(path: string) {
      await deleteObject(checkedPath(path));
      context();
    },
  };
  return api;
}

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
    if (!path.startsWith(`users/${owner.uid}/walletBackups/`) || path.includes('..'))
      throw new Error('Cloud object ownership is invalid.');
    return ref(services().files, path);
  };
  return {
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
}

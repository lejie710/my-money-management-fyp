import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { createPhotoFileAdapter } from '../attachments/photoFiles';
import {
  createPhotoManager,
  photoFamilyToken,
  type PhotoDraft,
  type PhotoCleanupResult,
} from '../attachments/photoManager';
import { inspectImageHeader } from '../attachments/imageHeader';
import { validatePhotoRef } from '../core/transactionContext';
import type { PhotoRef } from '../core/transactionContext';
import type { DataFamily } from '../accounts/identity';
import type { LedgerStorage } from '../ui/ledgerRuntime';
import { sha256Hex } from './hash';
export function createBackupFileServices() {
  const pendingDirectories = new Map<Directory, string>();
  return {
    async read(family: DataFamily, photo: PhotoRef): Promise<Uint8Array> {
      validatePhotoRef(photo);
      const files = createPhotoFileAdapter(encodeURIComponent(photoFamilyToken(family)));
      const inspection = await files.inspectOwned(photo);
      if (
        !inspection ||
        ['mimeType', 'width', 'height', 'byteSize'].some(
          (key) =>
            (inspection as unknown as Record<string, unknown>)[key] !==
            (photo as unknown as Record<string, unknown>)[key],
        )
      )
        throw new Error('A saved photo is missing or changed.');
      const bytes = await new File(files.uriFor(photo)).bytes();
      const actual = inspectImageHeader(bytes);
      if (actual.byteSize !== photo.byteSize)
        throw new Error('The photo changed during backup preparation.');
      return bytes;
    },
    async retryCleanup(family: DataFamily, ledgerStorage: LedgerStorage) {
      const manager = createPhotoManager({
        family,
        files: createPhotoFileAdapter(encodeURIComponent(photoFamilyToken(family))),
        journal: AsyncStorage,
        ledgerStorage,
        now: Date.now,
        newId: (kind) =>
          `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
      });
      let result;
      try {
        result = await manager.initialize();
        if (!result.pending) result = await manager.retryCleanup();
      } finally {
        manager.dispose();
      }
      for (const [directory, token] of [...pendingDirectories]) {
        if (token !== photoFamilyToken(family)) continue;
        try {
          // exists can return false on denied access; info must confirm absence.
          if (directory.info().exists) directory.delete();
          if (directory.info().exists)
            throw new Error('Temporary directory cleanup is unconfirmed.');
          pendingDirectories.delete(directory);
        } catch {}
      }
      return [...pendingDirectories.values()].some((token) => token === photoFamilyToken(family))
        ? { ...result, pending: true, message: 'Temporary photo cleanup is still pending.' }
        : result;
    },
    async stage(
      family: DataFamily,
      ledgerStorage: LedgerStorage,
      incarnationId: string,
      items: Array<{ sha256: string; mimeType: string; byteSize: number }>,
      read: (photo: { sha256: string; mimeType: string; byteSize: number }) => Promise<Uint8Array>,
      current: () => void,
    ) {
      const files = createPhotoFileAdapter(encodeURIComponent(photoFamilyToken(family)));
      const manager = createPhotoManager({
        family,
        files,
        journal: AsyncStorage,
        ledgerStorage,
        now: Date.now,
        newId: (kind) =>
          `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
      });
      let draft: PhotoDraft | null = null,
        temporary: Directory | null = null,
        temporaryOwned = false,
        closed: Promise<PhotoCleanupResult> | null = null;
      const refs: Record<string, PhotoRef> = {};
      const close = (): Promise<PhotoCleanupResult> => {
        if (closed) return closed;
        closed = (async () => {
          let result: PhotoCleanupResult = { pending: false, deleted: 0, retained: 0, message: '' };
          try {
            if (draft) result = await manager.closeDraft(draft);
          } catch {
            result = {
              pending: true,
              deleted: 0,
              retained: items.length,
              message: 'Owned photo cleanup remains unconfirmed.',
            };
          } finally {
            manager.dispose();
          }
          if (temporary && temporaryOwned) {
            try {
              if (temporary.info().exists) temporary.delete();
              if (temporary.info().exists)
                throw new Error('Temporary directory cleanup is unconfirmed.');
              pendingDirectories.delete(temporary);
            } catch {
              pendingDirectories.set(temporary, photoFamilyToken(family));
              result = {
                ...result,
                pending: true,
                message: 'Saved records are retained. Temporary photo cleanup needs another check.',
              };
            }
          }
          return result;
        })();
        return closed;
      };
      try {
        const initialized = await manager.initialize();
        if (initialized.pending)
          throw Object.assign(
            new Error('Photo storage needs recovery before importing a wallet.'),
            { cleanupPending: true },
          );
        current();
        draft = manager.beginDraft(incarnationId);
        temporary = new Directory(
          Paths.cache,
          'cloud-imports',
          `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
        );
        temporary.create({ intermediates: true });
        temporaryOwned = true;
        for (const item of items) {
          current();
          const bytes = await read(item);
          current();
          if (bytes.length !== item.byteSize || sha256Hex(bytes) !== item.sha256)
            throw new Error('The imported photo failed its integrity check.');
          const info = inspectImageHeader(bytes);
          if (info.mimeType !== item.mimeType)
            throw new Error('The imported image type is inconsistent.');
          const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[
            info.mimeType
          ];
          const file = new File(temporary, `${item.sha256}.${extension}`);
          file.write(bytes);
          try {
            refs[item.sha256] = await manager.stage(draft, { uri: file.uri });
          } finally {
            if (file.info().exists) file.delete();
            if (file.info().exists) throw new Error('Temporary photo cleanup is unconfirmed.');
          }
          current();
        }
        return { refs, close };
      } catch (error) {
        const cleanup = await close();
        const pending =
          cleanup.pending || !!(error as { cleanupPending?: boolean })?.cleanupPending;
        throw Object.assign(
          new Error('Photo preparation failed. Your financial records were not changed.'),
          {
            cleanupPending: pending,
            cleanupMessage: pending
              ? cleanup.message || 'Photo ownership needs another check before importing.'
              : '',
            cause: undefined,
          },
        );
      }
    },
  };
}

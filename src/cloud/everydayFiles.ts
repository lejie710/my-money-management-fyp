import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { createPhotoFileAdapter } from '../attachments/photoFiles';
import { createPhotoManager, photoFamilyToken } from '../attachments/photoManager';
import { inspectImageHeader } from '../attachments/imageHeader';
import { createBackupFileServices } from './nativeFiles';
import { sha256Hex } from './hash';
import type { EverydayFiles } from './everydayStore';

export function createEverydayPhotoServices(): EverydayFiles {
  const source = createBackupFileServices();
  return {
    read: source.read,
    async hydrate(family, ledgerStorage, photos, read, current) {
      const files = createPhotoFileAdapter(encodeURIComponent(photoFamilyToken(family)));
      const manager = createPhotoManager({
        family,
        files,
        journal: AsyncStorage,
        ledgerStorage,
        now: Date.now,
        newId: (kind) =>
          kind + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
      });
      try {
        for (const item of photos) {
          current();
          const present = await files.inspectOwned(item.photo);
          current();
          if (present) {
            const bytes = await new File(files.uriFor(item.photo)).bytes();
            if (bytes.length !== item.photo.byteSize || sha256Hex(bytes) !== item.sha256)
              throw new Error('An owned cloud photo has changed. It was retained for review.');
            await manager.importRetained(item.photo, { uri: files.uriFor(item.photo) });
            current();
            continue;
          }
          const bytes = await read(item);
          current();
          const header = inspectImageHeader(bytes);
          if (
            bytes.length !== item.photo.byteSize ||
            sha256Hex(bytes) !== item.sha256 ||
            ['mimeType', 'width', 'height', 'byteSize'].some(
              (key) =>
                header[key as keyof typeof header] !== item.photo[key as keyof typeof item.photo],
            )
          )
            throw new Error('The downloaded cloud photo failed its integrity check.');
          const directory = new Directory(
            Paths.cache,
            'cloud-wallet-photos',
            Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
          );
          directory.create({ intermediates: true });
          try {
            const temporary = new File(directory, item.photo.fileName);
            temporary.write(bytes);
            await manager.importRetained(item.photo, { uri: temporary.uri });
            current();
            const copied = await new File(files.uriFor(item.photo)).bytes();
            if (copied.length !== bytes.length || sha256Hex(copied) !== item.sha256)
              throw new Error('The owned cloud photo copy failed its integrity check.');
          } finally {
            if (directory.info().exists) directory.delete();
            if (directory.info().exists)
              throw new Error('Temporary cloud photo cleanup remains pending.');
          }
        }
      } finally {
        manager.dispose();
        await manager.drain();
      }
    },
  };
}

import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'react-native';
import { inspectImageHeader } from './imageHeader';
import { validatePhotoRef, MAX_PHOTO_BYTES } from '../core/transactionContext';
import type { PhotoRef } from '../core/transactionContext';
import type { PhotoFileAdapter, PhotoInspection } from './photoManager';

function localUri(uri: string) {
  if (typeof uri !== 'string' || !/^(?:file|content):\/\//.test(uri)) {
    throw new Error('Select a local photo from the library. Remote images are not downloaded.');
  }
}

function dimensions(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            'The photo could not be decoded in time. Select it again or choose another image.',
          ),
        ),
      15000,
    );
    Image.getSize(
      uri,
      (width, height) => {
        clearTimeout(timer);
        resolve({ width, height });
      },
      () => {
        clearTimeout(timer);
        reject(new Error('This image could not be decoded. Choose a JPEG, PNG, or WebP photo.'));
      },
    );
  });
}

async function inspectFile(file: File): Promise<PhotoInspection> {
  const size = file.info().size;
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_PHOTO_BYTES
  ) {
    throw new Error('The selected photo is empty, unavailable, or larger than 10 MiB.');
  }
  const bytes = await file.bytes();
  const header = inspectImageHeader(bytes);
  if (bytes.byteLength !== size)
    throw new Error('The photo changed while it was being read. Select it again.');
  const decoded = await dimensions(file.uri);
  const same = decoded.width === header.width && decoded.height === header.height;
  const orientedJpeg =
    header.mimeType === 'image/jpeg' &&
    decoded.width === header.height &&
    decoded.height === header.width;
  if (!same && !orientedJpeg)
    throw new Error('The photo dimensions could not be confirmed. Choose another image.');
  // Keep container dimensions stable across the source and owned copy; Image renders JPEG orientation.
  return header;
}

export function createPhotoFileAdapter(encodedFamily: string): PhotoFileAdapter {
  if (
    !encodedFamily ||
    encodedFamily === '.' ||
    encodedFamily === '..' ||
    /[\\/]/.test(encodedFamily)
  ) {
    throw new Error('The photo storage family is invalid.');
  }
  if (!/^[A-Za-z0-9_.!~*'()%-]+$/.test(encodedFamily)) {
    throw new Error('The photo storage family must be encoded before opening attachments.');
  }
  // Encoded family/owner tokens can exceed Android's per-component byte limit.
  // Fixed ASCII chunks and terminators preserve identity without prefix collisions.
  const chunks = (value: string, prefix: string) => {
    const parts: string[] = [];
    for (let offset = 0; offset < value.length; offset += 96) {
      parts.push(`${prefix}-${value.slice(offset, offset + 96)}`);
    }
    return parts;
  };
  const familyParts = chunks(encodedFamily, 'f');
  const directory = (photo: PhotoRef) => {
    validatePhotoRef(photo);
    return new Directory(
      Paths.document,
      'transaction-photos',
      ...familyParts,
      'family-end',
      ...chunks(encodeURIComponent(photo.ownerIncarnationId), 'o'),
      'files',
    );
  };
  const owned = (photo: PhotoRef) => new File(directory(photo), photo.fileName);
  return {
    async inspectSource(uri) {
      localUri(uri);
      return inspectFile(new File(uri));
    },
    async copyIntoOwned(uri, photo) {
      localUri(uri);
      const target = owned(photo);
      if (target.info().exists)
        throw new Error('The generated attachment target already exists. Choose the photo again.');
      directory(photo).create({ idempotent: true, intermediates: true });
      await new File(uri).copy(target, { overwrite: false });
    },
    async inspectOwned(photo) {
      const file = owned(photo);
      // File.exists also returns false for denied read access. info() validates
      // access and throws, so cleanup never confuses an uncertain read with absence.
      if (!file.info().exists) return null;
      return inspectFile(file);
    },
    uriFor(photo) {
      return owned(photo).uri;
    },
    async removeOwned(photo) {
      const file = owned(photo);
      if (file.info().exists) file.delete();
      if (file.info().exists) throw new Error('The unused attachment could not be removed yet.');
    },
  };
}

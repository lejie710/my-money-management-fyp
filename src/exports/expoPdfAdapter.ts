import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { ReminderOwner } from '../reminders/coordinator';
import type { PhotoManager } from '../attachments/photoManager';
import { photoFamilyToken } from '../attachments/photoManager';
import { MAX_PHOTO_BYTES, validatePhotoRef } from '../core/transactionContext';
import {
  buildReportHtml,
  buildTransactionHtml,
  type ExportImage,
  type TransactionExportSnapshot,
} from '../core/exports';
import {
  createPdfController,
  MAX_PDF_BYTES,
  MIN_PDF_BYTES,
  PdfExportError,
  type PdfAdapter,
  type PdfController,
} from './pdfController';
import {
  readPdfEnvelope,
  isPdfXrefStart,
  PDF_TAIL_SCAN_BYTES,
  PDF_XREF_SCAN_BYTES,
  photoDataUrl,
  validateCacheUri,
  validatePdfFileName,
} from './pdfBytes';

// Type-only references retain the installed public contracts without eager native loading.
type PrintApi = typeof import('expo-print');
type SharingApi = typeof import('expo-sharing');
function printApi(): PrintApi {
  try {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') throw Error();
    const native = requireOptionalNativeModule<{ ReliablePdfVersion?: number }>('ExpoPrint');
    if (!native || (Platform.OS === 'android' && native.ReliablePdfVersion !== 1)) throw Error();
    const api = require('expo-print') as PrintApi;
    if (typeof api.printToFileAsync !== 'function' || typeof api.printAsync !== 'function')
      throw Error();
    return api;
  } catch {
    throw new PdfExportError(
      'PRINT_UNAVAILABLE',
      'PDF creation is unavailable in this build. Open the updated installed app.',
    );
  }
}
function sharingApi(): SharingApi | null {
  try {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return null;
    if (!requireOptionalNativeModule('ExpoSharing')) return null;
    const api = require('expo-sharing') as SharingApi;
    return typeof api.shareAsync === 'function' && typeof api.isAvailableAsync === 'function'
      ? api
      : null;
  } catch {
    return null;
  }
}

export function createExpoPdfAdapter(): PdfAdapter {
  const root = new Directory(Paths.cache, 'pdf-exports');
  const target = (name: string) => new File(root, validatePdfFileName(name));
  return {
    async printHtml(html) {
      // Android's native fields are integers; these are rounded A4 dimensions at 72 PPI.
      return printApi().printToFileAsync({ html, base64: false, width: 595, height: 842 });
    },
    async inspectPdf(uri) {
      validateCacheUri(uri, Paths.cache.uri);
      const file = new File(uri),
        info = file.info();
      if (!info.exists) return null;
      if (
        !Number.isSafeInteger(info.size) ||
        !info.size ||
        info.size < MIN_PDF_BYTES ||
        info.size > MAX_PDF_BYTES
      )
        return { byteSize: info.size ?? 0, pdfHeaderValid: false };
      const handle = file.open(FileMode.ReadOnly);
      try {
        const header = await handle.readBytes(16);
        handle.offset = Math.max(0, info.size - PDF_TAIL_SCAN_BYTES);
        const tail = await handle.readBytes(Math.min(info.size, PDF_TAIL_SCAN_BYTES));
        const envelope = readPdfEnvelope(header, tail, info.size);
        if (!envelope) return { byteSize: info.size, pdfHeaderValid: false };
        handle.offset = envelope.xrefOffset;
        const xref = await handle.readBytes(
          Math.min(PDF_XREF_SCAN_BYTES, info.size - envelope.xrefOffset),
        );
        return {
          byteSize: info.size,
          pdfHeaderValid: handle.size === info.size && isPdfXrefStart(xref),
        };
      } finally {
        handle.close();
      }
    },
    uriFor(name) {
      return target(name).uri;
    },
    async retainOwnedPdf(uri, fileName) {
      validateCacheUri(uri, Paths.cache.uri, root.uri);
      const destination = target(fileName);
      if (destination.info().exists)
        throw new PdfExportError('TARGET_EXISTS', 'This PDF filename already exists. Try again.');
      root.create({ intermediates: true, idempotent: true });
      // Move the exact Print-returned cache file; successful exports do not leave a duplicate Print copy.
      await new File(uri).move(destination, { overwrite: false });
    },
    async removeOwned(name) {
      const file = target(name);
      if (file.info().exists) file.delete();
      if (file.info().exists)
        throw new PdfExportError('DELETE_UNCERTAIN', 'The old PDF could not be removed yet.');
    },
    async cacheUsage() {
      if (!root.info().exists) return { count: 0, byteSize: 0 };
      const items = root.list();
      let byteSize = 0;
      for (const item of items) {
        const info = item.info();
        if (
          !Number.isSafeInteger(info.size) ||
          info.size === undefined ||
          info.size === null ||
          info.size < 0
        )
          throw new PdfExportError('CACHE_UNAVAILABLE', 'PDF cache space could not be checked.');
        byteSize += info.size;
        if (!Number.isSafeInteger(byteSize))
          throw new PdfExportError('CACHE_UNAVAILABLE', 'PDF cache space could not be checked.');
      }
      return { count: items.length, byteSize };
    },
    async sharingAvailable() {
      const api = sharingApi();
      return api ? api.isAvailableAsync() : false;
    },
    async sharePdf(uri) {
      validateCacheUri(uri, root.uri);
      const api = sharingApi();
      if (!api)
        throw new PdfExportError(
          'SHARE_UNAVAILABLE',
          'Sharing is unavailable in this build. Your PDF is still ready.',
        );
      await api.shareAsync(uri, {
        mimeType: 'application/pdf',
        UTI: 'com.adobe.pdf',
        dialogTitle: 'Share PDF',
      });
    },
    async previewPdf(uri) {
      validateCacheUri(uri, root.uri);
      await printApi().printAsync({ uri });
    },
  };
}

type PhotoAccess = Pick<PhotoManager, 'familyToken' | 'inspect' | 'uriFor'>;
export function createPdfImagePreparer(owner: ReminderOwner, photos: PhotoAccess) {
  const incarnationId = owner.incarnationId;
  if (photos.familyToken !== photoFamilyToken({ scope: owner.scope, actor: owner.actor }))
    throw new PdfExportError('IMAGE_OWNER', 'Photo access belongs to another storage scope.');
  return async (
    snapshot: TransactionExportSnapshot,
  ): Promise<{ image: ExportImage; warning?: string }> => {
    const photo = snapshot.attachment;
    if (!photo || !snapshot.selection.photo)
      throw new PdfExportError(
        'IMAGE_SELECTION',
        'A selected photo is required for image preparation.',
      );
    validatePhotoRef(photo, incarnationId);
    const unavailable = (reason: 'missing' | 'unreadable') => ({
      image: { status: 'unavailable' as const, reason },
      warning: 'The selected photo is unavailable. The PDF will include an omission note.',
    });
    let file: File;
    try {
      file = new File(photos.uriFor(photo));
    } catch {
      return unavailable('unreadable');
    }
    let info;
    try {
      info = file.info();
    } catch {
      return unavailable('unreadable');
    }
    if (!info.exists) return unavailable('missing');
    if (
      !Number.isSafeInteger(info.size) ||
      !info.size ||
      info.size < 1 ||
      info.size > MAX_PHOTO_BYTES
    )
      throw new PdfExportError(
        'IMAGE_INVALID',
        'The selected photo is empty or exceeds 10 MiB. Deselect it or choose another.',
      );
    let bytes;
    try {
      bytes = await file.bytes();
    } catch {
      return unavailable('unreadable');
    }
    const dataUrl = photoDataUrl(bytes, photo); // Revalidates the actual bytes and stored metadata.
    let decoded;
    try {
      decoded = await photos.inspect(photo);
    } catch {
      return unavailable('unreadable');
    }
    if (!decoded) return unavailable('missing');
    if (
      ['mimeType', 'width', 'height', 'byteSize'].some(
        (key) => decoded[key as keyof typeof decoded] !== photo[key as keyof typeof photo],
      )
    )
      throw new PdfExportError(
        'IMAGE_CHANGED',
        'The selected photo changed. Deselect it or choose it again.',
      );
    return {
      image: {
        status: 'ready',
        dataUrl,
        mimeType: photo.mimeType,
        width: photo.width,
        height: photo.height,
        byteSize: photo.byteSize,
      },
    };
  };
}

export function createExpoPdfServices(options: {
  owner: ReminderOwner;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
  };
  photos: PhotoAccess;
  isCurrent(): boolean;
  now(): number;
  newId(): string;
}): PdfController {
  return createPdfController({
    ...options,
    adapter: createExpoPdfAdapter(),
    prepareImage: createPdfImagePreparer(options.owner, options.photos),
    buildHtml: (snapshot, image) =>
      snapshot.kind === 'report'
        ? buildReportHtml(snapshot)
        : buildTransactionHtml(snapshot, image),
  });
}

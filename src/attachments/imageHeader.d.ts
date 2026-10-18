export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export type ImageHeader = Readonly<{
  mimeType: ImageMime;
  width: number;
  height: number;
  byteSize: number;
}>;
export type ImageHeaderErrorCode =
  'INVALID_INPUT' | 'UNSUPPORTED_FORMAT' | 'INVALID_IMAGE' | 'SIZE_LIMIT' | 'DIMENSION_LIMIT';
export class ImageHeaderError extends Error {
  constructor(code: ImageHeaderErrorCode, message: string);
  readonly code: ImageHeaderErrorCode;
}
export const MAX_PHOTO_BYTES: 10485760;
export const MAX_PHOTO_DIMENSION: 16384;
export const MAX_PHOTO_PIXELS: 40000000;
/** Static-image pre-decode header/container checks only. Native decode and copied-file checks remain required. */
export function inspectImageHeader(bytes: Uint8Array): ImageHeader;

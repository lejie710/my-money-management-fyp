import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { Image, Platform } from "react-native";
import type { ReminderOwner } from "../reminders/coordinator";
import {
  inspectImageHeader,
  MAX_PHOTO_BYTES,
} from "../attachments/imageHeader";
import {
  createReceiptCaptureManager,
  receiptCaptureFamilyToken,
  ReceiptCaptureError,
  type ReceiptCaptureBytes,
  type ReceiptCaptureFiles,
  type ReceiptCaptureManager,
} from "./captureManager";

function localSource(uri: string) {
  if (
    typeof uri !== "string" ||
    !/^(?:file|content):\/\//.test(uri) ||
    /[\u0000-\u001f\u007f]/.test(uri)
  )
    throw new Error(
      "Select a local receipt image. Remote images are not downloaded.",
    );
}
function fileName(value: string) {
  if (!/^receipt-[a-z0-9][a-z0-9-]{0,70}\.image$/.test(value))
    throw new Error("The temporary receipt filename is invalid.");
  return value;
}
const chunks = (value: string) => {
  const parts: string[] = [];
  for (let offset = 0; offset < value.length; offset += 96)
    parts.push(`f-${value.slice(offset, offset + 96)}`);
  return parts;
};
function dimensions(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("Receipt image decoding timed out. Choose it again.")),
      15000,
    );
    try {
      Image.getSize(
        uri,
        (width, height) => {
          clearTimeout(timer);
          resolve({ width, height });
        },
        () => {
          clearTimeout(timer);
          reject(
            new Error(
              "The receipt image could not be decoded. Choose a JPEG, PNG or WebP image.",
            ),
          );
        },
      );
    } catch {
      clearTimeout(timer);
      reject(new Error("The receipt image could not be decoded."));
    }
  });
}
async function readImage(file: File): Promise<ReceiptCaptureBytes> {
  const info = file.info();
  if (
    !info.exists ||
    !Number.isSafeInteger(info.size) ||
    !info.size ||
    info.size < 1 ||
    info.size > MAX_PHOTO_BYTES
  )
    throw new Error(
      "The receipt image is unavailable, empty, or larger than 10 MiB.",
    );
  const handle = file.open(FileMode.ReadOnly);
  let bytes: Uint8Array;
  try {
    if (handle.size !== info.size)
      throw new Error("The receipt image changed. Choose it again.");
    // A source changing size cannot make this read allocate an unbounded image.
    bytes = await handle.readBytes(info.size);
    if (bytes.byteLength !== info.size || handle.size !== info.size)
      throw new Error(
        "The receipt image changed while being read. Choose it again.",
      );
  } finally {
    handle.close();
  }
  const inspection = inspectImageHeader(bytes);
  const decoded = await dimensions(file.uri);
  const same =
    decoded.width === inspection.width && decoded.height === inspection.height;
  const orientedJpeg =
    inspection.mimeType === "image/jpeg" &&
    decoded.width === inspection.height &&
    decoded.height === inspection.width;
  if (!same && !orientedJpeg)
    throw new Error("The receipt image dimensions could not be confirmed.");
  return { bytes, inspection };
}

export function createExpoReceiptFiles(
  owner: ReminderOwner,
): ReceiptCaptureFiles {
  const family = encodeURIComponent(receiptCaptureFamilyToken(owner));
  const root = new Directory(
    Paths.cache,
    "receipt-captures",
    ...chunks(family),
    "family-end",
    "files",
  );
  const target = (name: string) => new File(root, fileName(name));
  return {
    async readSource(uri) {
      localSource(uri);
      return readImage(new File(uri));
    },
    async writeOwned(name, bytes) {
      inspectImageHeader(bytes);
      const destination = target(name);
      if (destination.info().exists)
        throw new ReceiptCaptureError(
          "TARGET_EXISTS",
          "This temporary receipt target already exists.",
        );
      root.create({ intermediates: true, idempotent: true });
      try {
        destination.create({ overwrite: false });
      } catch {
        // An exclusive-create failure does not establish whether this target was
        // ours, including a competing file that appeared after the preflight.
        throw new ReceiptCaptureError(
          "CREATE_UNCONFIRMED",
          "Temporary receipt creation could not be confirmed. The target was retained; choose the image again.",
        );
      }
      // Write the one bounded byte snapshot already read from the provider. Do not
      // reopen/copy a mutable provider URI or leave an unbounded native copy running.
      try {
        await destination.write(bytes);
      } catch {
        throw new ReceiptCaptureError(
          "OWNED_WRITE_FAILED",
          "The owned temporary receipt write did not finish. Retry cleanup before selecting again.",
        );
      }
    },
    readOwned: (name) => readImage(target(name)),
    async statOwned(name) {
      const info = target(name).info();
      if (!info.exists) return null;
      if (
        !Number.isSafeInteger(info.size) ||
        info.size === undefined ||
        info.size === null
      )
        throw new Error("The temporary receipt file size could not be read.");
      return { byteSize: info.size };
    },
    async removeOwned(name) {
      const file = target(name);
      if (file.info().exists) file.delete();
      if (file.info().exists)
        throw new Error("Temporary receipt deletion could not be confirmed.");
    },
    uriFor: (name) => target(name).uri,
  };
}

function createPicker() {
  const cameraAvailable = Platform.OS === "android" || Platform.OS === "ios";
  return {
    cameraAvailable,
    async pick(kind: "library" | "camera"): Promise<{ uri: string } | null> {
      if (!cameraAvailable)
        throw new ReceiptCaptureError(
          "CAPTURE_UNAVAILABLE",
          "Native receipt capture is unavailable.",
        );
      if (Platform.OS === "android") {
        const interrupted = await ImagePicker.getPendingResultAsync();
        if (interrupted && !("canceled" in interrupted && interrupted.canceled))
          throw new ReceiptCaptureError(
            "PICKER_INTERRUPTED",
            "An earlier image selection was interrupted. Choose the receipt again for this session.",
          );
      }
      if (kind === "camera") {
        let permission = await ImagePicker.getCameraPermissionsAsync();
        if (!permission.granted && permission.canAskAgain)
          permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted)
          throw new ReceiptCaptureError(
            "CAMERA_PERMISSION",
            "Camera permission is unavailable. Choose a receipt image or enter the transaction manually.",
          );
      }
      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        allowsEditing: false,
        exif: false,
        base64: false,
        quality: 1,
      };
      // The emulator's camera source is configured externally as its virtual scene.
      // This code has no host-webcam or camera-roll-save API.
      const result =
        kind === "camera"
          ? await ImagePicker.launchCameraAsync(options)
          : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled) return null;
      const asset = result.assets?.[0];
      if (!asset || result.assets.length !== 1)
        throw new ReceiptCaptureError(
          "IMAGE_SELECTION",
          "Select one supported receipt image.",
        );
      localSource(asset.uri);
      return { uri: asset.uri };
    },
  };
}
export function createExpoReceiptCapture(options: {
  owner: ReminderOwner;
  sessionKey: string;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
  };
  newId(): string;
  isCurrent(): boolean;
}): ReceiptCaptureManager {
  return createReceiptCaptureManager({
    ...options,
    files: createExpoReceiptFiles(options.owner),
    picker: createPicker(),
  });
}

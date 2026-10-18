import { File, FileMode, Paths } from "expo-file-system";
import {
  CompanionConnectionError,
  MAX_COMPANION_CONNECTION_BYTES,
  parseCompanionConnection,
  type CompanionConnection,
} from "./connection";

/** Only the app-private pairing file. Calling this performs no HTTP or provider work. */
export async function readPrivateCompanionConnection(): Promise<CompanionConnection | null> {
  try {
    const file = new File(Paths.document, "companion-connection.json");
    const before = file.info();
    if (!before.exists) return null;
    const size = before.size;
    if (
      !Number.isSafeInteger(size) ||
      !size ||
      size < 1 ||
      size > MAX_COMPANION_CONNECTION_BYTES
    )
      throw new CompanionConnectionError();
    const handle = file.open(FileMode.ReadOnly);
    let bytes: Uint8Array;
    try {
      if (handle.offset !== 0 || handle.size !== size)
        throw new CompanionConnectionError("CONNECTION_UNAVAILABLE");
      bytes = await handle.readBytes(size);
      if (
        bytes.byteLength !== size ||
        handle.offset !== size ||
        handle.size !== size
      )
        throw new CompanionConnectionError("CONNECTION_UNAVAILABLE");
      const after = file.info();
      if (!after.exists || after.size !== size)
        throw new CompanionConnectionError("CONNECTION_UNAVAILABLE");
    } finally {
      handle.close();
    }
    return parseCompanionConnection(bytes);
  } catch (error) {
    // File errors may contain app paths or raw native diagnostics. Never expose them.
    if (error instanceof CompanionConnectionError) throw error;
    throw new CompanionConnectionError("CONNECTION_UNAVAILABLE");
  }
}

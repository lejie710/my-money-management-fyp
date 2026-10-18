// Application-side transport. Staged imports become ../attachments/imageHeader and ../core/receipt.
const { inspectImageHeader } = require("../attachments/imageHeader");
const { validateOcrResult } = require("../core/receipt");
const LIMIT = 1024 * 1024;
function utf8Length(value) {
  let size = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    size += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return size;
}
const copy = {
  UNAUTHORIZED:
    "The local receipt connection has expired. Reopen the companion connection.",
  BUSY: "Another receipt is being recognized. Wait before trying again.",
  TIMEOUT:
    "Receipt recognition took too long. Try again deliberately or use manual entry.",
  CANCELLED: "Receipt recognition was cancelled.",
  OCR_UNAVAILABLE: "The local Windows OCR service is unavailable.",
  WORKER_UNCONFIRMED:
    "The previous Windows recognition process has not confirmed shutdown. Wait before retrying; temporary files were retained.",
  OCR_FAILED:
    "The image could not be recognized. Try a clearer image or use manual entry.",
  IMAGE_INVALID: "Choose a valid static JPEG, PNG or WebP image.",
  IMAGE_TYPE: "The selected image type is unsupported.",
  IMAGE_DIMENSIONS: "Choose a smaller image for the Windows OCR engine.",
  TOO_LARGE: "Choose a receipt image no larger than 10 MiB.",
  INVALID_RESPONSE: "The local receipt response could not be verified.",
  NETWORK:
    "The local receipt service could not be reached. Your image selection was kept.",
};
class ReceiptClientError extends Error {
  constructor(code) {
    super(copy[code] ?? copy.NETWORK);
    this.name = "ReceiptClientError";
    this.code = code;
  }
}
function createReceiptClient(
  config,
  { fetch: fetcher = globalThis.fetch, timeoutMs = 50000 } = {},
) {
  const matched =
    typeof config?.url === "string"
      ? /^http:\/\/127\.0\.0\.1:(\d+)\/v1\/recognize$/.exec(config.url)
      : null;
  if (
    !matched ||
    Number(matched[1]) < 1 ||
    Number(matched[1]) > 65535 ||
    typeof config.token !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(config.token) ||
    typeof fetcher !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 60000
  )
    throw new ReceiptClientError("OCR_UNAVAILABLE");
  const url = config.url,
    token = config.token;
  return {
    async recognize(bytes, { signal } = {}) {
      let image;
      try {
        image = inspectImageHeader(bytes);
        bytes = new Uint8Array(bytes);
      } catch {
        throw new ReceiptClientError(
          bytes?.byteLength > 10485760 ? "TOO_LARGE" : "IMAGE_INVALID",
        );
      }
      if (signal?.aborted) throw new ReceiptClientError("CANCELLED");
      const abort = new AbortController();
      let timedOut = false;
      const onAbort = () => abort.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeoutMs);
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": image.mimeType,
          },
          body: bytes,
          signal: abort.signal,
          redirect: "error",
          credentials: "omit",
        });
        const length = response.headers.get("content-length");
        if (
          !length ||
          !/^\d+$/.test(length) ||
          Number(length) < 1 ||
          Number(length) > LIMIT
        )
          throw new ReceiptClientError("INVALID_RESPONSE");
        if (
          !/^application\/json(?:;|$)/i.test(
            response.headers.get("content-type") ?? "",
          )
        )
          throw new ReceiptClientError("INVALID_RESPONSE");
        const text = await response.text();
        if (
          text.length > LIMIT ||
          utf8Length(text) > LIMIT ||
          utf8Length(text) !== Number(length)
        )
          throw new ReceiptClientError("INVALID_RESPONSE");
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new ReceiptClientError("INVALID_RESPONSE");
        }
        if (!response.ok) {
          const code = Object.hasOwn(copy, payload?.error?.code)
            ? payload.error.code
            : "OCR_FAILED";
          throw new ReceiptClientError(code);
        }
        if (payload?.version !== 1)
          throw new ReceiptClientError("INVALID_RESPONSE");
        let result;
        try {
          result = validateOcrResult(payload.ocr);
        } catch {
          throw new ReceiptClientError("INVALID_RESPONSE");
        }
        if (result.width !== image.width || result.height !== image.height)
          throw new ReceiptClientError("INVALID_RESPONSE");
        if (abort.signal.aborted)
          throw new ReceiptClientError(timedOut ? "TIMEOUT" : "CANCELLED");
        return result;
      } catch (error) {
        if (abort.signal.aborted)
          throw new ReceiptClientError(timedOut ? "TIMEOUT" : "CANCELLED");
        if (error instanceof ReceiptClientError) throw error;
        throw new ReceiptClientError("NETWORK");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        abort.abort();
      }
    },
  };
}
module.exports = { createReceiptClient, ReceiptClientError };

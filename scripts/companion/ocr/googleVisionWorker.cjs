// Server-side foundation only. No configuration lookup, network call, or file write at import.
const { performance } = require("node:perf_hooks");

const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const LIMITS = Object.freeze({
  imageBytes: 6 * 1024 * 1024,
  requestBytes: 9 * 1024 * 1024,
  responseBytes: 2 * 1024 * 1024,
  responseChunks: 4096,
  normalizedBytes: 1024 * 1024 - 1024,
  words: 3000,
  textLength: 30000,
  timeoutMs: 30000,
});
const messages = Object.freeze({
  CONFIGURATION:
    "Configure the private server-side Vision credential and image validator.",
  IMAGE_INVALID: "Choose a valid static JPEG, PNG or WebP image.",
  TOO_LARGE: "The image exceeds this provider adapter's 6 MiB upload limit.",
  TIMEOUT:
    "Receipt recognition took too long. Review the connection before retrying.",
  CANCELLED: "Receipt recognition was cancelled.",
  PROVIDER_FAILED:
    "The receipt recognition provider could not complete the request.",
  RESPONSE_INVALID:
    "The receipt recognition response could not be safely interpreted.",
  RESPONSE_TOO_LARGE:
    "The receipt recognition response exceeded the supported size.",
});
class VisionReceiptError extends Error {
  constructor(code) {
    super(messages[code] || messages.PROVIDER_FAILED);
    this.name = "VisionReceiptError";
    this.code = Object.hasOwn(messages, code) ? code : "PROVIDER_FAILED";
  }
}
const failure = (code) => new VisionReceiptError(code);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === "function")
      Promise.resolve(response.body.cancel()).catch(() => {});
  } catch {}
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function confidence(value) {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw failure("RESPONSE_INVALID");
  return value;
}
function array(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.words)
    throw failure("RESPONSE_INVALID");
  return value;
}
function languages(property) {
  if (property === undefined) return [];
  if (!object(property)) throw failure("RESPONSE_INVALID");
  const rows = array(property.detectedLanguages);
  if (rows.length > 16) throw failure("RESPONSE_INVALID");
  return rows.map((row) => {
    if (
      !object(row) ||
      typeof row.languageCode !== "string" ||
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(row.languageCode)
    )
      throw failure("RESPONSE_INVALID");
    return {
      languageCode: row.languageCode,
      confidence: confidence(row.confidence),
    };
  });
}
function wordGeometry(box, width, height) {
  if (!object(box)) throw failure("RESPONSE_INVALID");
  const normalized = !own(box, "vertices") && own(box, "normalizedVertices");
  const source = normalized ? box.normalizedVertices : box.vertices;
  if (!Array.isArray(source) || source.length !== 4)
    throw failure("RESPONSE_INVALID");
  const polygon = source.map((vertex) => {
    if (!object(vertex)) throw failure("RESPONSE_INVALID");
    // Google omits x/y when their coordinate is zero.
    const x = own(vertex, "x") ? vertex.x : 0;
    const y = own(vertex, "y") ? vertex.y : 0;
    if (
      ![x, y].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      (normalized && (x > 1 || y > 1)) ||
      (!normalized &&
        (!Number.isInteger(x) ||
          !Number.isInteger(y) ||
          x > width + 1 ||
          y > height + 1))
    )
      throw failure("RESPONSE_INVALID");
    return { x: normalized ? x * width : x, y: normalized ? y * height : y };
  });
  const xs = polygon.map((vertex) => vertex.x),
    ys = polygon.map((vertex) => vertex.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  const bounds = {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
  if (bounds.width <= 0 || bounds.height <= 0)
    throw failure("RESPONSE_INVALID");
  return { bounds, polygon };
}

function normalizeVisionResponse(payload, image, elapsedMs) {
  if (
    !object(image) ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > 16384 ||
    image.height > 16384 ||
    image.width * image.height > 40000000 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > 120000
  )
    throw failure("RESPONSE_INVALID");
  if (
    !object(payload) ||
    own(payload, "error") ||
    !Array.isArray(payload.responses) ||
    payload.responses.length !== 1
  )
    throw failure("RESPONSE_INVALID");
  const annotation = payload.responses[0];
  if (!object(annotation)) throw failure("RESPONSE_INVALID");
  // Do not expose partial provider output alongside an error as a successful receipt.
  if (own(annotation, "error")) throw failure("PROVIDER_FAILED");
  const words = [];
  let detectedLanguages = [],
    pageConfidence = null,
    totalText = 0,
    nodes = 0;
  const full = annotation.fullTextAnnotation;
  if (full !== undefined) {
    if (
      !object(full) ||
      (full.text !== undefined &&
        (typeof full.text !== "string" || full.text.length > 60000))
    )
      throw failure("RESPONSE_INVALID");
    const pages = array(full.pages);
    if (pages.length > 1) throw failure("RESPONSE_INVALID");
    if (pages.length === 1) {
      const page = pages[0];
      if (
        !object(page) ||
        page.width !== image.width ||
        page.height !== image.height
      )
        throw failure("RESPONSE_INVALID");
      detectedLanguages = languages(page.property);
      pageConfidence = confidence(page.confidence);
      for (const block of array(page.blocks)) {
        if (++nodes > 6000 || !object(block)) throw failure("RESPONSE_INVALID");
        for (const paragraph of array(block.paragraphs)) {
          if (++nodes > 6000 || !object(paragraph))
            throw failure("RESPONSE_INVALID");
          for (const word of array(paragraph.words)) {
            if (!object(word) || words.length >= LIMITS.words)
              throw failure("RESPONSE_INVALID");
            const symbols = array(word.symbols);
            if (!symbols.length || symbols.length > 128)
              throw failure("RESPONSE_INVALID");
            const text = symbols
              .map((symbol) => {
                if (
                  !object(symbol) ||
                  typeof symbol.text !== "string" ||
                  !symbol.text ||
                  symbol.text.length > 8
                )
                  throw failure("RESPONSE_INVALID");
                return symbol.text;
              })
              .join("");
            totalText += text.length;
            if (
              !text.trim() ||
              text.length > 128 ||
              /[\u0000-\u001f\u007f]/.test(text) ||
              totalText > LIMITS.textLength
            )
              throw failure("RESPONSE_INVALID");
            words.push({
              text: text.trim(),
              ...wordGeometry(word.boundingBox, image.width, image.height),
              confidence: confidence(word.confidence),
              detectedLanguages: languages(word.property),
            });
          }
        }
      }
    }
    if (!words.length && full.text?.trim()) throw failure("RESPONSE_INVALID");
  }
  if (
    !words.length &&
    annotation.textAnnotations !== undefined &&
    array(annotation.textAnnotations).length
  ) {
    // An empty full annotation cannot hide fallback text with no usable word geometry.
    throw failure("RESPONSE_INVALID");
  }
  const result = {
    version: 1,
    provider: "google-cloud-vision",
    language:
      detectedLanguages.length === 1
        ? detectedLanguages[0].languageCode
        : "und",
    detectedLanguages,
    pageConfidence,
    width: image.width,
    height: image.height,
    elapsedMs,
    textAngle: null,
    geometry: "axis-aligned-envelope-with-original-polygon",
    words,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.normalizedBytes)
    throw failure("RESPONSE_TOO_LARGE");
  return freeze(result);
}

async function readBoundedJson(response, controller, assertDeadline) {
  assertDeadline();
  if (response.redirected || (response.url && response.url !== ENDPOINT))
    throw failure("PROVIDER_FAILED");
  if (response.status !== 200) {
    controller.abort();
    throw failure("PROVIDER_FAILED");
  }
  const contentType = response.headers?.get("content-type");
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType || ""))
    throw failure("RESPONSE_INVALID");
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > LIMITS.responseBytes)
  )
    throw failure("RESPONSE_TOO_LARGE");
  if (!response.body || typeof response.body.getReader !== "function")
    throw failure("RESPONSE_INVALID");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0,
    chunkCount = 0,
    complete = false;
  const cancelReader = () => {
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  };
  controller.signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      assertDeadline();
      const { done, value } = await reader.read();
      assertDeadline();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure("RESPONSE_INVALID");
      if (++chunkCount > LIMITS.responseChunks)
        throw failure("RESPONSE_TOO_LARGE");
      size += value.byteLength;
      if (size > LIMITS.responseBytes) throw failure("RESPONSE_TOO_LARGE");
      // Empty reads still consume the work budget, but never allocate saved chunks.
      if (value.byteLength) chunks.push(Buffer.from(value));
    }
    if (controller.signal.aborted) throw failure("CANCELLED");
    let value;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      );
      value = JSON.parse(text);
    } catch {
      throw failure("RESPONSE_INVALID");
    }
    assertDeadline();
    complete = true;
    return value;
  } finally {
    if (!complete) {
      controller.abort();
      // A broken/mocked reader must not extend the outer request deadline.
      cancelReader();
    }
    controller.signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

function createGoogleVisionWorker({
  apiKey,
  inspectImageHeader,
  fetchImpl = globalThis.fetch,
  timeoutMs = LIMITS.timeoutMs,
  now = () => performance.now(),
} = {}) {
  if (
    typeof apiKey !== "string" ||
    !/^[A-Za-z0-9_-]{12,256}$/.test(apiKey) ||
    typeof inspectImageHeader !== "function" ||
    typeof fetchImpl !== "function" ||
    typeof now !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 60000
  )
    throw failure("CONFIGURATION");
  return Object.freeze({
    async recognize(bytes, { signal } = {}) {
      if (signal && !(signal instanceof AbortSignal))
        throw failure("CONFIGURATION");
      if (signal?.aborted) throw failure("CANCELLED");
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
        throw failure("IMAGE_INVALID");
      if (bytes.byteLength > LIMITS.imageBytes) throw failure("TOO_LARGE");
      const captured = Buffer.from(bytes);
      let image;
      try {
        image = inspectImageHeader(captured);
        if (
          !["image/jpeg", "image/png", "image/webp"].includes(image?.mimeType)
        )
          throw Error();
      } catch {
        throw failure("IMAGE_INVALID");
      }
      const body = JSON.stringify({
        requests: [
          {
            image: { content: captured.toString("base64") },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      });
      if (Buffer.byteLength(body) > LIMITS.requestBytes)
        throw failure("TOO_LARGE");
      const controller = new AbortController(),
        started = now();
      let timer,
        timedOut = false,
        rejectCancellation;
      const assertDeadline = () => {
        const elapsed = now() - started;
        if (!Number.isFinite(elapsed) || elapsed < 0)
          throw failure("CONFIGURATION");
        if (elapsed >= timeoutMs) {
          timedOut = true;
          controller.abort();
          throw failure("TIMEOUT");
        }
        if (controller.signal.aborted) throw failure("CANCELLED");
        return elapsed;
      };
      const cancellation = new Promise((_, reject) => {
        rejectCancellation = reject;
      });
      const onAbort = () => {
        controller.abort();
        rejectCancellation(failure("CANCELLED"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(failure("TIMEOUT"));
        }, timeoutMs);
      });
      try {
        const work = (async () => {
          assertDeadline();
          const response = await fetchImpl(ENDPOINT, {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-goog-api-key": apiKey,
            },
            body,
            signal: controller.signal,
          });
          try {
            assertDeadline();
            const parsed = await readBoundedJson(
              response,
              controller,
              assertDeadline,
            );
            const result = normalizeVisionResponse(
              parsed,
              image,
              assertDeadline(),
            );
            assertDeadline();
            return result;
          } catch (error) {
            // An injected transport can ignore abort and deliver headers later.
            // Release that unread body without waiting beyond the caller deadline.
            cancelResponseBody(response);
            throw error;
          }
        })();
        return await Promise.race([work, deadline, cancellation]);
      } catch (error) {
        controller.abort();
        if (signal?.aborted) throw failure("CANCELLED");
        if (timedOut) throw failure("TIMEOUT");
        if (error instanceof VisionReceiptError) throw error;
        // Raw provider/network errors can contain credentials, image data, or recognized text.
        throw failure("PROVIDER_FAILED");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}
module.exports = {
  ENDPOINT,
  LIMITS,
  VisionReceiptError,
  normalizeVisionResponse,
  createGoogleVisionWorker,
};

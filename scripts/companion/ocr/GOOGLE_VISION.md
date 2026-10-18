# Optional Google Vision adapter

`googleVisionWorker.cjs` is a server-side provider adapter with offline tests. It is included as an integration foundation; the companion route and mobile receipt workflow do not yet select it. Adding a credential to the existing application configuration does not enable Google Vision. The working Windows OCR option remains unchanged.

## Interface and credentials

`createGoogleVisionWorker({ apiKey, inspectImageHeader, fetchImpl, timeoutMs, now })` returns a worker with `recognize(imageBytes, { signal })`. The integration factory must supply the existing [image-header validator](../../../src/attachments/imageHeader.js) and an explicitly configured server-only credential. Importing or constructing the worker does not contact a provider.

The request contains one selected image and one `DOCUMENT_TEXT_DETECTION` operation at the fixed HTTPS Vision annotation endpoint. The credential travels in the `x-goog-api-key` header; it is never placed in a URL. There is no environment lookup, default credential, configurable provider URL, retry, image URL, cloud-storage upload, or file write in this adapter. Do not import this Node module into the mobile bundle or put its credential in an `EXPO_PUBLIC_*` variable.

Document OCR supplies the page/block/paragraph/word structure used by the normalizer. The request and credential handling follow the [Vision OCR guide](https://docs.cloud.google.com/vision/docs/ocr), [Google API-key authentication guide](https://docs.cloud.google.com/docs/authentication/api-keys-use), and [Vision authentication guidance](https://docs.cloud.google.com/vision/docs/request). A future deployment needs its own appropriately restricted credential and explicitly enabled service; this repository creates neither.

## Bounded request and response

| Boundary            | Adapter behavior                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Image               | Validated static JPEG, PNG, or WebP bytes; maximum 6 MiB                                                                             |
| JSON request        | Maximum 9 MiB, including base64 expansion                                                                                            |
| Raw response        | Maximum 2 MiB and 4,096 chunks; empty chunks count toward the work limit and are not retained                                        |
| Normalized response | Less than 1 MiB, with space reserved for a companion envelope                                                                        |
| Recognized words    | Maximum 3,000 words, 128 UTF-16 code units per word, and 30,000 total text units; excessive output is rejected rather than truncated |
| Duration            | 30 seconds by default; a timer plus monotonic checks around fetch, reads, parsing, and normalization enforce the configured deadline |
| Cancellation        | Aborts transport, rejects late results, and requests cleanup of a late unread body without extending the caller deadline             |

The image limit deliberately leaves room for base64 expansion under the [provider's documented request limits](https://docs.cloud.google.com/vision/quotas). Structural image validation is not a complete native image decoder. Canceling or timing out cannot undo an already submitted provider request or guarantee that its computation or billing stopped.

## Normalized evidence

The result contains `version`, `provider`, `language`, `detectedLanguages`, `pageConfidence`, image dimensions, elapsed time, `textAngle`, a geometry description, and word entries. Each word retains text, an axis-aligned bounding envelope, its original pixel polygon, available confidence, and language evidence.

The provider is truthfully identified as `google-cloud-vision`. Missing confidence is `null`; an explicit zero confidence is preserved. The page language is used only when one is reported; otherwise it is `und`. There is no invented global deskew angle. Normalized coordinates are scaled to the confirmed image dimensions; omitted zero coordinates follow the provider format. See the [Vision response reference](https://docs.cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse).

A successful blank result stays empty. Nonempty text without usable word geometry fails, including fallback text hidden beside an empty full annotation. Partial provider errors, malformed response structures, inconsistent dimensions, redirects, and nonfinite coordinates/confidence fail with fixed messages. Raw provider errors, credentials, image data, and recognized text are not included in those errors. The adapter does not infer a receipt title, amount, date, or currency and cannot save a transaction.

## Offline tests

From the repository root:

```powershell
node --test scripts/companion/tests/google-vision-worker.test.cjs
```

The 18 tests inject provider responses and trap real global fetch. They exercise request minimization, immutable captured image bytes, Unicode/geometry/confidence handling, empty results, malformed data, byte/work limits, deadlines, cancellation, late response cleanup, and the current mobile contract's rejection of the new provider identity. They use the repository's invented receipt fixture. No real credential, listening socket, provider account, or paid request is needed.

These checks do not establish live authentication, OCR accuracy, production throughput, or a completed Android workflow. Official protocol references were consulted on 18 October 2026; live-provider verification has not been performed.

## Remaining integration

1. Add explicit server-side provider selection, private credential loading, request authorization, concurrency/usage limits, and owned request cleanup. Preserve Windows OCR without a cloud account.
2. Deliberately extend [receipt validation and parsing](../../../src/core/receipt.js), declarations, the client, and reviewed-candidate validation. The current contract recognizes Windows OCR and must not accept Google output relabelled as Windows output.
3. Decide which confidence and polygon evidence belongs in the shared response contract while preserving the client response-size bound and owner/session checks.
4. Show the selected provider and cloud image-transfer disclosure before recognition. Use accurate provider-specific size limits; the current Windows path permits 10 MiB, while this adapter permits 6 MiB.
5. Retain manual fallback, editable ambiguous suggestions, optional photo retention, and explicit expense-save confirmation. Recognition alone must never create a transaction.
6. Add route/client/review integration tests, then separately authorize any live check with synthetic receipts, configured services, and spending limits. Report live results separately from these offline tests.

The broader service plan is documented in [Original service integrations](../../../docs/ORIGINAL_SERVICE_INTEGRATIONS.md).

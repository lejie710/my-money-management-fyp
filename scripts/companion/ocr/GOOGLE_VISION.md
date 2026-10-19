# Google Cloud Vision adapter

`googleVisionWorker.cjs` is the server-side receipt recognition adapter used by the [deployable backend](../../../tools/backend/README.md). This is the primary configurable Google Cloud Vision route, with Firebase-authenticated requests and a private server credential. The [Windows companion](../README.md) retains Vision as an explicit development option through version 2 private pairing. Windows OCR remains a separate local provider; failed requests never switch providers automatically.

## Interface and credentials

`createGoogleVisionWorker({ apiKey, inspectImageHeader, fetchImpl, timeoutMs, now })` returns a worker with `recognize(imageBytes, { signal })` and awaitable `close()` / `drain()` methods. The integration factory must supply the existing [image-header validator](../../../src/attachments/imageHeader.js) and an explicitly configured server-only credential. Importing or constructing the worker does not contact a provider.

The request contains one selected image and one `DOCUMENT_TEXT_DETECTION` operation at the fixed HTTPS Vision annotation endpoint. The credential travels in the `x-goog-api-key` header; it is never placed in a URL. There is no environment lookup, default credential, configurable provider URL, retry, image URL, cloud-storage upload, or file write in this adapter. Do not import this Node module into the mobile bundle or put its credential in an `EXPO_PUBLIC_*` variable.

Document OCR supplies the page/block/paragraph/word structure used by the normalizer. The request and credential handling follow the [Vision OCR guide](https://docs.cloud.google.com/vision/docs/ocr), [Google API-key authentication guide](https://docs.cloud.google.com/docs/authentication/api-keys-use), and [Vision authentication guidance](https://docs.cloud.google.com/vision/docs/request). A future deployment needs its own appropriately restricted credential and explicitly enabled service; this repository creates neither.

## Bounded request and response

| Boundary            | Adapter behavior                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Image               | Validated static JPEG, PNG, or WebP bytes; this application's maximum is 6 MiB                                                       |
| JSON request        | Maximum 9 MiB, including base64 expansion                                                                                            |
| Raw response        | Maximum 2 MiB and 4,096 chunks; empty chunks count toward the work limit and are not retained                                        |
| Normalized response | Less than 1 MiB, with space reserved for a companion envelope                                                                        |
| Recognized words    | Maximum 3,000 words, 128 UTF-16 code units per word, and 30,000 total text units; excessive output is rejected rather than truncated |
| Duration            | 30 seconds by default; a timer plus monotonic checks around fetch, reads, parsing, and normalization enforce the configured deadline |
| Cancellation        | Aborts transport, rejects late results, and requests cleanup of a late unread body without extending the caller deadline             |

The 6 MiB image limit is this application's own enforced boundary, not a claim about a universal Google Cloud Vision limit. The adapter also bounds the base64-expanded request. Consult the [provider's request limits](https://docs.cloud.google.com/vision/quotas) when configuring your own service. Structural image validation is not a complete native image decoder. Cancelling or timing out cannot undo an already submitted provider request or guarantee that its computation or billing stopped.

The worker tracks the underlying fetch and response-body retirement separately from the caller-facing deadline. Unfinished transport work blocks another recognition attempt. The owner must await `close()` or `drain()`; bounded cleanup that cannot be confirmed reports a failure, and the backend retires instead of admitting new provider work. Confirmed local transport cleanup does not establish that Google stopped remote processing or reversed usage charges.

## Normalized evidence

The result contains `version`, `provider`, `language`, `detectedLanguages`, `pageConfidence`, image dimensions, elapsed time, `textAngle`, a geometry description, and word entries. Each word retains text, an axis-aligned bounding envelope, its original pixel polygon, available confidence, and language evidence.

The provider is truthfully identified as `google-cloud-vision`. Missing confidence is `null`; an explicit zero confidence is preserved. The page language is used only when one is reported; otherwise it is `und`. There is no invented global deskew angle. Normalized coordinates are scaled to the confirmed image dimensions; omitted zero coordinates follow the provider format. See the [Vision response reference](https://docs.cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse).

A successful blank result stays empty. Nonempty text without usable word geometry fails, including fallback text hidden beside an empty full annotation. Partial provider errors, malformed response structures, inconsistent dimensions, redirects, and nonfinite coordinates/confidence fail with fixed messages. Raw provider errors, credentials, image data, and recognized text are not included in those errors. The adapter does not infer a receipt title, amount, date, or currency and cannot save a transaction.

## Offline tests

From the repository root:

```powershell
node --test scripts/companion/tests/google-vision-worker.test.cjs tests/provider-integration.test.cjs tests/provider-disclosure-ui.test.cjs
```

The adapter tests inject provider responses and trap real global fetch. They cover request minimization, immutable image bytes, Unicode/geometry/confidence handling, empty results, malformed data, byte/work limits, deadlines and cancellation. Integration tests run the actual route and mobile client through owned loopback fixture servers, with fake upstream fetches; they verify provider binding, 6 MiB enforcement, truthful provenance and explicit ordinary-expense confirmation. UI checks verify disclosure before recognition and stale-provider rejection. No real credential, provider account or paid request is needed.

These checks do not establish live authentication, OCR accuracy, production throughput or a completed Android workflow. The [verification record](../../../VERIFICATION.md) separates source, gateway, native and provider evidence; actual-adapter transport-drain regressions also live under `tools/backend/tests`. Official protocol references were consulted on 18 October 2026; live-provider verification has not been performed.

## Hosted backend, companion and review boundaries

The primary hosted route uses the configured HTTPS origin and current Firebase ID token. Metadata and requests are bound to the project, account, service and exact provider descriptor before an image reaches the adapter. Provider keys remain on the server. The [backend guide](../../../tools/backend/README.md) covers its separate authentication, quota and deployment prerequisites; a deployed service does not require a Windows computer beside the phone.

For the optional Windows route, the paired descriptor names `google-cloud-vision`, cloud processing and the 6 MiB limit. The binary request carries the exact `x-mymoney-provider` run/provider binding. The service checks it before reading/forwarding the image; the client verifies its `providerBinding` echo and expected OCR provider before accepting words.

The shared validator preserves Vision's provider, languages, confidence values and original polygons. It checks that each axis-aligned bound agrees with its polygon. Windows results retain the original Windows contract and are not assigned invented confidence. The parser retains the selected provider in its candidate, and unknown providers fail closed. Neither provider receives permission to save financial records.

Before **Recognize with Google Vision**, the panel names Google Cloud Vision as the destination, identifies the configured backend or selected Windows companion that forwards the image, and shows this app's 6 MiB limit and possible provider usage charges. Image selection alone does not upload it. Changing the provider or connection retires the old capture/review session.

Manual entry, editable ambiguous suggestions, optional photo retention and explicit category/currency/field confirmation remain required. Recognition does not save a transaction or permanently attach the image. If the user chooses Keep the receipt photo and confirms the expense, guest attachments remain local; a live Firebase account uploads the retained attachment to its private Storage area before the financial save is confirmed. Raw recognition output is not a substitute for financial server confirmation.

Confidence is evidence from OCR, not proof that an amount or date is correct. Unknown or non-English recognition language adds a warning because the field parser primarily recognizes English receipt labels. Raw OCR evidence remains transient and is not stored as ledger notes.

Offline tests establish these contracts, not live Google authentication or receipt accuracy. A separately authorized synthetic live check with an owner's configured service is required before claiming live verification. The broader setup and remaining operational checks are documented in [Original service integrations](../../../docs/ORIGINAL_SERVICE_INTEGRATIONS.md).

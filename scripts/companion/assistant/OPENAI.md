# OpenAI adapter

`openaiAdapter.cjs` provides a server-side Chat Completions adapter for the app's existing calculated-facts question contract. It is covered by offline tests but is **not connected to the companion routes, pairing protocol or mobile UI**. Adding a key or changing an environment variable does not enable it in the app. The working assistant continues to use its existing local provider.

## Contract

`createOpenAIAdapter({apiKey, model, requestContract, fetch?, timeoutMs?, maxCompletionTokens?, now?})` returns `complete(payload, {signal?})`, `status()` and `close()`. `requestContract` supplies the existing pure `wireFromPayload` and `payloadFromWire` functions. Importing and constructing the adapter make no requests and discover no credentials. The caller must supply a private server credential and an explicit compatible model; no default or fallback model is selected.

The adapter reconstructs the canonical question and selected financial facts, then sends one request to the fixed `https://api.openai.com/v1/chat/completions` endpoint. It includes no photos, conversation history, tools or financial writer. Strict Structured Outputs restrict the answer to `{answer, factIds}` with citations drawn from the supplied facts. Requests use `stream: false`, `store: false` and a bounded `max_completion_tokens` value. `store: false` does not establish zero provider retention.

Successful results retain `content` as a JSON string and `finishReason: "stop"`, with truthful OpenAI/cloud provenance and both the requested and returned model IDs. A configured alias can resolve to a model snapshot. The adapter checks structure and citation IDs; the existing `assessAnswer` semantic checks and owner/session currentness checks remain required before displaying an answer. Schema conformance does not establish financial correctness.

## Limits and failure handling

- Request JSON: 32 KiB. Response: 64 KiB, at most 4,096 chunks and 32 empty chunks, with strict UTF-8 decoding.
- Completion tokens: default 1,024, configurable from 128 to 2,048. Returned content: 1,800 characters; answer: 1,200 characters and 90 words; citations: one through eight unique supplied IDs.
- Deadline: default 60 seconds, configurable from 50 to 120,000 ms, covering headers and body. Monotonic elapsed checks also bound immediately resolving streams.
- Only one completion may be pending. Cancellation, close and timeout abort the owned request and discard late results. They cannot guarantee that the provider stopped processing or avoided charging.
- Refusals, incomplete output, redirects, tools, unknown citations and malformed or oversized responses are rejected. Failures use fixed `OpenAIAdapterError` codes/messages; raw provider errors and keys are not exposed.
- There are no retries, health probes, warmups or automatic provider fallbacks. A later retry must be an explicit user action.

## Integration still required

The current route, client and session protocol expect the local Qwen/Lemonade provider. Enabling this adapter requires server-only configuration, deliberate error mapping, a non-secret provider/model descriptor in versioned pairing, and matching provider validation throughout the request/response path. Keep the private pairing token and fixed mobile loopback endpoint. Credentials must remain outside mobile code, pairing files, command arguments and logs.

Before an explicit Ask action, the UI must identify OpenAI and the selected data that will leave the device. Provider, connection, owner or context changes must invalidate the pending session. Preserve calculated facts, semantic checks, the no-write boundary, the existing local path and explicit retries. Add route/client/UI regression coverage before claiming application support.

No live OpenAI request, model compatibility, account access, response quality, billing behavior or hosted CI result is established by these tests. A separately authorized synthetic live check is needed before claiming live support.

## Offline checks

From the repository root:

```powershell
node --test --test-concurrency=2 scripts/companion/tests/openai-adapter.test.cjs
```

All provider calls use injected fake fetch functions with invented credentials and model IDs. Tests exercise the real pure financial question protocol, bounded request/response handling, cancellation, deadlines, safe failures and the retained semantic rejection of write claims. No SDK or additional dependency is required.

## Official API references

The [Chat Completions create reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) documents the endpoint and request fields. The [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat) documents the named strict JSON schema and separate refusal handling. Parameter support depends on the model. These contracts were checked on 18 October 2026; the adapter intentionally requires an explicit model rather than claiming a particular live model is supported.

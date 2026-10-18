# OpenAI adapter

`openaiAdapter.cjs` is an optional server-side Chat Completions adapter for the app's calculated-facts question contract. The companion route and mobile assistant support an explicitly selected OpenAI provider through version 2 private pairing. Local Lemonade/Qwen remains available; a failed local request never switches to a cloud provider. See the [companion guide](../README.md) for server configuration and pairing.

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

## Companion and mobile boundary

The paired descriptor names OpenAI, cloud processing and the explicitly configured model. Requests and cancellations carry `x-mymoney-provider`; the route checks the exact run/provider binding before forwarding a question. Successful responses echo `providerBinding`. The client rejects mismatched bindings, provider identities or requested models, while preserving the actual returned model snapshot.

Only the server adapter receives a provider credential. It is not a mobile value, pairing field or public environment variable. The same fixed loopback endpoint and per-run companion token remain in use. Private configuration and valid pairing establish configuration, not provider reachability or account access.

The panel identifies OpenAI, its selected model and the data-transfer destination before **Ask OpenAI**. Only the visible calculated facts and current question are sent; old replies, raw transactions, photos and contact/location data are excluded. Provider, connection, owner or context changes invalidate pending results. The existing semantic checks and no-write boundary apply to both providers.

Provider authentication failures, rate limits, refusals, incomplete output and bounded malformed responses become deliberate fixed errors. No raw provider error text or key is exposed. Cancellation invalidates the result and aborts the owned request, but cannot guarantee that provider computation or charges were avoided.

The adapter, route, client and UI contracts are verified with injected upstream responses and synthetic local fixtures. No live OpenAI request, account entitlement, real model compatibility, general response quality or billing behavior is established by those tests. A separately authorized synthetic live check is required before claiming live-provider verification.

## Offline checks

From the repository root:

```powershell
node --test --test-concurrency=2 scripts/companion/tests/openai-adapter.test.cjs tests/provider-integration.test.cjs tests/provider-disclosure-ui.test.cjs
```

All provider calls use injected fake fetch functions with invented credentials and model IDs. Tests exercise the real pure financial question protocol, bounded request/response handling, cancellation, deadlines, safe failures and the retained semantic rejection of write claims. No SDK or additional dependency is required.

## Official API references

The [Chat Completions create reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) documents the endpoint and request fields. The [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat) documents the named strict JSON schema and separate refusal handling. Parameter support depends on the model. These contracts were checked on 18 October 2026; the adapter intentionally requires an explicit model rather than claiming a particular live model is supported.

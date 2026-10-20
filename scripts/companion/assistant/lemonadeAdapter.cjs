const {
  AssistantError,
  MODEL_ID,
  renderQwenPrompt,
  responseFormatForPayload,
} = require("../../../src/assistant/protocol");
const MAX_UPSTREAM_BYTES = 65536;
async function boundedJson(response) {
  if (!response.ok) throw new AssistantError("MODEL_UNAVAILABLE");
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_UPSTREAM_BYTES))
    throw new AssistantError("INVALID_MODEL_RESPONSE");
  if (!response.body?.getReader)
    throw new AssistantError("INVALID_MODEL_RESPONSE");
  const reader = response.body.getReader(),
    parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPSTREAM_BYTES)
        throw new AssistantError("INVALID_MODEL_RESPONSE");
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts, total).toString("utf8"));
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError("INVALID_MODEL_RESPONSE");
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}
function completion(response) {
  const choice = response?.choices?.[0];
  if (
    response?.model !== MODEL_ID ||
    !Array.isArray(response.choices) ||
    response.choices.length !== 1 ||
    choice.finish_reason !== "stop" ||
    choice.message?.role !== "assistant" ||
    choice.message.tool_calls ||
    typeof choice.message.content !== "string" ||
    !choice.message.content.trim() ||
    choice.message.content.length > 1800
  )
    throw new AssistantError("INVALID_MODEL_RESPONSE");
  return {
    model: MODEL_ID,
    content: choice.message.content,
    finishReason: "stop",
  };
}
function createLemonadeAdapter({
  baseUrl,
  apiKey,
  fetch: fetcher = globalThis.fetch,
  timeoutMs = 120000,
  allowCpu = false,
}) {
  const match =
    typeof baseUrl === "string"
      ? /^http:\/\/127\.0\.0\.1:(\d+)\/api\/v1$/.exec(baseUrl)
      : null;
  if (
    !match ||
    Number(match[1]) < 1 ||
    Number(match[1]) > 65535 ||
    typeof apiKey !== "string" ||
    apiKey.length < 32 ||
    typeof fetcher !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 120000
  )
    throw new AssistantError("MODEL_UNAVAILABLE");
  let busy = false,
    uncertain = false,
    closed = false;
  function loadedModel(health) {
    const model = health?.all_models_loaded?.find(
      (row) => row.model_name === MODEL_ID,
    );
    if (!model) return null;
    const command = (model.launch_command || []).join(" ").replace(/\\/g, "/");
    const backend = command.includes("/llamacpp/vulkan/")
      ? "vulkan"
      : command.includes("/llamacpp/cpu/")
        ? "cpu"
        : null;
    if (
      !model.loaded ||
      !model.backend_alive ||
      model.recipe_options?.ctx_size !== 2048 ||
      !backend ||
      (backend === "cpu" && !allowCpu) ||
      !/--parallel 1(?: |$)/.test(command)
    )
      throw new AssistantError("MODEL_UNAVAILABLE");
    return backend;
  }
  return {
    async complete(payload, { signal } = {}) {
      if (closed || uncertain) throw new AssistantError("MODEL_UNAVAILABLE");
      if (busy) throw new AssistantError("BUSY");
      if (signal?.aborted) throw new AssistantError("CANCELLED");
      busy = true;
      const abort = new AbortController();
      let timedOut = false,
        completionPending = false;
      let rejectDeadline;
      const deadline = new Promise((_, reject) => {
        rejectDeadline = reject;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
        rejectDeadline(new AssistantError("TIMEOUT"));
      }, timeoutMs);
      const request = (path, body) =>
        Promise.race([
          (async () =>
            boundedJson(
              await fetcher(baseUrl + path, {
                method: body ? "POST" : "GET",
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: abort.signal,
                redirect: "error",
                credentials: "omit",
              }),
            ))(),
          deadline,
        ]);
      const checkCancelled = () => {
        if (signal?.aborted || closed) throw new AssistantError("CANCELLED");
      };
      try {
        let backend = loadedModel(await request("/health"));
        if (!backend) {
          checkCancelled();
          completionPending = true;
          // A tiny, fixed synthetic completion triggers lazy loading of already-staged weights.
          completion(
            await request("/chat/completions", {
              model: MODEL_ID,
              messages: [{ role: "user", content: "Reply with Ready." }],
              max_tokens: 8,
              temperature: 0,
              seed: 7,
              stream: false,
            }),
          );
          completionPending = false;
          backend = loadedModel(await request("/health"));
          if (!backend) throw new AssistantError("MODEL_UNAVAILABLE");
        }
        checkCancelled();
        const tokenized = await request("/tokenize", {
          model: MODEL_ID,
          content: renderQwenPrompt(payload),
          add_special: false,
          parse_special: true,
          with_pieces: false,
        });
        if (
          !Array.isArray(tokenized.tokens) ||
          tokenized.tokens.length === 0 ||
          tokenized.tokens.some(
            (value) => !Number.isSafeInteger(value) || value < 0,
          )
        )
          throw new AssistantError("INVALID_MODEL_RESPONSE");
        // Exact pinned-template tokenization plus explicit completion/BOS margin; no truncation.
        if (tokenized.tokens.length + 512 + 32 > 2048)
          throw new AssistantError("CONTEXT_TOO_LARGE");
        checkCancelled();
        completionPending = true;
        const raw = await request("/chat/completions", {
          ...payload,
          response_format: responseFormatForPayload(payload),
        });
        completionPending = false;
        const result = completion(raw);
        checkCancelled();
        return {
          ...result,
          backend,
          promptTokenCount: tokenized.tokens.length,
          usage: raw.usage || null,
        };
      } catch (error) {
        if (completionPending) uncertain = true;
        if (timedOut) {
          uncertain = true;
          throw new AssistantError("TIMEOUT");
        }
        if (error instanceof AssistantError) throw error;
        throw new AssistantError("MODEL_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        abort.abort();
        busy = false;
      }
    },
    status() {
      return { busy, uncertain, closed };
    },
    close() {
      closed = true;
    },
  };
}
module.exports = { createLemonadeAdapter };

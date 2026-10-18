const INBOX_URL =
  "http://127.0.0.1:9099/emulator/v1/projects/demo-fyp-local/oobCodes";
const MAX_INBOX_BYTES = 2 * 1024 * 1024;
const result = (ok, pending, message) => ({ ok, pending, message });
function utf8Length(value) {
  let size = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    size += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return size;
}
function address(value) {
  if (
    typeof value !== "string" ||
    value.trim().length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    throw new Error("Enter a valid local demo account email.");
  return value.trim();
}
function createLocalResetController({
  sdk,
  auth,
  isCurrent,
  runExclusive,
  fetchImpl = globalThis.fetch,
}) {
  if (
    !sdk ||
    ![
      "sendPasswordResetEmail",
      "verifyPasswordResetCode",
      "confirmPasswordReset",
    ].every((name) => typeof sdk[name] === "function") ||
    typeof fetchImpl !== "function"
  )
    throw new Error("Local password reset is unavailable in this runtime.");
  let closed = false,
    generation = 0,
    busy = false,
    requested = false,
    code = null,
    verified = false;
  let baseline = new Set(),
    uncertainConfirm = false,
    uncertainRequest = false,
    activeInboxAbort = null;
  let state = Object.freeze({
    phase: "idle",
    email: "",
    messageAvailable: false,
    message: "",
    error: "",
    busy: false,
    canRequest: true,
    canRefresh: false,
    canVerify: false,
    canConfirm: false,
  });
  const listeners = new Set();
  const valid = (revision) => !closed && generation === revision && isCurrent();
  const publish = (patch) => {
    if (closed) return;
    const next = { ...state, ...patch, busy };
    next.messageAvailable = code !== null;
    next.canRequest = !busy && isCurrent() && !uncertainRequest;
    next.canRefresh =
      !busy &&
      isCurrent() &&
      requested &&
      state.email !== "" &&
      next.phase !== "complete";
    next.canVerify =
      !busy &&
      isCurrent() &&
      code !== null &&
      !verified &&
      next.phase !== "complete";
    next.canConfirm =
      !busy && isCurrent() && code !== null && verified && !uncertainConfirm;
    state = Object.freeze(next);
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  const check = (revision) => {
    if (!valid(revision))
      throw new Error("This local reset session is no longer active.");
  };
  async function inbox(email, revision) {
    check(revision);
    const abort = new AbortController();
    activeInboxAbort = abort;
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetchImpl(INBOX_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: abort.signal,
      });
      check(revision);
      if (!response.ok || (response.url && response.url !== INBOX_URL))
        throw new Error("The local inbox could not be read.");
      const declared = response.headers?.get?.("content-length");
      if (declared && Number(declared) > MAX_INBOX_BYTES)
        throw new Error("The local inbox is too large to inspect safely.");
      const text = await response.text();
      check(revision);
      if (
        typeof text !== "string" ||
        text.length > MAX_INBOX_BYTES ||
        utf8Length(text) > MAX_INBOX_BYTES
      )
        throw new Error("The local inbox response is unavailable.");
      const data = JSON.parse(text);
      if (
        !data ||
        !Array.isArray(data.oobCodes) ||
        data.oobCodes.length > 10000
      )
        throw new Error("The local inbox response is invalid.");
      // Keep only the exact requested address/type; discard every other record.
      return new Set(
        data.oobCodes
          .filter(
            (item) =>
              item &&
              item.requestType === "PASSWORD_RESET" &&
              typeof item.email === "string" &&
              item.email.toLowerCase() === email.toLowerCase() &&
              typeof item.oobCode === "string" &&
              item.oobCode.length > 0 &&
              item.oobCode.length <= 4096 &&
              !/[\u0000-\u0020\u007f]/.test(item.oobCode),
          )
          .map((item) => item.oobCode),
      );
    } finally {
      clearTimeout(timer);
      if (activeInboxAbort === abort) activeInboxAbort = null;
    }
  }
  async function readNewMessage(email, revision) {
    const found = [...(await inbox(email, revision))].filter(
      (value) => !baseline.has(value),
    );
    check(revision);
    if (found.length === 0 && uncertainRequest) {
      code = null;
      verified = false;
      publish({
        phase: "awaiting-message",
        error: "",
        message:
          "No matching message has appeared yet. The earlier request is still unconfirmed. Check again, or close this view to explicitly start a new request; the earlier message could still arrive.",
      });
      return result(false, true, state.message);
    }
    uncertainRequest = false;
    if (found.length > 1) {
      code = null;
      verified = false;
      publish({
        phase: "awaiting-message",
        error:
          "More than one new local reset message was found. Request a fresh message before continuing.",
        message: "",
      });
      return result(false, false, state.error);
    }
    code = found[0] ?? null;
    verified = false;
    publish({
      phase: "awaiting-message",
      error: "",
      message: code
        ? "A matching local reset message is ready. No email was delivered."
        : "No new matching local message is available yet. Check the inbox again or request a new message.",
    });
    return result(true, false, state.message);
  }
  async function perform(phase, work) {
    if (closed || !isCurrent())
      return result(
        false,
        false,
        "This local reset session is no longer active.",
      );
    if (busy)
      return result(
        false,
        true,
        "The current local reset operation is still settling.",
      );
    busy = true;
    const revision = generation;
    publish({ phase, error: "", message: "" });
    try {
      return await runExclusive(async () => {
        check(revision);
        return work(revision);
      });
    } catch {
      if (!valid(revision))
        return result(
          false,
          true,
          "The reset view changed. No late result was applied.",
        );
      publish({
        phase: "unavailable",
        error:
          "The local reset operation could not be confirmed. Check the local service or inbox before retrying.",
        message: "",
      });
      return result(false, true, state.error);
    } finally {
      busy = false;
      if (valid(revision)) publish({});
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (typeof listener !== "function")
        throw new Error("A reset listener is required.");
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(value) {
      let email;
      try {
        email = address(value);
      } catch {
        return Promise.resolve(
          result(false, false, "Enter a valid local demo account email."),
        );
      }
      if (busy)
        return Promise.resolve(
          result(
            false,
            true,
            "The current local reset operation is still settling.",
          ),
        );
      if (uncertainRequest)
        return Promise.resolve(
          result(
            false,
            true,
            "Check the existing local reset request in the inbox before sending another.",
          ),
        );
      code = null;
      verified = false;
      uncertainConfirm = false;
      requested = false;
      return perform("requesting", async (revision) => {
        publish({ email });
        baseline = await inbox(email, revision);
        check(revision);
        requested = true;
        try {
          await sdk.sendPasswordResetEmail(auth(), email);
        } catch {
          check(revision);
          uncertainRequest = true;
          publish({
            phase: "awaiting-message",
            message:
              "The reset request outcome is unconfirmed. Check the local inbox before sending another request.",
            error: "",
          });
          return result(false, true, state.message);
        }
        check(revision);
        return readNewMessage(email, revision);
      });
    },
    refresh() {
      if (!requested || !state.email)
        return Promise.resolve(
          result(false, false, "Request a local reset message first."),
        );
      return perform("awaiting-message", (revision) =>
        readNewMessage(state.email, revision),
      );
    },
    verify() {
      if (!code)
        return Promise.resolve(
          result(
            false,
            false,
            "Request or check for a new local reset message.",
          ),
        );
      return perform("verifying", async (revision) => {
        const selected = code;
        let mismatch = false;
        try {
          const email = await sdk.verifyPasswordResetCode(auth(), selected);
          check(revision);
          if (
            typeof email !== "string" ||
            email.toLowerCase() !== state.email.toLowerCase()
          ) {
            mismatch = true;
            throw new Error(
              "The requested address does not match this reset message.",
            );
          }
          verified = true;
          uncertainConfirm = false;
          publish({
            phase: "verified",
            message: `Local reset message verified for ${state.email}.`,
            error: "",
          });
          return result(true, false, state.message);
        } catch (error) {
          check(revision);
          if (
            !mismatch &&
            !["auth/invalid-action-code", "auth/expired-action-code"].includes(
              error?.code,
            )
          ) {
            verified = false;
            publish({
              phase: "unavailable",
              error:
                "This local reset message could not be checked. Its validity is still unknown; retry verification when the service is available.",
              message: "",
            });
            return result(false, true, state.error);
          }
          baseline.add(selected);
          code = null;
          verified = false;
          publish({
            phase: "awaiting-message",
            error: uncertainConfirm
              ? "This reset message is no longer valid. If you already submitted a new password, try signing in with it; otherwise request a new message."
              : "This local reset message is invalid, expired, or already used. Request a new message.",
            message: "",
          });
          return result(false, false, state.error);
        }
      });
    },
    confirm(newPassword) {
      if (
        typeof newPassword !== "string" ||
        newPassword.length === 0 ||
        newPassword.length > 4096
      )
        return Promise.resolve(result(false, false, "Enter a new password."));
      if (!code || !verified || uncertainConfirm)
        return Promise.resolve(
          result(
            false,
            false,
            "Verify a new matching local reset message first.",
          ),
        );
      return perform("confirming", async (revision) => {
        const selected = code;
        try {
          await sdk.confirmPasswordReset(auth(), selected, newPassword);
          check(revision);
          baseline.add(selected);
          code = null;
          verified = false;
          publish({
            phase: "complete",
            message:
              "The local password was changed. Sign in explicitly with the new password.",
            error: "",
          });
          return result(true, false, state.message);
        } catch (error) {
          check(revision);
          if (error?.code === "auth/weak-password") {
            publish({
              phase: "verified",
              error: "Choose a stronger new password and try again.",
              message: "",
            });
            return result(false, false, state.error);
          }
          verified = false;
          uncertainConfirm = true;
          publish({
            phase: "unavailable",
            message:
              "The password change outcome could not be confirmed. Recheck this message before another attempt.",
            error: "",
          });
          return result(false, true, state.message);
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      generation++;
      activeInboxAbort?.abort();
      activeInboxAbort = null;
      code = null;
      verified = false;
      baseline.clear();
      listeners.clear();
    },
  };
}
module.exports = { createLocalResetController, INBOX_URL, MAX_INBOX_BYTES };

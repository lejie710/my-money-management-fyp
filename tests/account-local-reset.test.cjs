const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalResetController, INBOX_URL } = require("../src/accounts/localReset");
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function fixture(options = {}) {
  let active = true,
    locked = false,
    sequence = 0;
  const messages = [
    {
      email: "other@example.test",
      requestType: "PASSWORD_RESET",
      oobCode: "other-private-code",
    },
    {
      email: "a@example.test",
      requestType: "PASSWORD_RESET",
      oobCode: "old-private-code",
    },
  ];
  const calls = [];
  const sdk = {
    async sendPasswordResetEmail(_auth, email) {
      calls.push("send");
      if (options.send) return options.send(email, messages);
      messages.push({
        email,
        requestType: "PASSWORD_RESET",
        oobCode: `new-private-code-${++sequence}`,
      });
    },
    async verifyPasswordResetCode(_auth, code) {
      calls.push("verify");
      return options.verify ? options.verify(code) : "a@example.test";
    },
    async confirmPasswordReset(_auth, code, password) {
      calls.push("confirm");
      if (options.confirm) return options.confirm(code, password);
    },
  };
  const controller = createLocalResetController({
    sdk,
    auth: () => ({}),
    isCurrent: () => active,
    async runExclusive(work) {
      if (locked) throw Error("Another SDK action is pending");
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
      }
    },
    async fetchImpl(url, settings) {
      calls.push("fetch");
      assert.equal(url, INBOX_URL);
      assert.equal(settings.redirect, "error");
      if (options.fetch) return options.fetch(messages, settings);
      return {
        ok: true,
        url: INBOX_URL,
        headers: { get: () => null },
        text: async () => JSON.stringify({ oobCodes: messages }),
      };
    },
  });
  return {
    controller,
    messages,
    calls,
    setActive(value) {
      active = value;
    },
    get locked() {
      return locked;
    },
  };
}

test("request/verify/confirm are explicit and UI snapshot never contains raw codes, other addresses or password", async () => {
  const f = fixture();
  const before = f.controller.getSnapshot();
  assert.equal(before.phase, "idle");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.controller.request(" a@example.test ")).ok, true);
  assert.equal(f.controller.getSnapshot().messageAvailable, true);
  assert.equal(f.controller.getSnapshot().canConfirm, false);
  assert.equal((await f.controller.verify()).ok, true);
  assert.equal(f.controller.getSnapshot().canConfirm, true);
  assert.equal((await f.controller.confirm("synthetic-new-password")).ok, true);
  const ui = JSON.stringify(f.controller.getSnapshot());
  assert.doesNotMatch(
    ui,
    /private-code|other@example|synthetic-new-password|oobCode/,
  );
  assert.equal(f.controller.getSnapshot().phase, "complete");
  assert.equal((await f.controller.confirm("repeat")).ok, false);
  assert.equal(f.calls.filter((x) => x === "confirm").length, 1);
});

test("older, wrong-address and wrong-type messages never become the selected reset target", async () => {
  const f = fixture({
    send: async (_email, messages) => {
      messages.push(
        {
          email: "a@example.test",
          requestType: "VERIFY_EMAIL",
          oobCode: "wrong-type",
        },
        {
          email: "other@example.test",
          requestType: "PASSWORD_RESET",
          oobCode: "wrong-address",
        },
      );
    },
  });
  await f.controller.request("a@example.test");
  assert.equal(f.controller.getSnapshot().messageAvailable, false);
  assert.equal((await f.controller.verify()).ok, false);
  assert.equal(f.calls.includes("verify"), false);
});

test("multiple newly observed matching messages are rejected instead of guessing chronological order", async () => {
  const f = fixture({
    send: async (email, messages) => {
      for (const suffix of ["one", "two"])
        messages.push({
          email,
          requestType: "PASSWORD_RESET",
          oobCode: suffix,
        });
    },
  });
  assert.equal((await f.controller.request("a@example.test")).ok, false);
  assert.match(f.controller.getSnapshot().error, /More than one/);
  assert.equal(f.controller.getSnapshot().canVerify, false);
});

test("an empty inbox recheck cannot settle a rejected send or enable a duplicate request", async () => {
  const f = fixture({
    send: async () => {
      throw Error("Private server payload");
    },
  });
  assert.equal((await f.controller.request("a@example.test")).pending, true);
  assert.equal(f.controller.getSnapshot().canRequest, false);
  assert.equal((await f.controller.request("a@example.test")).pending, true);
  assert.equal(f.calls.filter((x) => x === "send").length, 1);
  assert.equal((await f.controller.refresh()).pending, true);
  assert.equal(f.controller.getSnapshot().canRequest, false);
  assert.match(f.controller.getSnapshot().message, /still unconfirmed/);
  assert.equal((await f.controller.request("a@example.test")).pending, true);
  assert.equal(f.calls.filter((x) => x === "send").length, 1);
  f.messages.push({
    email: "a@example.test",
    requestType: "PASSWORD_RESET",
    oobCode: "late-private-code",
  });
  assert.equal((await f.controller.refresh()).ok, true);
  assert.equal(f.controller.getSnapshot().canVerify, true);
  assert.equal(f.calls.filter((x) => x === "send").length, 1);
});

test("network verification failure preserves the private candidate for retry; mismatched or consumed code is invalidated", async () => {
  for (const behavior of ["network", "mismatch", "used"]) {
    const f = fixture({
      verify: async () => {
        if (behavior === "mismatch") return "other@example.test";
        throw Object.assign(Error("Private payload"), {
          code:
            behavior === "used"
              ? "auth/invalid-action-code"
              : "auth/network-request-failed",
        });
      },
    });
    await f.controller.request("a@example.test");
    const result = await f.controller.verify();
    assert.equal(result.ok, false);
    assert.equal(f.controller.getSnapshot().canConfirm, false);
    assert.equal(
      f.controller.getSnapshot().messageAvailable,
      behavior === "network",
    );
    assert.equal(result.pending, behavior === "network");
  }
});

test("weak-password rejection is correctable, but ambiguous confirmation requires a new validity check", async () => {
  for (const behavior of ["weak", "network"]) {
    const f = fixture({
      confirm: async () => {
        throw Object.assign(Error("Private payload"), {
          code:
            behavior === "weak"
              ? "auth/weak-password"
              : "auth/network-request-failed",
        });
      },
    });
    await f.controller.request("a@example.test");
    await f.controller.verify();
    const result = await f.controller.confirm("synthetic");
    assert.equal(result.pending, behavior === "network");
    assert.equal(f.controller.getSnapshot().canConfirm, behavior === "weak");
    assert.doesNotMatch(
      JSON.stringify(f.controller.getSnapshot()),
      /Private payload|private-code/,
    );
  }
});

test("close or identity-context change during inbox read prevents a later SDK send", async () => {
  for (const close of [true, false]) {
    const read = deferred();
    const f = fixture({ fetch: () => read.promise });
    const pending = f.controller.request("a@example.test");
    if (close) f.controller.close();
    else f.setActive(false);
    read.resolve({
      ok: true,
      url: INBOX_URL,
      text: async () => JSON.stringify({ oobCodes: [] }),
    });
    assert.equal((await pending).ok, false);
    assert.equal(f.calls.includes("send"), false);
    assert.equal(f.locked, false);
    f.controller.close();
  }
});

test("unreadable, redirected, oversized or malformed inbox responses are never followed or used", async () => {
  for (const fetch of [
    async () => ({
      ok: true,
      url: "https://elsewhere.invalid",
      text: async () => "{}",
    }),
    async () => ({ ok: false, url: INBOX_URL, text: async () => "{}" }),
    async () => ({ ok: true, url: INBOX_URL, text: async () => "{bad" }),
    async () => ({
      ok: true,
      url: INBOX_URL,
      text: async () => JSON.stringify({ oobCodes: null }),
    }),
    async () => ({
      ok: true,
      url: INBOX_URL,
      headers: { get: () => "99999999" },
      text: async () => {
        throw Error("Must not read oversized body");
      },
    }),
  ]) {
    const f = fixture({ fetch });
    const result = await f.controller.request("a@example.test");
    assert.equal(result.ok, false);
    assert.equal(f.calls.includes("send"), false);
  }
});

test("closing the reset view aborts its actual inbox fetch and promptly releases the shared SDK gate", async () => {
  let aborted = false;
  const f = fixture({
    fetch: async (_messages, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("Synthetic aborted request"));
          },
          { once: true },
        );
      }),
  });
  const pending = f.controller.request("a@example.test");
  assert.equal(f.locked, true);
  f.controller.close();
  assert.equal((await pending).ok, false);
  assert.equal(aborted, true);
  assert.equal(f.locked, false);
  assert.equal(f.calls.includes("send"), false);
});

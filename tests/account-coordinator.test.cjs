const test = require("node:test"),
  assert = require("node:assert/strict");
const model = require("../src/core/model");
const { createAccountCoordinator } = require("../src/accounts/coordinator");
const {
  createFamilyLedgerStorage,
  familyStorageKeys,
} = require("../src/accounts/familyStorage");
const { createProfileStore } = require("../src/accounts/profileStore");
const { reconcileAchievements } = require("../src/core/achievements");
const { commitLedger } = require("../src/core/commitLedger");
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));
const user = (uid, name = null) => ({
  uid,
  email: `${uid.toLowerCase()}@example.test`,
  displayName: name,
});
let namespace = 0;
function harness({ configured = true } = {}) {
  const scope = {
      kind: "test",
      namespace: `accounts-coordinator-${++namespace}`,
    },
    events = [],
    data = new Map();
  const clock = { today: "2026-10-18", nowMs: 1792281600000 },
    identityContext = {
      clock,
      newIncarnationId: () => "coincident-incarnation",
    };
  const state = {
    user: null,
    persistence: "confirmed",
    service: "available",
    mutationPending: false,
  };
  const faults = {
    block: false,
    activate: false,
    resume: false,
    read: false,
    write: false,
    writeThenThrow: false,
    profile: false,
    extrasWrite: false,
  };
  const adapter = {
    async getItem(key) {
      if (faults.read) throw new Error("private read payload");
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      if (faults.write) throw new Error("private write payload");
      if (faults.extrasWrite && key.startsWith("@mymoney/account-profile/"))
        throw new Error("private extra payload");
      data.set(key, value);
      if (faults.writeThenThrow) throw new Error("private write payload");
    },
  };
  const listeners = new Set();
  let guard = async () => {},
    mutation = null,
    held = false,
    target = null;
  const auth = {
    async initialize(before) {
      guard = before;
      events.push("initialize");
      return clone(state);
    },
    async confirmIdentity() {
      events.push("confirm");
      return clone(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async signIn(input) {
      events.push("sign-in");
      assert.equal(held, true);
      if (mutation) return mutation(input);
      await guard();
      state.user = user(input.email.split("@")[0].toUpperCase());
      for (const listener of listeners) listener();
    },
    async register(input) {
      events.push("register");
      assert.equal(held, true);
      if (mutation) return mutation(input);
      await guard();
      state.user = user(input.email.split("@")[0].toUpperCase());
      for (const listener of listeners) listener();
    },
    async signOut() {
      events.push("sign-out");
      assert.equal(held, true);
      if (mutation) return mutation();
      await guard();
      state.user = null;
      for (const listener of listeners) listener();
    },
    async updateDisplayName(uid, name) {
      events.push("profile");
      assert.equal(held, true);
      assert.equal(state.user.uid, uid);
      if (faults.profile) throw new Error("private profile response");
      state.user = { ...state.user, displayName: name };
      for (const listener of listeners) listener();
    },
  };
  const financial = {
    isIdentityLeaseReady() {
      return held && !faults.leaseUnready;
    },
    async prepareIdentityChange(context) {
      events.push(`prepare:${context.reason}`);
      if (faults.block) return { ok: false, message: "blocked" };
      assert.equal(held, false);
      held = true;
      return { ok: true, lease: {} };
    },
    async activate(lease, next, isCurrent) {
      events.push(
        `activate:${next.family.actor.kind}:${next.family.actor.uid ?? "guest"}`,
      );
      assert.equal(held, true);
      if (faults.activate)
        return { ok: false, pending: true, message: "pending" };
      if (!isCurrent()) return { ok: false, pending: true, message: "stale" };
      target = next;
      return { ok: true, pending: false, message: "ready" };
    },
    async resume(lease, next, isCurrent) {
      events.push(`resume:${next.family.actor.uid ?? "guest"}`);
      assert.equal(held, true);
      if (faults.resume)
        return { ok: false, pending: true, message: "pending" };
      assert.equal(isCurrent(), true);
      target = next;
      return { ok: true, pending: false, message: "ready" };
    },
    release() {
      events.push("release");
      assert.equal(held, true);
      held = false;
    },
  };
  const storageForFamily = (family) =>
    createFamilyLedgerStorage(adapter, family, { identityContext });
  const profileForFamily = (family) =>
    createProfileStore(adapter, family, () => clock.today);
  const options = {
    runtime: {},
    scope,
    auth: configured ? auth : null,
    financial,
    storageForFamily,
    profileForFamily,
    identityContext,
    createGuestLedger: () =>
      model.createDemoLedger(new Date("2026-10-18T12:00:00Z"), identityContext),
  };
  const controller = createAccountCoordinator(options);
  return {
    controller,
    options,
    state,
    faults,
    events,
    data,
    adapter,
    financial,
    auth,
    scope,
    storageForFamily,
    profileForFamily,
    get held() {
      return held;
    },
    get target() {
      return target;
    },
    setMutation(value) {
      mutation = value;
    },
    async external(next) {
      await guard();
      state.user = next;
      for (const listener of listeners) listener();
    },
    family(uid) {
      return {
        scope,
        actor: uid ? { kind: "firebase", uid } : { kind: "local" },
      };
    },
  };
}
test("startup hides all wallets until confirmed identity and correct owned ledger activation", async () => {
  const h = harness();
  h.state.user = user("A");
  const views = [];
  h.controller.subscribe(() => views.push(h.controller.getSnapshot()));
  assert.equal(h.controller.getSnapshot().activeOwnerToken, null);
  assert.equal((await h.controller.initialize()).ok, true);
  const view = h.controller.getSnapshot();
  assert.equal(view.user.uid, "A");
  assert.equal(view.phase, "ready");
  assert.equal(h.target.ledger.mode, "local");
  assert.equal(h.target.ledger.transactions.length, 0);
  assert.ok(
    views
      .filter((v) => v.phase !== "ready")
      .every((v) => v.activeOwnerToken === null),
  );
  assert.ok(!h.data.has(familyStorageKeys(h.family(null)).key));
  assert.equal(h.held, false);
  h.controller.dispose();
});
test("guest A B guest switching preserves exact bytes and isolated financial state despite identical incarnation IDs", async () => {
  const h = harness();
  await h.controller.initialize();
  const guestKey = familyStorageKeys(h.family(null)).key,
    guestBytes = h.data.get(guestKey);
  assert.equal(
    (
      await h.controller.register({
        email: "a@example.test",
        password: " synthetic ",
        displayName: " Account A ",
      })
    ).ok,
    true,
  );
  let a = model.saveTransaction(
    h.target.ledger,
    model.transactionFromDraft(
      {
        type: "income",
        title: "A only",
        amount: "100",
        date: "2026-10-18",
        categoryId: "income-salary",
      },
      "a-record",
      h.target.ledger,
    ),
  );
  await h.target.storage.save(a);
  const aKey = h.target.storage.key,
    aBytes = h.data.get(aKey);
  await h.controller.signOut();
  assert.equal(h.data.get(guestKey), guestBytes);
  assert.equal(h.target.ledger.mode, "sample");
  await h.controller.signIn({ email: "b@example.test", password: "b" });
  assert.equal(h.target.ledger.transactions.length, 0);
  const bToken = h.controller.getSnapshot().activeOwnerToken;
  await h.controller.signOut();
  await h.controller.signIn({ email: "a@example.test", password: "a" });
  assert.equal(h.data.get(aKey), aBytes);
  assert.equal(h.target.ledger.transactions[0].title, "A only");
  assert.notEqual(h.controller.getSnapshot().activeOwnerToken, bToken);
  assert.equal(h.data.get(guestKey), guestBytes);
  h.controller.dispose();
});
test("financial/editor/save refusal occurs before every SDK mutation and preserves current ready owner", async () => {
  const h = harness();
  await h.controller.initialize();
  const old = h.controller.getSnapshot().activeOwnerToken;
  h.faults.block = true;
  const value = await h.controller.register({
    email: "a@example.test",
    password: "p",
    displayName: "A",
  });
  assert.equal(value.ok, false);
  assert.ok(!h.events.includes("register"));
  assert.equal(h.controller.getSnapshot().phase, "ready");
  assert.equal(h.controller.getSnapshot().activeOwnerToken, old);
  h.controller.dispose();
});
test("wrong password resumes only the confirmed previous owner after current-key readback", async () => {
  const h = harness();
  await h.controller.initialize();
  const old = h.controller.getSnapshot().activeOwnerToken;
  h.setMutation(async () => {
    throw {
      code: "auth/invalid-credential",
      message: "synthetic private payload",
    };
  });
  const value = await h.controller.signIn({
    email: "a@example.test",
    password: "bad",
  });
  assert.equal(value.ok, false);
  assert.match(value.message, /not accepted/);
  assert.equal(h.controller.getSnapshot().activeOwnerToken, old);
  assert.ok(h.events.includes("resume:guest"));
  assert.equal(h.held, false);
  assert.ok(
    !JSON.stringify(h.controller.getSnapshot()).includes("private payload"),
  );
  h.controller.dispose();
});
test("SDK promise rejection after identity persistence succeeded activates actual target instead of reviving guest", async () => {
  const h = harness();
  await h.controller.initialize();
  h.setMutation(async () => {
    h.state.user = user("A");
    throw { code: "auth/network-request-failed" };
  });
  const value = await h.controller.signIn({
    email: "a@example.test",
    password: "p",
  });
  assert.equal(value.ok, true);
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  assert.ok(!h.events.includes("resume:guest"));
  h.controller.dispose();
});
test("unconfirmed persistence holds lease and hides finances; retry confirms existing outcome without repeating registration", async () => {
  const h = harness();
  await h.controller.initialize();
  h.setMutation(async () => {
    h.state.user = user("A");
    h.state.persistence = "unconfirmed";
    throw new Error("storage");
  });
  const value = await h.controller.register({
    email: "a@example.test",
    password: "p",
    displayName: "A",
  });
  assert.equal(value.pending, true);
  assert.equal(h.held, true);
  assert.equal(h.controller.getSnapshot().activeOwnerToken, null);
  assert.equal(h.controller.getSnapshot().capabilities.register, false);
  h.state.persistence = "confirmed";
  await h.controller.retry();
  assert.equal(h.events.filter((x) => x === "register").length, 1);
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  assert.equal(h.held, false);
  h.controller.dispose();
});
test("pending SDK work blocks activation even when current persisted identity is otherwise confirmed", async () => {
  const h = harness();
  await h.controller.initialize();
  h.setMutation(async () => {
    h.state.mutationPending = true;
    throw new Error("timeout");
  });
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().phase, "session-unavailable");
  assert.equal(h.held, true);
  await h.controller.retry();
  assert.equal(h.held, true);
  assert.equal(h.events.filter((x) => x === "sign-in").length, 1);
  h.state.user = user("A");
  h.state.mutationPending = false;
  await h.controller.retry();
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  h.controller.dispose();
});
test("failed initial session restoration never chooses guest or writes a wallet", async () => {
  const h = harness();
  h.state.persistence = "unconfirmed";
  const result = await h.controller.initialize();
  assert.equal(result.ok, false);
  assert.equal(h.data.size, 0);
  assert.equal(h.controller.getSnapshot().phase, "session-unavailable");
  assert.equal(h.held, true);
  h.controller.dispose();
});
test("wrong-password compensation with missing/read-failed saved ledger never resurrects an old wallet", async () => {
  const h = harness();
  await h.controller.initialize();
  h.setMutation(async () => {
    h.faults.read = true;
    throw { code: "auth/wrong-password" };
  });
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(h.controller.getSnapshot().activeOwnerToken, null);
  assert.ok(!h.events.includes("resume:guest"));
  assert.equal(h.held, true);
  h.controller.dispose();
});
test("read-only corrupt target permits separately guarded sign-out but never guest fallback automatically", async () => {
  const h = harness();
  await h.controller.initialize();
  h.data.set(familyStorageKeys(h.family("A")).key, "corrupt bytes");
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  assert.equal(h.controller.getSnapshot().capabilities.signOut, true);
  assert.equal(h.held, true);
  assert.equal((await h.controller.signOut()).ok, true);
  assert.equal(h.controller.getSnapshot().user, null);
  assert.equal(
    h.data.get(familyStorageKeys(h.family("A")).key),
    "corrupt bytes",
  );
  h.controller.dispose();
});
test("failed empty-wallet creation with missing readback cannot allow recovery sign-out or silently create another wallet", async () => {
  const h = harness();
  await h.controller.initialize();
  h.faults.write = true;
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(h.controller.getSnapshot().capabilities.signOut, false);
  h.faults.write = false;
  await h.controller.retry();
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(h.data.has(familyStorageKeys(h.family("A")).key), false);
  h.controller.dispose();
});
test("empty-wallet write-then-throw confirmed by core readback is safe to activate", async () => {
  const h = harness();
  await h.controller.initialize();
  h.faults.writeThenThrow = true;
  assert.equal(
    (await h.controller.signIn({ email: "a@example.test", password: "p" })).ok,
    true,
  );
  assert.equal(h.controller.getSnapshot().phase, "ready");
  assert.equal(h.target.ledger.transactions.length, 0);
  h.controller.dispose();
});
test("partial registration keeps account and separate pending name; retry never recreates account or implicitly updates profile", async () => {
  const h = harness();
  await h.controller.initialize();
  h.faults.profile = true;
  const value = await h.controller.register({
    email: "a@example.test",
    password: "p",
    displayName: "A name",
  });
  assert.equal(value.ok, false);
  assert.equal(value.pending, true);
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  assert.equal(h.controller.getSnapshot().profileNamePending, true);
  assert.match(value.message, /created/);
  h.faults.profile = false;
  await h.controller.retry();
  assert.equal(h.events.filter((x) => x === "register").length, 1);
  assert.equal(h.events.filter((x) => x === "profile").length, 1);
  assert.equal((await h.controller.updateDisplayName("A name")).ok, true);
  assert.equal(h.controller.getSnapshot().profileNamePending, false);
  h.controller.dispose();
});
test("optional profile storage failure remains distinct from confirmed account/name and cannot overwrite uncertain details", async () => {
  const h = harness();
  await h.controller.initialize();
  await h.controller.register({
    email: "a@example.test",
    password: "p",
    displayName: "A name",
  });
  h.faults.extrasWrite = true;
  const failed = await h.controller.saveProfileExtras({
    gender: "female",
    birthDate: null,
  });
  assert.equal(failed.ok, false);
  assert.equal(h.controller.getSnapshot().phase, "ready");
  assert.equal(h.controller.getSnapshot().user.displayName, "A name");
  h.faults.extrasWrite = false;
  assert.equal(
    (
      await h.controller.saveProfileExtras({
        gender: "female",
        birthDate: null,
      })
    ).ok,
    true,
  );
  const profileKey = h.profileForFamily(h.family("A")).key;
  h.data.set(profileKey, "malformed");
  await h.controller.retry();
  assert.equal(h.controller.getSnapshot().profileExtrasStatus, "unavailable");
  assert.equal(
    h.controller.getSnapshot().capabilities.saveProfileExtras,
    false,
  );
  assert.equal(h.data.get(profileKey), "malformed");
  h.controller.dispose();
});
test("invalid profile details stay a form failure without hiding a healthy financial wallet", async () => {
  const h = harness();
  await h.controller.initialize();
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  const value = await h.controller.saveProfileExtras({
    gender: "",
    birthDate: "2026-10-19",
  });
  assert.equal(value.ok, false);
  assert.equal(h.controller.getSnapshot().phase, "ready");
  assert.equal(h.held, false);
  h.controller.dispose();
});
test("failed owner activation remains blocked and cannot use wallet-unavailable sign-out shortcut", async () => {
  const h = harness();
  await h.controller.initialize();
  h.faults.activate = true;
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(h.controller.getSnapshot().capabilities.signOut, false);
  assert.equal(h.held, true);
  h.faults.activate = false;
  assert.equal((await h.controller.retry()).ok, true);
  h.controller.dispose();
});
test("Strict Mode replacement shares pending registration and does not publish into disposed observers", async () => {
  const h = harness();
  await h.controller.initialize();
  const waiting = deferred();
  h.setMutation(async () => {
    await waiting.promise;
    h.state.user = user("A");
  });
  let notifications = 0;
  h.controller.subscribe(() => notifications++);
  const pending = h.controller.register({
    email: "a@example.test",
    password: "p",
    displayName: "A",
  });
  await tick();
  h.controller.dispose();
  const count = notifications;
  const replacement = createAccountCoordinator(h.options);
  const duplicate = await replacement.register({
    email: "a@example.test",
    password: "p",
    displayName: "A",
  });
  assert.equal(duplicate.ok, false);
  waiting.resolve();
  assert.equal((await pending).ok, true);
  assert.equal(h.events.filter((x) => x === "register").length, 1);
  assert.equal(notifications, count);
  assert.equal(replacement.getSnapshot().user.uid, "A");
  replacement.dispose();
});
test("runtime rejects changed account/scope/adapters and stable getSnapshot changes only on publication", async () => {
  const h = harness();
  assert.equal(h.controller.getSnapshot(), h.controller.getSnapshot());
  assert.throws(() =>
    createAccountCoordinator({ ...h.options, scope: { kind: "canonical" } }),
  );
  assert.throws(() =>
    createAccountCoordinator({ ...h.options, financial: { ...h.financial } }),
  );
  h.controller.dispose();
});
test("external SDK identity guard blocks open edits before publication then activates allowed same-scope identity", async () => {
  const h = harness();
  await h.controller.initialize();
  h.faults.block = true;
  await assert.rejects(h.external(user("A")));
  assert.equal(h.state.user, null);
  assert.equal(h.controller.getSnapshot().phase, "ready");
  h.faults.block = false;
  await h.external(user("A"));
  await tick();
  await tick();
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  assert.equal(h.controller.getSnapshot().phase, "ready");
  h.controller.dispose();
});
test("identity changes during target activation cannot publish stale account wallet or release lease prematurely", async () => {
  const h = harness();
  await h.controller.initialize();
  const original = h.financial.activate;
  let change = true;
  h.financial.activate = async (...args) => {
    const result = await original(...args);
    if (change) {
      change = false;
      h.state.user = user("B");
    }
    return result;
  };
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().user.uid, "B");
  assert.equal(h.target.family.actor.uid, "B");
  assert.equal(h.held, false);
  h.controller.dispose();
});
test("unconfigured provider opens guest only without pretending account service was verified", async () => {
  const h = harness({ configured: false });
  assert.equal((await h.controller.initialize()).ok, true);
  assert.equal(h.controller.getSnapshot().provider, "unconfigured");
  assert.equal(h.controller.getSnapshot().service, "unchecked");
  assert.equal(h.controller.getSnapshot().capabilities.signIn, false);
  assert.ok(!h.events.includes("initialize"));
  h.controller.dispose();
});
test("cached account with confirmed persistence can open offline while exposing service unavailability", async () => {
  const h = harness();
  h.state.user = user("A");
  h.state.service = "unavailable";
  assert.equal((await h.controller.initialize()).ok, true);
  assert.equal(h.controller.getSnapshot().service, "unavailable");
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  h.controller.dispose();
});
test("a remounted idle handle masks the previous wallet before rechecking changed SDK identity", async () => {
  const h = harness();
  await h.controller.initialize();
  h.controller.dispose();
  h.state.user = user("A");
  const replacement = createAccountCoordinator(h.options);
  assert.equal(replacement.getSnapshot().phase, "restoring");
  assert.equal(replacement.getSnapshot().activeOwnerToken, null);
  assert.equal(replacement.getSnapshot().sessionRestored, false);
  await replacement.initialize();
  assert.equal(replacement.getSnapshot().user.uid, "A");
  replacement.dispose();
});
test("unrecoverable SDK persistence mismatch gives restart guidance with no misleading retry capability", async () => {
  const h = harness();
  h.state.persistence = "unconfirmed";
  h.state.recovery = "restart";
  const value = await h.controller.initialize();
  assert.match(value.message, /Restart the app/);
  assert.equal(h.controller.getSnapshot().recovery, "restart");
  assert.equal(h.controller.getSnapshot().capabilities.retry, false);
  assert.equal(h.data.size, 0);
  assert.equal(h.held, true);
  h.controller.dispose();
});
test("late-confirmed registration retains pending display-name intent without replaying either mutation", async () => {
  const h = harness();
  await h.controller.initialize();
  h.setMutation(async () => {
    h.state.user = user("A");
    h.state.persistence = "unconfirmed";
  });
  await h.controller.register({
    email: "a@example.test",
    password: "p",
    displayName: "Pending name",
  });
  h.state.persistence = "confirmed";
  await h.controller.retry();
  assert.equal(h.controller.getSnapshot().profileNamePending, true);
  assert.equal(h.events.filter((x) => x === "register").length, 1);
  assert.equal(h.events.filter((x) => x === "profile").length, 0);
  assert.ok(
    !JSON.stringify(h.controller.getSnapshot()).includes("Pending name"),
  );
  h.controller.dispose();
});
test("failed old-owner compensation holds the gate for repair rather than silently resuming financial access", async () => {
  const h = harness();
  await h.controller.initialize();
  h.faults.resume = true;
  h.setMutation(async () => {
    throw { code: "auth/wrong-password" };
  });
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(h.held, true);
  assert.equal(h.controller.getSnapshot().activeOwnerToken, null);
  h.faults.resume = false;
  assert.equal((await h.controller.retry()).ok, true);
  assert.equal(h.held, false);
  h.controller.dispose();
});
test("slow old-owner drain freezes access before SDK mutation and repeated submissions cannot overtake it", async () => {
  const h = harness();
  await h.controller.initialize();
  const drain = deferred(),
    entered = deferred(),
    prepare = h.financial.prepareIdentityChange;
  h.financial.prepareIdentityChange = async (context) => {
    const value = await prepare(context);
    entered.resolve();
    await drain.promise;
    return value;
  };
  const first = h.controller.signIn({ email: "a@example.test", password: "p" });
  await entered.promise;
  assert.equal(h.held, true);
  assert.ok(!h.events.includes("sign-in"));
  assert.equal(
    (
      await h.controller.register({
        email: "b@example.test",
        password: "p",
        displayName: "B",
      })
    ).ok,
    false,
  );
  drain.resolve();
  assert.equal((await first).ok, true);
  assert.equal(h.events.filter((x) => x === "sign-in").length, 1);
  assert.ok(!h.events.includes("register"));
  h.controller.dispose();
});
test("an SDK confirmation failure after local profile save freezes financial access before exposing uncertainty", async () => {
  const h = harness();
  await h.controller.initialize();
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  h.auth.confirmIdentity = async () => {
    throw new Error("private SDK payload");
  };
  const value = await h.controller.saveProfileExtras({
    gender: "",
    birthDate: null,
  });
  assert.equal(value.ok, false);
  assert.equal(h.controller.getSnapshot().phase, "session-unavailable");
  assert.equal(h.held, true);
  assert.ok(
    !JSON.stringify(h.controller.getSnapshot()).includes("private SDK"),
  );
  h.controller.dispose();
});
test("uncertain optional profile save disables overwrites until a read-only recheck recovers the actual fields", async () => {
  const h = harness();
  await h.controller.initialize();
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  const originalWrite = h.adapter.setItem,
    originalRead = h.adapter.getItem;
  let profileReadFail = true;
  h.adapter.setItem = async (key, raw) => {
    await originalWrite(key, raw);
    if (key.startsWith("@mymoney/account-profile/"))
      throw new Error("write after effect");
  };
  h.adapter.getItem = async (key) => {
    if (profileReadFail && key.startsWith("@mymoney/account-profile/"))
      throw new Error("read failed");
    return originalRead(key);
  };
  const value = await h.controller.saveProfileExtras({
    gender: "male",
    birthDate: null,
  });
  assert.equal(value.pending, true);
  assert.equal(h.controller.getSnapshot().phase, "ready");
  assert.equal(h.controller.getSnapshot().profileExtrasStatus, "uncertain");
  assert.equal(
    h.controller.getSnapshot().capabilities.saveProfileExtras,
    false,
  );
  profileReadFail = false;
  await h.controller.retry();
  assert.equal(h.controller.getSnapshot().profileExtras.gender, "male");
  assert.equal(h.controller.getSnapshot().capabilities.saveProfileExtras, true);
  h.controller.dispose();
});
test("misbound injected wallet/profile storage cannot expose another actor under the requested header", async () => {
  const h = harness();
  const wrongStorage = h.storageForFamily(h.family("B"));
  await wrongStorage.save(
    model.createEmptyLedger({ name: "B private" }, h.options.identityContext),
  );
  h.controller.dispose();
  const controller = createAccountCoordinator({
    ...h.options,
    runtime: {},
    storageForFamily: () => wrongStorage,
  });
  h.state.user = user("A");
  await controller.initialize();
  assert.equal(controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(controller.getSnapshot().activeOwnerToken, null);
  assert.equal(h.target, null);
  controller.dispose();
});
test("preflight detects externally changed identity and never reports an unexecuted sign-in as successful", async () => {
  const h = harness();
  await h.controller.initialize();
  h.state.user = user("B");
  const value = await h.controller.signIn({
    email: "a@example.test",
    password: "p",
  });
  assert.equal(value.ok, false);
  assert.ok(!h.events.includes("sign-in"));
  assert.equal(h.controller.getSnapshot().user.uid, "B");
  h.controller.dispose();
});
test("confirmed same-account fresh-wallet observation updates owner token without rewriting other families", async () => {
  const h = harness();
  await h.controller.initialize();
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  const before = h.controller.getSnapshot().activeOwnerToken;
  const reset = model.createEmptyLedger(
    { name: "Fresh A" },
    {
      ...h.options.identityContext,
      newIncarnationId: () => "fresh-a-incarnation",
    },
  );
  await h.target.storage.save(reset);
  const saved = [...h.data.entries()];
  assert.equal(h.controller.observeCommittedWallet(h.family("A"), reset), true);
  assert.notEqual(h.controller.getSnapshot().activeOwnerToken, before);
  assert.deepEqual([...h.data.entries()], saved);
  assert.equal(
    h.controller.observeCommittedWallet(h.family("B"), reset),
    false,
  );
  await h.controller.updateDisplayName("A renamed");
  assert.equal(h.target.owner.incarnationId, "fresh-a-incarnation");
  h.controller.dispose();
});

test("restore-time achievement reconciliation returns a same-owner durable ledger confirmed against its actual family store", async () => {
  const h = harness();
  h.state.user = user("A");
  let saved = model.createEmptyLedger({}, h.options.identityContext);
  saved = model.saveTransaction(saved, {
    id: "recorded-income",
    walletId: saved.wallet.id,
    type: "income",
    title: "Synthetic income",
    categoryId: "income-salary",
    date: "2026-10-18",
    amountMinor: 1000000,
  });
  await h.storageForFamily(h.family("A")).save(saved);
  const activate = h.financial.activate;
  let reconciliation;
  h.financial.activate = async (lease, target, isCurrent) => {
    reconciliation = reconcileAchievements(
      target.ledger,
      h.options.identityContext.clock,
    );
    assert.equal(reconciliation.changed, true);
    const committed = await commitLedger({
      current: target.ledger,
      next: reconciliation.ledger,
      storage: target.storage,
    });
    assert.equal(committed.ok, true);
    const activated = await activate(
      lease,
      { ...target, ledger: committed.ledger },
      isCurrent,
    );
    return { ...activated, durableLedger: committed.ledger };
  };
  assert.equal((await h.controller.initialize()).ok, true);
  assert.deepEqual(
    await h.storageForFamily(h.family("A")).readCurrent(),
    reconciliation.ledger,
  );
  assert.equal(h.held, false);
  h.controller.dispose();
});

test("a returned ledger from another family with coincident incarnation is rejected by exact active-family readback", async () => {
  const h = harness();
  await h.controller.initialize();
  const other = model.createEmptyLedger(
    { name: "B only" },
    h.options.identityContext,
  );
  await h.storageForFamily(h.family("B")).save(other);
  h.financial.activate = async () => ({
    ok: true,
    pending: false,
    message: "ready",
    durableLedger: other,
  });
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(h.controller.getSnapshot().activeOwnerToken, null);
  assert.equal(h.held, true);
  assert.equal(h.controller.getSnapshot().capabilities.signOut, false);
  assert.equal(
    (await h.storageForFamily(h.family("A")).readCurrent()).wallet.name,
    "My wallet",
  );
  h.controller.dispose();
});

test("restore-time unknown financial write makes retries active-key-only and cannot reseed or use the recovery sign-out shortcut", async () => {
  const h = harness();
  await h.controller.initialize();
  const activate = h.financial.activate;
  let unknown = true,
    calls = 0;
  h.financial.activate = async (lease, target, isCurrent) => {
    calls++;
    if (unknown) {
      h.data.delete(target.storage.key);
      return {
        ok: false,
        pending: true,
        message: "Unknown financial outcome",
        walletWriteUnconfirmed: true,
      };
    }
    return activate(lease, target, isCurrent);
  };
  await h.controller.signIn({ email: "a@example.test", password: "p" });
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  assert.equal(h.controller.getSnapshot().capabilities.signOut, false);
  const initialCalls = calls;
  await assert.rejects(h.external(user("B")), /not settled/);
  assert.equal(h.state.user.uid, "A");
  unknown = false;
  await h.controller.retry();
  assert.equal(calls, initialCalls);
  assert.equal(await h.storageForFamily(h.family("A")).readCurrent(), null);
  assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
  await h
    .storageForFamily(h.family("A"))
    .save(
      model.createEmptyLedger(
        { name: "Recovered A" },
        h.options.identityContext,
      ),
    );
  assert.equal((await h.controller.retry()).ok, true);
  assert.equal(h.target.ledger.wallet.name, "Recovered A");
  h.controller.dispose();
});

test("an external SDK identity cannot publish while target achievement activation is still writing under a held lease", async () => {
  const h = harness();
  await h.controller.initialize();
  const entered = deferred(),
    finished = deferred(),
    activate = h.financial.activate;
  h.financial.activate = async (lease, target, isCurrent) => {
    h.faults.leaseUnready = true;
    entered.resolve();
    await finished.promise;
    h.faults.leaseUnready = false;
    return activate(lease, target, isCurrent);
  };
  const signIn = h.controller.signIn({
    email: "a@example.test",
    password: "p",
  });
  await entered.promise;
  await assert.rejects(h.external(user("B")), /not settled/);
  assert.equal(h.state.user.uid, "A");
  assert.equal(h.held, true);
  assert.equal(h.controller.getSnapshot().activeOwnerToken, null);
  finished.resolve();
  assert.equal((await signIn).ok, true);
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  assert.equal(h.events.filter((x) => x === "sign-in").length, 1);
  h.controller.dispose();
});

test("coordinator-owned initial wallet writes also block external SDK publication even when the hook readiness signal is true", async () => {
  const h = harness();
  await h.controller.initialize();
  const entered = deferred(),
    finish = deferred(),
    set = h.adapter.setItem;
  const accountKey = familyStorageKeys(h.family("A")).key;
  h.adapter.setItem = async (key, value) => {
    if (key === accountKey) {
      entered.resolve();
      await finish.promise;
    }
    return set(key, value);
  };
  const signIn = h.controller.signIn({
    email: "a@example.test",
    password: "p",
  });
  await entered.promise;
  assert.equal(h.financial.isIdentityLeaseReady({}), true);
  await assert.rejects(h.external(user("B")), /not settled/);
  assert.equal(h.state.user.uid, "A");
  finish.resolve();
  assert.equal((await signIn).ok, true);
  assert.equal(h.controller.getSnapshot().user.uid, "A");
  h.controller.dispose();
});

test("existing lease readiness is rechecked before SDK mutation and after uncertain activation without replaying requests", async () => {
  const h = harness();
  await h.controller.initialize();
  const prepare = h.financial.prepareIdentityChange;
  h.financial.prepareIdentityChange = async (context) => {
    const result = await prepare(context);
    h.faults.leaseUnready = true;
    return result;
  };
  const blocked = await h.controller.register({
    email: "a@example.test",
    password: "p",
    displayName: "A",
  });
  assert.equal(blocked.ok, false);
  assert.ok(!h.events.includes("register"));
  assert.equal(h.held, true);
  assert.equal(h.controller.getSnapshot().capabilities.signOut, false);
  await assert.rejects(h.external(user("B")), /not settled/);
  assert.equal(h.state.user, null);
  h.faults.leaseUnready = false;
  assert.equal((await h.controller.retry()).ok, true);
  assert.ok(!h.events.includes("register"));
  assert.equal(h.controller.getSnapshot().user, null);
  h.controller.dispose();
});

test("activation cannot silently change incarnation or contradict an unconfirmed-write flag with ok:true", async () => {
  for (const mode of ["incarnation", "contradiction"]) {
    const h = harness();
    await h.controller.initialize();
    h.financial.activate = async (lease, target) => {
      if (mode === "contradiction")
        return {
          ok: true,
          pending: false,
          message: "ready",
          walletWriteUnconfirmed: true,
        };
      const changed = model.createEmptyLedger(
        {},
        {
          ...h.options.identityContext,
          newIncarnationId: () => "unexpected-reset",
        },
      );
      await target.storage.save(changed);
      return {
        ok: true,
        pending: false,
        message: "ready",
        durableLedger: changed,
      };
    };
    await h.controller.signIn({ email: "a@example.test", password: "p" });
    assert.equal(h.controller.getSnapshot().phase, "wallet-unavailable");
    assert.equal(h.controller.getSnapshot().activeOwnerToken, null);
    assert.equal(h.held, true);
    h.controller.dispose();
  }
});

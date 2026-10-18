const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../src/core/model");
const {
  STORAGE_KEY,
  MIGRATION_STORAGE_KEYS,
} = require("../src/core/storage");
const { commitLedger } = require("../src/core/commitLedger");
const {
  encodeDataFamily,
  encodeDataScope,
  normalizeCredentials,
  projectAccountUser,
} = require("../src/accounts/identity");
const {
  createFamilyLedgerStorage,
  familyStorageKeys,
} = require("../src/accounts/familyStorage");
const { createProfileStore, validateProfileExtras } = require("../src/accounts/profileStore");
const scope = { kind: "test", namespace: "account-stage" };
const family = (uid) => ({ scope, actor: { kind: "firebase", uid } });
const identity = {
  clock: { today: "2026-10-18", nowMs: 1792281600000 },
  newIncarnationId: () => "same-wallet-incarnation",
};
const fresh = () =>
  model.createEmptyLedger(
    { name: "Independent wallet", currency: "MYR" },
    identity,
  );
function memory() {
  const data = new Map();
  return {
    data,
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
  };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("tagged family/scope encoding distinguishes guest, UID and hostile namespace combinations", () => {
  const values = [
    { scope: { kind: "canonical" }, actor: { kind: "local" } },
    {
      scope: { kind: "test", namespace: "canonical" },
      actor: { kind: "local" },
    },
    family("local"),
    family("a/b"),
    family("a%2Fb"),
    {
      scope: { kind: "test", namespace: "account-stage/firebase/a" },
      actor: { kind: "local" },
    },
  ];
  assert.equal(new Set(values.map(encodeDataFamily)).size, values.length);
  assert.equal(
    new Set(values.map((x) => familyStorageKeys(x).key)).size,
    values.length,
  );
  assert.notEqual(
    encodeDataScope(scope),
    encodeDataScope({ kind: "canonical" }),
  );
  for (const value of [
    { scope: { kind: "canonical", namespace: "x" }, actor: { kind: "local" } },
    { scope, actor: { kind: "firebase", uid: "" } },
    { scope, actor: { kind: "local", uid: "x" } },
    { ...family("a"), extra: true },
  ])
    assert.throws(() => encodeDataFamily(value));
});
test("guest key and ordered legacy migration are unchanged; account opening never reads guest bytes", async () => {
  const adapter = memory(),
    guest = { scope: { kind: "canonical" }, actor: { kind: "local" } };
  assert.deepEqual(familyStorageKeys(guest), {
    key: STORAGE_KEY,
    legacyKeys: [...MIGRATION_STORAGE_KEYS],
  });
  const v4 = { ...fresh(), version: 4 },
    old = JSON.stringify(v4);
  adapter.data.set(MIGRATION_STORAGE_KEYS[0], old);
  const migrated = await createFamilyLedgerStorage(adapter, guest, {
    identityContext: identity,
  }).load();
  assert.equal(migrated.version, 5);
  assert.equal(adapter.data.get(MIGRATION_STORAGE_KEYS[0]), old);
  const guestBytes = adapter.data.get(STORAGE_KEY),
    account = createFamilyLedgerStorage(adapter, family("A"));
  assert.equal(await account.load(), null);
  await account.save(fresh());
  assert.equal(adapter.data.get(STORAGE_KEY), guestBytes);
  assert.equal(adapter.data.get(MIGRATION_STORAGE_KEYS[0]), old);
  assert.deepEqual(familyStorageKeys({ scope, actor: { kind: "local" } }), {
    key: "@mymoney/test/account-stage/v5",
    legacyKeys: [4, 3, 2, 1].map((v) => `@mymoney/test/account-stage/v${v}`),
  });
});
test("account envelope enforces exact version/family and missing differs from corrupt or foreign bytes", async () => {
  const adapter = memory(),
    a = createFamilyLedgerStorage(adapter, family("A")),
    b = createFamilyLedgerStorage(adapter, family("B"));
  await a.save(fresh());
  assert.equal(await b.load(), null);
  const raw = adapter.data.get(a.key),
    saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved), ["version", "family", "ledger"]);
  assert.equal(saved.ledger.wallet.incarnationId, "same-wallet-incarnation");
  for (const bad of [
    raw.replace('"uid":"A"', '"uid":"B"'),
    "{broken",
    JSON.stringify({ ...saved, version: 2 }),
    JSON.stringify({ ...saved, token: "synthetic-canary" }),
    JSON.stringify({ ...saved, ledger: { ...saved.ledger, version: 999 } }),
  ]) {
    adapter.data.set(a.key, bad);
    await assert.rejects(a.load());
    await assert.rejects(a.readCurrent());
    assert.equal(adapter.data.get(a.key), bad);
  }
});
test("account round trip preserves full v5 financial/context/achievement state and arbitrary financial extension fields", async () => {
  const adapter = memory(),
    storage = createFamilyLedgerStorage(adapter, family("A"));
  let ledger = model.createDemoLedger(
    new Date("2026-10-18T12:00:00Z"),
    identity,
  );
  ledger = model.saveTransaction(
    ledger,
    model.patchTransactionContext(
      ledger.transactions[0],
      {
        notes: "Local note",
        withPerson: { name: "Selected person", source: "manual" },
        location: { label: "Selected place", source: "manual" },
      },
      ledger,
    ),
    true,
  );
  ledger = model.saveBudget(
    ledger,
    model.budgetFromDraft(
      {
        categoryId: "expense-food",
        amount: "100",
        period: "month",
        anchorDate: "2026-10-18",
      },
      "budget-1",
      ledger,
    ),
  );
  ledger = model.saveGoal(
    ledger,
    model.goalFromDraft(
      { kind: "emergencyFund", amount: "4000" },
      "goal-1",
      ledger,
    ),
  );
  ledger.futureExtension = { safe: "preserve" };
  await storage.save(ledger);
  assert.deepEqual(await storage.readCurrent(), ledger);
  assert.deepEqual(await storage.load(), ledger);
});
test("real core commitLedger confirms account write-then-throw and blocks unreadable ambiguous saves", async () => {
  const adapter = memory(),
    storage = createFamilyLedgerStorage(adapter, family("A"));
  const original = fresh();
  await storage.save(original);
  const next = model.updateWallet(original, { name: "Changed wallet" });
  const write = adapter.setItem;
  adapter.setItem = async (key, value) => {
    await write(key, value);
    throw new Error("synthetic write failure");
  };
  const confirmed = await commitLedger({ current: original, next, storage });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.ledger.wallet.name, "Changed wallet");
  adapter.getItem = async () => {
    throw new Error("synthetic read failure");
  };
  const uncertain = await commitLedger({
    current: next,
    next: model.updateWallet(next, { name: "Unknown wallet" }),
    storage,
  });
  assert.equal(uncertain.blocked, true);
  assert.equal(uncertain.ok, false);
});
test("account photo reference inspection uses real shared queue and cannot scan another UID", async () => {
  const adapter = memory(),
    a = createFamilyLedgerStorage(adapter, family("A")),
    anotherA = createFamilyLedgerStorage(adapter, family("A")),
    b = createFamilyLedgerStorage(adapter, family("B"));
  let ledger = model.createDemoLedger(
    new Date("2026-10-18T12:00:00Z"),
    identity,
  );
  const photo = {
    id: "photo-test",
    ownerIncarnationId: ledger.wallet.incarnationId,
    fileName: "photo-test.png",
    mimeType: "image/png",
    width: 10,
    height: 10,
    byteSize: 100,
  };
  ledger = model.saveTransaction(
    ledger,
    model.patchTransactionContext(ledger.transactions[0], { photo }, ledger),
    true,
  );
  await a.save(ledger);
  await b.save(fresh());
  const entered = deferred(),
    release = deferred();
  let finished = false;
  const scan = a.withRetainedPhotoReferences(async (snapshot) => {
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.references, [photo]);
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const write = anotherA.save(fresh()).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(
    await b.withRetainedPhotoReferences(async (s) => s.references),
    [],
  );
  release.resolve();
  await scan;
  await write;
  assert.equal(finished, true);
});
test("corrupt account envelope retains photos through incomplete reference result", async () => {
  const adapter = memory(),
    a = createFamilyLedgerStorage(adapter, family("A"));
  adapter.data.set(a.key, "broken");
  const refs = await a.withRetainedPhotoReferences(async (value) => value);
  assert.equal(refs.complete, false);
});
test("profile optional values have no invented birthday and exact local owner/date checks", async () => {
  const adapter = memory(),
    store = createProfileStore(adapter, family("A"), () => "2026-10-18");
  assert.equal(await store.load(), null);
  assert.equal((await store.save({ gender: "", birthDate: null })).ok, true);
  assert.deepEqual(await store.load(), { gender: "", birthDate: null });
  for (const extras of [
    { gender: "female", birthDate: "2026-10-19" },
    { gender: "male", birthDate: "2025-02-29" },
    { gender: "unknown", birthDate: null },
    { gender: "", birthDate: null, uid: "x" },
  ])
    assert.throws(() => validateProfileExtras(extras, "2026-10-18"));
  assert.deepEqual(
    validateProfileExtras(
      { gender: "nonbinary", birthDate: "2024-02-29" },
      "2026-10-18",
    ),
    { gender: "nonbinary", birthDate: "2024-02-29" },
  );
  const saved = JSON.parse(adapter.data.get(store.key));
  adapter.data.set(
    store.key,
    JSON.stringify({ ...saved, family: family("B") }),
  );
  await assert.rejects(store.load());
});
test("profile write-then-throw confirms readback; mismatch and unreadable remain truthful", async () => {
  const adapter = memory(),
    store = createProfileStore(adapter, family("A"), () => "2026-10-18");
  const write = adapter.setItem;
  adapter.setItem = async (k, v) => {
    await write(k, v);
    throw new Error("synthetic");
  };
  assert.equal(
    (await store.save({ gender: "female", birthDate: null })).ok,
    true,
  );
  adapter.setItem = async () => {
    throw new Error("synthetic");
  };
  const mismatch = await store.save({ gender: "male", birthDate: null });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.pending, false);
  assert.equal(mismatch.extras.gender, "female");
  adapter.getItem = async () => {
    throw new Error("synthetic");
  };
  assert.equal(
    (await store.save({ gender: "male", birthDate: null })).pending,
    true,
  );
});
test("identity projection excludes SDK token fields and preserves password whitespace", () => {
  assert.deepEqual(
    projectAccountUser({
      uid: "A",
      email: "a@example.test",
      displayName: null,
      stsTokenManager: { accessToken: "synthetic-secret" },
    }),
    { uid: "A", email: "a@example.test", displayName: null },
  );
  assert.deepEqual(
    normalizeCredentials({
      email: " a@example.test ",
      password: " spaces preserved ",
    }),
    { email: "a@example.test", password: " spaces preserved " },
  );
});

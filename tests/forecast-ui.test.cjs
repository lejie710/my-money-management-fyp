const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const {
  createHookHost,
  loadTsSource,
} = require("./helpers/hook-host.cjs");
const model = require("../src/core/model"),
  forecast = require("../src/core/forecast");
function hostWithMemo() {
  const host = createHookHost();
  host.react.useMemo = (factory, deps) => {
    const value = host.react.useRef(null);
    if (
      !value.current ||
      deps.some((item, index) => !Object.is(item, value.current.deps[index]))
    )
      value.current = { deps, value: factory() };
    return value.current.value;
  };
  return host;
}
function find(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (typeof tree.type === "function")
    return find(tree.type(tree.props), predicate);
  if (predicate(tree)) return tree;
  for (const child of (tree.props?.children ?? []).flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
function all(tree, predicate, result = []) {
  if (!tree || typeof tree !== "object") return result;
  if (typeof tree.type === "function")
    return all(tree.type(tree.props), predicate, result);
  if (predicate(tree)) result.push(tree);
  for (const child of (tree.props?.children ?? []).flat(Infinity))
    all(child, predicate, result);
  return result;
}
function text(tree) {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (!tree || typeof tree !== "object") return "";
  if (typeof tree.type === "function") return text(tree.type(tree.props));
  return (tree.props?.children ?? []).flat(Infinity).map(text).join("");
}
const byId = (tree, id) =>
  find(tree, (element) => element.props?.testID === id);
function monthAt(offset) {
  const n = 2025 * 12 + 3 + offset;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
}
function ledger(
  values = Array.from({ length: 18 }, (_, i) => 10000 + i * 1000),
  currency = "MYR",
) {
  let result = model.createEmptyLedger(
    { name: "Forecast test wallet", currency },
    {
      clock: { today: "2025-04-01", nowMs: Date.parse("2025-04-01T12:00:00Z") },
      newIncarnationId: () => "forecast-ui-wallet",
    },
  );
  values.forEach((amount, i) => {
    if (amount)
      result = model.saveTransaction(result, {
        id: `expense-${i}`,
        walletId: result.wallet.id,
        type: "expense",
        title: "Recorded purchase",
        categoryId: "expense-food",
        date: `${monthAt(i)}-15`,
        amountMinor: amount,
      });
  });
  return result;
}
function add(ledger, id, type, date, amountMinor, categoryId) {
  return model.saveTransaction(ledger, {
    id,
    walletId: ledger.wallet.id,
    type,
    date,
    amountMinor,
    categoryId:
      categoryId ??
      { expense: "expense-food", income: "income-salary", debt: "debt-loan" }[
        type
      ],
    title: id,
  });
}
function fixture(source = ledger(), date = "2026-10-18") {
  const host = hostWithMemo();
  let current = source,
    closed = 0,
    dismissed = 0;
  const imports = {
    react: host.react,
    "react-native": {
      Keyboard: {
        dismiss() {
          dismissed++;
        },
      },
      StyleSheet: { create: (value) => value },
      Text: "Text",
      View: "View",
    },
    "../core/model": model,
    "../core/forecast": forecast,
    "./components": {
      Action: "Action",
      Choice: "Choice",
      Field: "Field",
      FormError: "FormError",
      Sheet: "Sheet",
    },
    "./theme": { colors: {}, ui: {} },
  };
  const module = loadTsSource(
    path.join(__dirname, "../src/ui/ForecastSheet.tsx"),
    imports,
  );
  return {
    host,
    get ledger() {
      return current;
    },
    setLedger(value) {
      current = value;
    },
    get dismissed() {
      return dismissed;
    },
    get closed() {
      return closed;
    },
    render() {
      return host.render(() =>
        module.ForecastSheet({
          ledger: current,
          initialAsOfDate: date,
          onClose() {
            closed++;
          },
        }),
      );
    },
  };
}
const futureValues = (tree) =>
  all(tree, (element) =>
    /^forecast-future-\d/.test(element.props?.testID ?? ""),
  ).map((element) => [element.props.testID, text(element)]);

test("Reports entry opens explicitly with captured clock date and its outer key is the complete owner token", () => {
  const host = hostWithMemo(),
    module = loadTsSource(path.join(__dirname, "../src/ui/ForecastEntry.tsx"), {
      react: host.react,
      "react-native": { Text: "Text", View: "View" },
      "../core/model": model,
      "./components": { Action: "Action", FormError: "FormError" },
      "./ForecastSheet": { ForecastSheet: "ForecastSheet" },
      "./theme": { ui: {} },
    });
  const props = {
    ledger: ledger(),
    ownerKey: "canonical/firebase/A/incarnation-1",
    getToday: () => "2026-10-18",
  };
  assert.equal(module.ForecastEntry(props).props.key, props.ownerKey);
  assert.notEqual(
    module.ForecastEntry({
      ...props,
      ownerKey: "canonical/firebase/B/incarnation-1",
    }).props.key,
    props.ownerKey,
  );
  const render = () => host.render(() => module.ForecastEntryContent(props));
  let tree = render();
  assert.equal(
    find(tree, (e) => e.type === "ForecastSheet"),
    null,
  );
  byId(tree, "open-expense-forecast").props.onPress();
  tree = render();
  const sheet = find(tree, (e) => e.type === "ForecastSheet");
  assert.equal(sheet.props.initialAsOfDate, "2026-10-18");
  sheet.props.onClose();
  assert.equal(
    find(render(), (e) => e.type === "ForecastSheet"),
    null,
  );
});
test("rising fixture shows six strict future months, correct selected method/MAEs and12 two-month-ahead folds", () => {
  const f = fixture(),
    tree = f.render();
  assert.deepEqual(
    futureValues(tree).map((row) => row[0]),
    ["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"].map(
      (month) => `forecast-future-${month}`,
    ),
  );
  assert.deepEqual(
    futureValues(tree).map((row) => row[1]),
    [28440, 28952, 29362, 29689, 29951, 30161].map((value) =>
      model.formatMoney(value, "MYR"),
    ),
  );
  assert.match(text(byId(tree, "forecast-method")), /Damped/i);
  assert.equal(
    text(byId(tree, "forecast-selected-mae")),
    model.formatMoney(560, "MYR"),
  );
  assert.equal(
    text(byId(tree, "forecast-baseline-mae")),
    model.formatMoney(2000, "MYR"),
  );
  assert.match(
    text(byId(tree, "forecast-backtest-range")),
    /Two-month-ahead MAE · 12 evaluation folds/,
  );
  assert.match(text(byId(tree, "forecast-training-cutoff")), /2026-09-30/);
  assert.match(text(byId(tree, "forecast-gap-explanation")), /October 2026/);
  assert.equal(byId(tree, "forecast-future-2026-10"), null);
});
test("short history and sparse history show actual availability counts without fabricated predictions", () => {
  const short = fixture(ledger([10000, 11000]), "2025-06-18").render();
  assert.ok(byId(short, "forecast-insufficient"));
  assert.match(
    text(byId(short, "forecast-history-counts")),
    /2 completed history months; 2 months/,
  );
  assert.equal(futureValues(short).length, 0);
  const sparse = fixture(
    ledger([10000, 0, 0, 0, 10000, 0, 0, 0]),
    "2025-12-18",
  ).render();
  assert.ok(byId(sparse, "forecast-insufficient"));
  assert.match(
    text(byId(sparse, "forecast-history-counts")),
    /8 completed history months; 2 months/,
  );
  assert.equal(futureValues(sparse).length, 0);
});
test("empty expense history is distinct from recorded income and no earlier months are invented", () => {
  let source = ledger([]);
  source = add(source, "only-income", "income", "2025-04-10", 999999);
  const tree = fixture(source).render();
  assert.ok(byId(tree, "forecast-history-empty"));
  assert.match(
    text(byId(tree, "forecast-history-counts")),
    /0 completed history months; 0 months/,
  );
  assert.match(
    text(byId(tree, "forecast-insufficient")),
    /Income records do not make expense history sufficient/,
  );
});
test("partial and future amounts are excluded from projections while partial recorded totals remain visible", () => {
  let source = ledger();
  const expected = futureValues(fixture(source).render());
  source = add(source, "partial", "expense", "2026-10-17", 900000);
  source = add(source, "after-asof", "expense", "2026-10-20", 700000);
  source = add(source, "future", "expense", "2026-11-05", 800000);
  source = add(source, "debt", "debt", "2026-10-01", 600000);
  const tree = fixture(source).render();
  assert.deepEqual(futureValues(tree), expected);
  assert.equal(
    text(byId(tree, "forecast-partial-amount")),
    model.formatMoney(900000, "MYR"),
  );
});
test("invalid date draft retains old result and recovery applies only after explicit valid Apply", () => {
  const f = fixture();
  let tree = f.render();
  const before = futureValues(tree);
  byId(tree, "forecast-as-of-input").props.onChangeText("2026-02-30");
  tree = f.render();
  assert.ok(byId(tree, "forecast-draft-pending"));
  byId(tree, "forecast-apply").props.onPress();
  tree = f.render();
  assert.ok(byId(tree, "forecast-error").props.message);
  assert.deepEqual(futureValues(tree), before);
  assert.match(text(byId(tree, "forecast-applied-selection")), /2026-10-18/);
  byId(tree, "forecast-as-of-input").props.onChangeText("2026-11-18");
  byId(f.render(), "forecast-apply").props.onPress();
  tree = f.render();
  assert.match(text(byId(tree, "forecast-applied-selection")), /2026-11-18/);
  assert.equal(futureValues(tree)[0][0], "forecast-future-2026-12");
  assert.equal(f.dismissed, 1);
});
test("category drafts do not relabel the old snapshot; every displayed section changes together on Apply", () => {
  let source = ledger();
  source = model.createCategory(source, {
    id: "expense-receipts",
    name: "Receipt purchases",
    type: "expense",
  });
  for (let i = 0; i < 18; i++)
    source = add(
      source,
      `receipt-${i}`,
      "expense",
      `${monthAt(i)}-18`,
      20000,
      "expense-receipts",
    );
  const f = fixture(source);
  let tree = f.render();
  const old = futureValues(tree);
  byId(tree, "forecast-category-search").props.onChangeText("Receipt");
  tree = f.render();
  byId(tree, "forecast-category-expense-receipts").props.onPress();
  tree = f.render();
  assert.deepEqual(futureValues(tree), old);
  assert.match(
    text(byId(tree, "forecast-applied-selection")),
    /All expense categories/,
  );
  byId(tree, "forecast-apply").props.onPress();
  tree = f.render();
  assert.match(
    text(byId(tree, "forecast-applied-selection")),
    /Receipt purchases/,
  );
  assert.ok(
    futureValues(tree).every(
      (row) => row[1] === model.formatMoney(20000, "MYR"),
    ),
  );
  assert.match(
    text(byId(tree, "forecast-history-counts")),
    /18 completed history months; 18 months/,
  );
});
test("record edits keep the captured result until Refresh applied forecast; unapplied date drafts survive refresh", () => {
  const f = fixture();
  let tree = f.render();
  const old = futureValues(tree);
  const edited = { ...f.ledger.transactions[17], amountMinor: 50000 };
  f.setLedger(model.saveTransaction(f.ledger, edited, true));
  tree = f.render();
  assert.ok(byId(tree, "forecast-source-changed"));
  assert.deepEqual(futureValues(tree), old);
  byId(tree, "forecast-as-of-input").props.onChangeText("invalid");
  byId(f.render(), "forecast-refresh").props.onPress();
  tree = f.render();
  assert.notDeepEqual(futureValues(tree), old);
  assert.equal(byId(tree, "forecast-as-of-input").props.value, "invalid");
  assert.match(text(byId(tree, "forecast-applied-selection")), /2026-10-18/);
  assert.equal(byId(tree, "forecast-source-changed"), null);
  assert.ok(byId(tree, "forecast-draft-pending"));
});
test("a category rename updates result labels only after refresh, using the same stable ID", () => {
  const f = fixture();
  let tree = f.render();
  byId(tree, "forecast-category-expense-food").props.onPress();
  byId(f.render(), "forecast-apply").props.onPress();
  const old = futureValues(f.render());
  f.setLedger(
    model.renameCategory(f.ledger, "expense-food", "Renamed groceries"),
  );
  tree = f.render();
  assert.ok(byId(tree, "forecast-source-changed"));
  assert.doesNotMatch(
    text(byId(tree, "forecast-applied-selection")),
    /Renamed/,
  );
  byId(tree, "forecast-refresh").props.onPress();
  tree = f.render();
  assert.match(
    text(byId(tree, "forecast-applied-selection")),
    /Renamed groceries/,
  );
  assert.deepEqual(futureValues(tree), old);
});
test("removed unused selected category is explicit and refresh failure retains its old labelled result", () => {
  let source = model.createCategory(ledger(), {
    id: "expense-unused",
    name: "Unused category",
    type: "expense",
  });
  const f = fixture(source);
  let tree = f.render();
  byId(tree, "forecast-category-search").props.onChangeText("Unused");
  byId(f.render(), "forecast-category-expense-unused").props.onPress();
  byId(f.render(), "forecast-apply").props.onPress();
  f.setLedger(model.deleteCategory(f.ledger, "expense-unused"));
  tree = f.render();
  assert.ok(byId(tree, "forecast-category-removed"));
  byId(tree, "forecast-refresh").props.onPress();
  tree = f.render();
  assert.ok(byId(tree, "forecast-error").props.message);
  assert.match(
    text(byId(tree, "forecast-applied-selection")),
    /Unused category/,
  );
  byId(tree, "forecast-category-all").props.onPress();
  byId(f.render(), "forecast-apply").props.onPress();
  assert.match(
    text(byId(f.render(), "forecast-applied-selection")),
    /All expense categories/,
  );
});
test("zero history rows remain visible and pagination exposes all complete months without rendering a huge list", () => {
  const f = fixture(
    ledger(Array.from({ length: 18 }, (_, i) => (i % 2 === 0 ? 10000 : 0))),
  );
  let tree = f.render();
  assert.match(text(byId(tree, "forecast-history-page")), /Months 13–18 of 18/);
  assert.ok(byId(tree, "forecast-history-2026-09"));
  assert.match(text(tree), /No expenses recorded/);
  byId(tree, "forecast-history-previous").props.onPress();
  tree = f.render();
  assert.match(text(byId(tree, "forecast-history-page")), /Months 1–12 of 18/);
  assert.ok(byId(tree, "forecast-history-2025-04"));
  assert.equal(byId(tree, "forecast-history-previous").props.disabled, true);
  byId(tree, "forecast-history-next").props.onPress();
  assert.match(text(byId(f.render(), "forecast-history-page")), /Months 13–18/);
});
test("zero baseline MAE states relative comparison is unavailable and JPY outputs use whole yen", () => {
  const tree = fixture(ledger(Array(18).fill(100), "JPY")).render();
  assert.match(
    text(byId(tree, "forecast-relative-error")),
    /unavailable because the baseline MAE is zero/,
  );
  assert.ok(
    futureValues(tree).every((row) => row[1] === model.formatMoney(100, "JPY")),
  );
  assert.equal(
    text(byId(tree, "forecast-selected-mae")),
    model.formatMoney(0, "JPY"),
  );
});
test("initial calendar overflow is recoverable without any prediction rows or component crash", () => {
  const f = fixture(ledger(), "2100-10-18");
  let tree = f.render();
  assert.ok(byId(tree, "forecast-error").props.message);
  assert.equal(futureValues(tree).length, 0);
  byId(tree, "forecast-as-of-input").props.onChangeText("2026-10-18");
  byId(f.render(), "forecast-apply").props.onPress();
  assert.equal(futureValues(f.render()).length, 6);
});
test("expense category search does not expose income/debt choices and pages have real reachable controls", () => {
  const f = fixture();
  let tree = f.render();
  assert.equal(byId(tree, "forecast-category-income-salary"), null);
  assert.equal(byId(tree, "forecast-category-debt-loan"), null);
  assert.ok(byId(tree, "forecast-category-next"));
  byId(tree, "forecast-category-next").props.onPress();
  tree = f.render();
  assert.equal(byId(tree, "forecast-category-previous").props.disabled, false);
  byId(tree, "forecast-category-search").props.onChangeText("does not exist");
  tree = f.render();
  assert.ok(byId(tree, "forecast-category-empty"));
  assert.ok(byId(tree, "forecast-category-all"));
});
test("income/debt/context changes do not replace or invalidate expense results; repeated Apply and reopening do not mutate ledger", () => {
  const f = fixture();
  let tree = f.render();
  const expected = futureValues(tree);
  let source = add(f.ledger, "income", "income", "2026-05-01", 800000);
  source = add(source, "debt", "debt", "2026-06-01", 700000);
  source = model.saveTransaction(
    source,
    model.patchTransactionContext(
      source.transactions[0],
      { notes: "Private note excluded from forecast" },
      source,
    ),
    true,
  );
  f.setLedger(source);
  tree = f.render();
  assert.equal(byId(tree, "forecast-source-changed"), null);
  assert.deepEqual(futureValues(tree), expected);
  assert.doesNotMatch(text(tree), /Private note/);
  const before = JSON.stringify(source);
  byId(tree, "forecast-apply").props.onPress();
  byId(f.render(), "forecast-apply").props.onPress();
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(futureValues(fixture(source).render()), expected);
});

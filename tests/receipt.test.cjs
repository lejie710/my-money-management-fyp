const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const r = require("../src/core/receipt"),
  m = require("../src/core/model");
const options = { walletCurrency: "MYR", today: "2026-10-18" };
test("currency codes after amounts stay explicit and foreign markers cannot be hidden by a generic dollar symbol", () => {
  const myr = r.parseReceipt(fixture(["SHOP", "TOTAL 12.50MYR"]), options);
  assert.equal(myr.currency.suggested, "MYR");
  assert.equal(myr.total.suggestedMinor, 1250);
  const foreign = r.parseReceipt(fixture(["SHOP", "TOTAL 12.50USD"]), options);
  assert.equal(foreign.currency.suggested, "USD");
  assert.equal(foreign.total.candidates[0].currency, "USD");
  const ambiguous = r.parseReceipt(
    fixture(["SHOP", "TOTAL USD $12.50"]),
    options,
  );
  assert.equal(ambiguous.currency.suggested, null);
  assert.deepEqual(ambiguous.currency.explicit, ["USD"]);
  const unsupported = r.parseReceipt(
    fixture(["SHOP", "TOTAL 12.50SGD"]),
    options,
  );
  assert.deepEqual(unsupported.currency.unsupported, ["SGD"]);
  const review = {
    title: "Reviewed",
    date: "2026-10-18",
    amount: "12.50",
    categoryId: "expense-food",
    currency: "MYR",
    confirmed: true,
  };
  assert.throws(() =>
    r.reviewedReceiptTransaction(m.createEmptyLedger(), ambiguous, review, "x"),
  );
});
test("mixed-currency labelled totals retain their own amount units instead of being relabelled as wallet currency", () => {
  const result = r.parseReceipt(
    fixture(["SHOP", "TOTAL USD12.50", "AMOUNT DUE MYR50.00"]),
    options,
  );
  assert.equal(result.total.suggestedMinor, null);
  assert.deepEqual(
    result.total.candidates.map((row) => [row.currency, row.amountMinor]),
    [
      ["USD", 1250],
      ["MYR", 5000],
    ],
  );
});
test("OCR letters inside or next to an amount do not become a silently shortened numeric proposal", () => {
  for (const value of ["RM12.5O", "RMl2.50", "RM12.50abc"]) {
    const result = r.parseReceipt(fixture(["SHOP", `TOTAL ${value}`]), options);
    assert.equal(result.total.suggestedMinor, null);
    assert.ok(
      result.total.issues.some((issue) => issue.includes("manual correction")),
    );
  }
});
function fromProbe(name) {
  const x = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "./fixtures/receipts", `${name}.json`),
      "utf8",
    ),
  );
  return {
    version: 1,
    provider: x.provider,
    language: x.language,
    width: x.width,
    height: x.height,
    elapsedMs: x.elapsedMs,
    textAngle: null,
    words: x.lines.flatMap((line) => line.words),
  };
}
function fixture(lines) {
  return {
    version: 1,
    provider: "windows-media-ocr",
    language: "en-US",
    width: 1400,
    height: 2000,
    elapsedMs: 10,
    textAngle: null,
    words: lines.flatMap((text, index) =>
      text.split(" ").map((word, i) => ({
        text: word,
        bounds: {
          x: 10 + i * 130,
          y: 20 + index * 60,
          width: 120,
          height: 30,
        },
      })),
    ),
  };
}
test("actual Windows word geometry selects RM12.50 and RM86.40 totals instead of column-ordered subtotals", () => {
  for (const [name, date, total, title] of [
    ["receipt-a", "2026-10-17", 1250, "FYP DEMO MART"],
    ["receipt-b", "2026-10-18", 8640, "SYNTHETIC CORNER SHOP"],
  ]) {
    const input = fromProbe(name),
      before = JSON.stringify(input);
    input.text = "TOTAL RM99999.99";
    const result = r.parseReceipt(input, options);
    assert.equal(result.total.suggestedMinor, total);
    assert.equal(result.date.suggested, date);
    assert.equal(result.title.suggested, title);
    assert.equal(result.currency.suggested, "MYR");
    assert.equal(result.reviewRequired, true);
    assert.ok(result.rows.some((row) => row.text.includes("TOTAL RM")));
    delete input.text;
    assert.equal(JSON.stringify(input), before);
    assert.equal(Object.isFrozen(result.rows), true);
  }
});
test("row reconstruction is independent of column order and input word array order", () => {
  const input = fromProbe("receipt-a");
  const expected = r.groupOcrRows(input).map((x) => x.text);
  assert.deepEqual(
    r
      .groupOcrRows({ ...input, words: [...input.words].reverse() })
      .map((x) => x.text),
    expected,
  );
});
test("blank recognition has no invented vendor/date/amount/currency", () => {
  const result = r.parseReceipt(fromProbe("blank"), options);
  assert.equal(result.status, "empty");
  assert.equal(result.title.suggested, null);
  assert.equal(result.date.suggested, null);
  assert.equal(result.total.suggestedMinor, null);
  assert.equal(result.currency.suggested, null);
});
test("ambiguous day/month order produces alternatives; invalid and future dates never silently default today", () => {
  let result = r.parseReceipt(
    fixture(["SHOP", "DATE 03/04/2026", "TOTAL RM12.50"]),
    options,
  );
  assert.deepEqual(result.date.candidates, ["2026-03-04", "2026-04-03"]);
  assert.equal(result.date.suggested, null);
  result = r.parseReceipt(
    fixture(["SHOP", "DATE 18/10/2026", "TOTAL RM12.50"]),
    options,
  );
  assert.equal(result.date.suggested, "2026-10-18");
  for (const text of ["2026-02-30", "2026-10-19", "03/04/26"])
    assert.equal(
      r.parseReceipt(
        fixture(["SHOP", `DATE ${text}`, "TOTAL RM12.50"]),
        options,
      ).date.suggested,
      null,
    );
  assert.equal(
    r.parseReceipt(
      fixture(["SHOP", "DATE 2024-02-29", "TOTAL RM12.50"]),
      options,
    ).date.suggested,
    "2024-02-29",
  );
});
test("multiple distinct totals remain ambiguous; repeated identical labelled totals agree", () => {
  let result = r.parseReceipt(
    fixture(["SHOP", "TOTAL RM12.50", "AMOUNT DUE RM13.50"]),
    options,
  );
  assert.equal(result.total.suggestedMinor, null);
  assert.equal(result.total.candidates.length, 2);
  result = r.parseReceipt(
    fixture(["SHOP", "TOTAL RM12.50", "GRAND TOTAL RM12.50"]),
    options,
  );
  assert.equal(result.total.suggestedMinor, 1250);
});
test("subtotal tax cash change savings and item counts are never promoted to total", () => {
  for (const label of [
    "SUBTOTAL",
    "SUB TOTAL",
    "TOTAL TAX",
    "TOTAL SAVINGS",
    "TOTAL ITEMS",
    "CASH",
    "CHANGE",
  ])
    assert.equal(
      r.parseReceipt(fixture(["SHOP", `${label} RM99.99`]), options).total
        .suggestedMinor,
      null,
    );
  assert.equal(
    r.parseReceipt(fixture(["SHOP", "TOTAL", "RM12.50"]), options).total
      .suggestedMinor,
    null,
  );
});
test("hyphenated subtotals do not supply an amount when the final label is unsupported", () => {
  for (const label of ["Sub-Total", "Sub - Total", "sUb-ToTaL"]) {
    const result = r.parseReceipt(
      fixture(["SHOP", `${label} RM10.00`, "Amount Payable RM10.60"]),
      options,
    );
    assert.equal(result.total.suggestedMinor, null, label);
    assert.deepEqual(result.total.candidates, [], label);
    assert.ok(result.total.issues.includes("No usable labelled total was identified."));
  }
});
test("GST SST and abbreviated discount rows never become total alternatives", () => {
  for (const [excluded, final] of [
    ["Total GST RM0.60", "Nett RM10.60"],
    ["TOTAL SST RM0.60", "Jumlah RM10.60"],
    ["Total Disc RM1.00", "Nett RM10.60"],
    ["Total Disc. RM1.00", "Amount Payable RM10.60"],
  ]) {
    const result = r.parseReceipt(fixture(["SHOP", excluded, final]), options);
    assert.equal(result.total.suggestedMinor, null, excluded);
    assert.deepEqual(result.total.candidates, [], excluded);
    assert.ok(result.total.issues.includes("No usable labelled total was identified."));
  }
});
test("a genuine labelled total remains usable beside excluded subtotal tax and discount rows", () => {
  const result = r.parseReceipt(
    fixture([
      "SHOP",
      "Sub-Total RM10.00",
      "Total GST RM0.60",
      "Total SST RM0.40",
      "Total Disc. RM0.40",
      "TOTAL RM10.60",
    ]),
    options,
  );
  assert.equal(result.total.suggestedMinor, 1060);
  assert.deepEqual(result.total.candidates.map((row) => row.amountMinor), [1060]);
  assert.deepEqual(result.total.issues, []);
  assert.equal(result.reviewRequired, true);
});
test("amount grouping is exact; commas decimal/refunds/oversized/JPY fractional values require manual correction", () => {
  assert.equal(
    r.parseReceipt(fixture(["SHOP", "TOTAL RM1,234.56"]), options).total
      .suggestedMinor,
    123456,
  );
  for (const value of [
    "12,50",
    "1.234,56",
    "-12.50",
    "(12.50)",
    "999999999.99",
  ])
    assert.equal(
      r.parseReceipt(fixture(["SHOP", `TOTAL RM${value}`]), options).total
        .suggestedMinor,
      null,
    );
  assert.equal(
    r.parseReceipt(fixture(["SHOP", "TOTAL JPY1234"]), {
      ...options,
      walletCurrency: "JPY",
    }).total.suggestedMinor,
    1234,
  );
  assert.equal(
    r.parseReceipt(fixture(["SHOP", "TOTAL JPY12.50"]), {
      ...options,
      walletCurrency: "JPY",
    }).total.suggestedMinor,
    null,
  );
});
test("bare dollar and yen symbols are ambiguous, known foreign currencies never relabel wallet totals", () => {
  for (const value of ["$12.50", "¥1250"]) {
    const result = r.parseReceipt(fixture(["SHOP", `TOTAL ${value}`]), options);
    assert.equal(result.currency.suggested, null);
    assert.equal(result.total.suggestedMinor, null);
    assert.ok(result.currency.candidates.length > 1);
  }
  const foreign = r.parseReceipt(fixture(["SHOP", "TOTAL USD12.50"]), options);
  assert.equal(foreign.currency.suggested, "USD");
  assert.equal(foreign.total.suggestedMinor, null);
  const unsupported = r.parseReceipt(
    fixture(["SHOP", "TOTAL SGD12.50"]),
    options,
  );
  assert.deepEqual(unsupported.currency.unsupported, ["SGD"]);
  assert.equal(unsupported.total.suggestedMinor, null);
});
test("malformed geometry/provider/response size and invented confidence are not trusted", () => {
  const good = fixture(["SHOP", "TOTAL RM12.50"]);
  for (const bad of [
    { ...good, version: 2 },
    { ...good, provider: "fake" },
    {
      ...good,
      words: [{ text: "x", bounds: { x: -1, y: 0, width: 1, height: 1 } }],
    },
    { ...good, words: Array(3001).fill(good.words[0]) },
    { ...good, words: [{ ...good.words[0], text: "x".repeat(129) }] },
  ])
    assert.throws(() => r.validateOcrResult(bad));
  const sanitized = r.validateOcrResult({
    ...good,
    confidence: 1,
    sourceFile: "private-source",
    text: "wrong",
  });
  assert.ok(!("confidence" in sanitized));
  assert.ok(!("sourceFile" in sanitized));
  assert.ok(!("text" in sanitized));
});
test("explicit review creates only a normal exact expense and leaves ledger unchanged", () => {
  const ledger = m.createEmptyLedger(),
    candidate = r.parseReceipt(fromProbe("receipt-a"), options),
    before = JSON.stringify(ledger),
    review = {
      title: "Reviewed shop",
      date: "2026-10-17",
      amount: "12.50",
      categoryId: "expense-food",
      currency: "MYR",
      confirmed: true,
    };
  const tx = r.reviewedReceiptTransaction(
    ledger,
    candidate,
    review,
    "reviewed-receipt",
  );
  assert.equal(tx.amountMinor, 1250);
  assert.equal(tx.type, "expense");
  assert.equal(tx.categoryId, "expense-food");
  assert.equal(JSON.stringify(ledger), before);
  assert.ok(!("origin" in tx));
  assert.ok(!("ocr" in tx));
  for (const patch of [
    { confirmed: false },
    { amount: "0" },
    { date: "2026-02-30" },
    { categoryId: "income-salary" },
    { currency: "USD" },
  ])
    assert.throws(() =>
      r.reviewedReceiptTransaction(
        ledger,
        candidate,
        { ...review, ...patch },
        "x",
      ),
    );
  assert.throws(() =>
    r.reviewedReceiptTransaction(
      ledger,
      r.parseReceipt(fixture(["SHOP", "TOTAL USD12.50"]), options),
      review,
      "x",
    ),
  );
  assert.throws(() =>
    r.reviewedReceiptTransaction(
      ledger,
      r.parseReceipt(fixture(["SHOP", "TOTAL SGD12.50"]), options),
      review,
      "x",
    ),
  );
});

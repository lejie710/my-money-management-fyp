const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluationCases, evaluateCase } = require("./assistant-eval-cases.cjs");
const response = (answer, factIds) => JSON.stringify({ answer, factIds });
test("all nine synthetic evaluation cases produce bounded local requests without a provider call", () => {
  const cases = evaluationCases();
  assert.equal(cases.length, 9);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.ok(
    cases.every(
      (item) => item.request.messages.length === 3 && item.manualReview,
    ),
  );
});
test("zero-income evaluation rejects the actual probe mistake and a wrong numerical answer", () => {
  const item = evaluationCases().find((row) => row.id === "zero-income");
  const wrongMeaning =
    "The outflow is MYR 200 and closing balance MYR 100. Ratios are unavailable because no income data was provided.";
  assert.equal(
    evaluateCase(item, response(wrongMeaning, ["ratios", "outflow", "closing"]))
      .passedHeuristics,
    false,
  );
  const wrongValues =
    "Recorded income is MYR 0.00 so ratios cannot divide by a zero denominator. Outflow is MYR 999 and closing is MYR 123.";
  const result = evaluateCase(
    item,
    response(wrongValues, ["income", "ratios", "outflow", "closing"]),
  );
  assert.equal(result.passedHeuristics, false);
  assert.deepEqual(result.failedChecks, ["outflow", "closing"]);
});
test("a narrow heuristic pass explicitly remains pending semantic review", () => {
  const item = evaluationCases().find((row) => row.id === "three-balances");
  const correct =
    "Opening is MYR 750, period closing is MYR 2200, and all-dates balance is MYR 2680. The all-dates balance includes later records.";
  const good = evaluateCase(
    item,
    response(correct, ["opening", "closing", "allDates"]),
  );
  assert.equal(good.passedHeuristics, true);
  assert.equal(good.requiresManualReview, true);
  // Deliberately swapped roles pass string checks: reviewers must verify the meaning.
  const swapped =
    "Opening is MYR 2200, period closing is MYR 750, and all-dates balance is MYR 2680 from later records.";
  assert.equal(
    evaluateCase(item, response(swapped, ["opening", "closing", "allDates"]))
      .requiresManualReview,
    true,
  );
});
test("valid real-run division and not-included wording are recognized without changing required facts", () => {
  const cases = evaluationCases();
  const zero = cases.find((row) => row.id === "zero-income");
  assert.equal(
    evaluateCase(
      zero,
      response(
        "Recorded income is MYR 0.00, so ratios are unavailable because division by zero is undefined. Outflow is MYR 200.00 and closing balance is MYR 100.00.",
        ["income", "ratios", "outflow", "closing"],
      ),
    ).passedHeuristics,
    true,
  );
  const missing = cases.find((row) => row.id === "unselected-goal");
  assert.equal(
    evaluateCase(
      missing,
      response(
        "The selected facts do not include a savings goal amount. It is impossible to determine the amount needed.",
        ["selection"],
      ),
    ).passedHeuristics,
    true,
  );
});

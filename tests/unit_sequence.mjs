import assert from "node:assert/strict";
import { sequenceTimeoutBudget } from "../dist/sequence.js";
import { DEFAULT_ACTION_TIMEOUT_MS, MAX_SEQUENCE_ACTIONS, SEQUENCE_TIMEOUT_MS } from "../dist/config.js";

// Finding #9: the schema allows up to MAX_SEQUENCE_ACTIONS (25) actions, but the
// sequence timeout budget must be large enough to admit that many at the default
// per-action timeout. Previously the default SEQUENCE_TIMEOUT_MS was 120000ms,
// which rejected any sequence with 13+ default-timeout actions.
function defaultClickAction() {
  return { type: "click", selector: "#a" };
}

// 25 default-timeout actions (25 * 10000 = 250000) must fit the default budget.
const maxActions = Array.from({ length: MAX_SEQUENCE_ACTIONS }, defaultClickAction);
assert.equal(
  sequenceTimeoutBudget(maxActions),
  MAX_SEQUENCE_ACTIONS * DEFAULT_ACTION_TIMEOUT_MS,
  "budget should sum default per-action timeouts",
);
assert.ok(
  sequenceTimeoutBudget(maxActions) <= SEQUENCE_TIMEOUT_MS,
  `default SEQUENCE_TIMEOUT_MS (${SEQUENCE_TIMEOUT_MS}ms) must admit MAX_SEQUENCE_ACTIONS (${MAX_SEQUENCE_ACTIONS}) at the default action timeout`,
);

// 26 actions should exceed MAX_SEQUENCE_ACTIONS logically but the budget check is
// purely additive; verify the budget math scales linearly.
assert.equal(sequenceTimeoutBudget(Array.from({ length: 26 }, defaultClickAction)), 260000);

console.log("Sequence budget unit tests passed.");

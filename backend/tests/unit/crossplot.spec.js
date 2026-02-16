import test from "node:test";
import assert from "node:assert/strict";
import { robustZ, validatePairs } from "../../services/crossplotService.js";

test("robustZ returns 0 when mad is invalid", () => {
  assert.equal(robustZ(10, 10, 0), 0);
  assert.equal(robustZ(10, 10, null), 0);
});

test("robustZ computes scaled score", () => {
  const z = robustZ(20, 10, 5);
  assert.equal(Number(z.toFixed(4)), 1.349);
});

test("validatePairs enforces pair shape", () => {
  assert.equal(validatePairs([["A", "B"]]).ok, true);
  assert.equal(validatePairs([["A"]]).ok, false);
  assert.equal(validatePairs([]).ok, false);
});


import test from "node:test";
import assert from "node:assert/strict";
import { validateFeedbackPayload } from "../../services/feedbackService.js";

test("validateFeedbackPayload accepts valid labels", () => {
  const out = validateFeedbackPayload({
    wellId: "W1",
    fromDepth: 100,
    toDepth: 90,
    userLabel: "true_positive",
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.fromDepth, 90);
  assert.equal(out.value.toDepth, 100);
});

test("validateFeedbackPayload rejects invalid label", () => {
  const out = validateFeedbackPayload({
    wellId: "W1",
    fromDepth: 100,
    toDepth: 110,
    userLabel: "bad",
  });
  assert.equal(out.ok, false);
});


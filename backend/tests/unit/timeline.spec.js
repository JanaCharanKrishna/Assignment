import test from "node:test";
import assert from "node:assert/strict";
import { buildTimelineBuckets } from "../../services/timelineService.js";

test("buildTimelineBuckets uses deterministic boundaries", () => {
  const out = buildTimelineBuckets(100, 130, 10);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    from: 100,
    to: 110,
    density: 0,
    maxConfidence: 0,
    severity: 0,
    count: 0,
  });
  assert.equal(out[2].from, 120);
  assert.equal(out[2].to, 130);
});


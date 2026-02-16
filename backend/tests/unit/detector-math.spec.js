import test from "node:test";
import assert from "node:assert/strict";
import { applyBaselineAwareScoring } from "../../services/baselineScoring.js";

function buildRows(count = 120, spikeAt = 60, spikeValue = 100) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const v = i === spikeAt ? spikeValue : 10 + (i % 3);
    rows.push({
      depth: 1000 + i,
      values: {
        HC1__2: v,
      },
    });
  }
  return rows;
}

test("applyBaselineAwareScoring attaches baseline metrics and score2", () => {
  const rows = buildRows();
  const deterministic = {
    qualityPenalty: 1,
    intervalFindings: [
      {
        curve: "HC1__2",
        fromDepth: 1050,
        toDepth: 1070,
        score: 10,
      },
    ],
  };

  const out = applyBaselineAwareScoring({
    rows,
    curves: ["HC1__2"],
    deterministic,
  });

  assert.equal(Array.isArray(out.intervalFindings), true);
  assert.equal(out.intervalFindings.length, 1);
  const f = out.intervalFindings[0];
  assert.equal(typeof f.baseline, "object");
  assert.equal(typeof f.score2, "number");
  assert.equal(Number.isFinite(f.baseline.spikeZ), true);
});


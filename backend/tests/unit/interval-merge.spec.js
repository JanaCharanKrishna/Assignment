import test from "node:test";
import assert from "node:assert/strict";
import { consolidateMultiCurveIntervals } from "../../services/multiCurveConsolidation.js";

test("consolidateMultiCurveIntervals sets curvesSupporting and evidenceType", () => {
  const deterministic = {
    intervalFindings: [
      { curve: "HC1__2", fromDepth: 1100, toDepth: 1110, score: 12 },
      { curve: "HC2__3", fromDepth: 1102, toDepth: 1111, score: 11 },
      { curve: "CC6", fromDepth: 1300, toDepth: 1310, score: 3 },
    ],
  };

  const out = consolidateMultiCurveIntervals(deterministic);
  assert.equal(Array.isArray(out.intervalFindings), true);
  assert.ok(out.intervalFindings.length > 0);
  const top = out.intervalFindings[0];
  assert.ok(Number(top.curvesSupporting) >= 1);
  assert.ok(["single-curve", "multi-curve"].includes(top.evidenceType));

  const hasMulti = out.intervalFindings.some((x) => Number(x.curvesSupporting) >= 2);
  assert.equal(hasMulti, true);
});


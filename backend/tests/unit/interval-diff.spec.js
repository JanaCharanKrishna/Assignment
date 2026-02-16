import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeCurve,
  computeCurveDiff,
  normalizeInterval,
} from "../../services/intervalDiffService.js";

test("normalizeInterval orders depth and normalizes curves", () => {
  const out = normalizeInterval(
    { fromDepth: 120, toDepth: 100, curves: ["A", "A", "B"] },
    []
  );
  assert.equal(out.fromDepth, 100);
  assert.equal(out.toDepth, 120);
  assert.deepEqual(out.curves, ["A", "B"]);
});

test("summarizeCurve returns core statistics", () => {
  const rows = [
    { values: { HC1: 1 } },
    { values: { HC1: 2 } },
    { values: { HC1: 3 } },
    { values: { HC1: 4 } },
    { values: { HC1: 5 } },
  ];
  const s = summarizeCurve(rows, "HC1");
  assert.equal(Number(s.mean.toFixed(3)), 3);
  assert.equal(s.p90, 4);
  assert.equal(s.n, 5);
});

test("computeCurveDiff handles missing curves gracefully", () => {
  const out = computeCurveDiff(
    ["A", "B"],
    { A: { mean: 10, p90: 11, cv: 0.2 } },
    { A: { mean: 20, p90: 22, cv: 0.4 }, B: { mean: 2, p90: 3, cv: 0.1 } }
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].curve, "A");
  assert.equal(out[0].deltaPct, 100);
  assert.equal(out[1].curve, "B");
  assert.equal(out[1].delta, null);
});


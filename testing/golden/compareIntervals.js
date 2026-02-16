#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function ioU(a, b) {
  const a0 = Math.min(Number(a.fromDepth), Number(a.toDepth));
  const a1 = Math.max(Number(a.fromDepth), Number(a.toDepth));
  const b0 = Math.min(Number(b.fromDepth), Number(b.toDepth));
  const b1 = Math.max(Number(b.fromDepth), Number(b.toDepth));
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const union = Math.max(a1, b1) - Math.min(a0, b0);
  return union > 0 ? inter / union : 0;
}

function closest(actual, expected) {
  let best = null;
  let bestScore = -1;
  for (const a of actual) {
    const s = ioU(a, expected);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return { best, iou: bestScore };
}

function main() {
  const actualPath = process.argv[2];
  const expectedPath = process.argv[3];
  const tolerancePath = process.argv[4] || path.join(path.dirname(expectedPath), "..", "tolerances.json");

  if (!actualPath || !expectedPath) {
    console.error("Usage: node testing/golden/compareIntervals.js <actual.json> <expected.json> [tolerances.json]");
    process.exit(2);
  }

  const actual = readJson(actualPath);
  const expected = readJson(expectedPath);
  const tol = readJson(tolerancePath);

  const failures = [];
  if (!Array.isArray(actual)) failures.push("Actual payload must be an array.");
  if (!Array.isArray(expected)) failures.push("Expected payload must be an array.");
  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exit(1);
  }

  if (actual.length < Math.max(1, expected.length - 1)) {
    failures.push(`Actual interval count ${actual.length} too low for expected ${expected.length}.`);
  }

  expected.forEach((e, idx) => {
    const { best, iou } = closest(actual, e);
    if (!best) {
      failures.push(`Expected interval ${idx + 1} has no match.`);
      return;
    }
    if (iou < Number(tol.minIoU ?? 0.7)) {
      failures.push(`Expected interval ${idx + 1} IoU too low: ${iou.toFixed(3)}.`);
    }
    const er = String(e.reason || "").toLowerCase();
    const ar = String(best.reason || "").toLowerCase();
    if (er && ar && er !== ar) {
      failures.push(`Expected interval ${idx + 1} reason mismatch: expected=${er}, actual=${ar}.`);
    }
    const es = Number(e.score);
    const as = Number(best.score);
    if (Number.isFinite(es) && Number.isFinite(as)) {
      const diff = Math.abs(es - as);
      if (diff > Number(tol.scoreToleranceAbs ?? 0.75)) {
        failures.push(`Expected interval ${idx + 1} score diff too high: ${diff.toFixed(3)}.`);
      }
    }
  });

  const expectedMulti = Number(tol.minMultiCurveCount ?? 0);
  if (expectedMulti > 0) {
    const multi = actual.filter((x) => Number(x.curvesSupporting) >= 2 || String(x.evidenceType) === "multi-curve");
    if (multi.length < expectedMulti) {
      failures.push(`Expected at least ${expectedMulti} multi-curve interval(s), got ${multi.length}.`);
    }
  }

  const out = {
    ok: failures.length === 0,
    actualCount: actual.length,
    expectedCount: expected.length,
    failures,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main();


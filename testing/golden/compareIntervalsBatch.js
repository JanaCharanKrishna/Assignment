#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const actualDir = path.join(root, "testing", "golden", "actual");
const expectedDir = path.join(root, "testing", "golden", "expected");
const tolPath = path.join(root, "testing", "golden", "tolerances.json");

const targets = ["golden_A", "golden_B", "golden_C"];
let failed = 0;

for (const id of targets) {
  const actual = path.join(actualDir, `${id}.intervals.json`);
  const expected = path.join(expectedDir, `${id}.intervals.json`);
  if (!fs.existsSync(actual)) {
    console.error(`[FAIL] Missing actual file: ${actual}`);
    failed += 1;
    continue;
  }
  if (!fs.existsSync(expected)) {
    console.error(`[FAIL] Missing expected file: ${expected}`);
    failed += 1;
    continue;
  }

  const out = spawnSync(
    process.execPath,
    [path.join(root, "testing", "golden", "compareIntervals.js"), actual, expected, tolPath],
    { encoding: "utf8" }
  );

  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  if (out.status !== 0) {
    console.error(`[FAIL] ${id}`);
    failed += 1;
  } else {
    console.log(`[PASS] ${id}`);
  }
}

if (failed > 0) {
  console.error(`Batch compare failed: ${failed} case(s)`);
  process.exit(1);
}
console.log("Batch compare passed.");


#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5000";
const WELL = process.env.TEST_WELL_ID || "WELL_1770968672517";
const OUT_DIR = path.join(process.cwd(), "testing", "golden", "actual");

const cases = [
  {
    id: "golden_A",
    body: {
      wellId: WELL,
      fromDepth: 10608.2,
      toDepth: 12584.69,
      curves: ["HC1__2", "HC2__3", "CC6"],
    },
  },
  {
    id: "golden_B",
    body: {
      wellId: WELL,
      fromDepth: 11000,
      toDepth: 11800,
      curves: ["HC2__3"],
    },
  },
  {
    id: "golden_C",
    body: {
      wellId: WELL,
      fromDepth: 12428.6,
      toDepth: 13333.7,
      curves: ["CC6"],
    },
  },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const c of cases) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Number(process.env.GOLDEN_TIMEOUT_MS || 60000)
    );
    const res = await fetch(`${BASE}/api/ai/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c.body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (res.status !== 200 || !data?.ok) {
      throw new Error(
        `Golden case ${c.id} failed: status=${res.status}, body=${JSON.stringify(data).slice(0, 400)}`
      );
    }
    const findings = data?.deterministic?.intervalFindings || [];
    fs.writeFileSync(
      path.join(OUT_DIR, `${c.id}.intervals.json`),
      JSON.stringify(findings, null, 2),
      "utf8"
    );
    console.log(`wrote ${c.id}.intervals.json (${findings.length} intervals)`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

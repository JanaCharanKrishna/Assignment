import fs from "fs";
import path from "path";
import { pgPool } from "../db/postgres.js";

function percentile(vals, q) {
  const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = q * (v.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(v.length - 1, lo + 1);
  const frac = pos - lo;
  return v[lo] + frac * (v[hi] - v[lo]);
}

async function main() {
  const out = await pgPool.query(`
    SELECT (deterministic->>'anomalyScore')::float AS s
    FROM interpretation_runs
    WHERE deterministic ? 'anomalyScore'
      AND (deterministic->>'anomalyScore') IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 2000
  `);

  const scores = (out.rows || []).map((r) => Number(r?.s)).filter(Number.isFinite);
  const p50 = percentile(scores, 0.5);
  const p75 = percentile(scores, 0.75);
  const p90 = percentile(scores, 0.9);

  console.log("Scores:", scores.length);
  console.log("Suggested bands:");
  console.log("  moderate ~ p50:", p50);
  console.log("  high     ~ p75:", p75);
  console.log("  critical ~ p90:", p90);

  const configPath = path.join(process.cwd(), "config", "thresholds.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    cfg = {};
  }

  cfg.bands = cfg.bands || {};
  cfg.anomalyScoreBands = cfg.anomalyScoreBands || {};
  if (p50 && p75 && p90) {
    cfg.bands.moderate = Number(p50.toFixed(2));
    cfg.bands.high = Number(p75.toFixed(2));
    cfg.bands.critical = Number(p90.toFixed(2));

    cfg.anomalyScoreBands.medium = cfg.bands.moderate;
    cfg.anomalyScoreBands.high = cfg.bands.high;
    cfg.anomalyScoreBands.critical = cfg.bands.critical;
    if (!Number.isFinite(Number(cfg.anomalyScoreBands.low))) cfg.anomalyScoreBands.low = 0.35;

    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
    console.log("Updated thresholds.json bands");
  } else {
    console.log("Not enough data to update thresholds.json");
  }
}

main()
  .catch((e) => {
    console.error("Calibration failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pgPool.end();
    } catch {}
  });

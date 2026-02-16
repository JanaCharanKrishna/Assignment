import fs from "fs";
import path from "path";

let cache = null;

const DEFAULTS = {
  version: "phase-2.0",
  bands: { critical: 0.8, high: 0.65, moderate: 0.45 },
  quality: { minFiniteRatio: 0.7, maxNullRatio: 0.25, minPoints: 20 },
  baseline: {
    baselineWindowFt: 2000,
    minBaselinePoints: 80,
    baselineWindowPadFt: 1500,
    noisyStdMultiplier: 1.8,
    spikeRobustZ: 6,
    spikeZ: 3,
    stepShiftStdMultiplier: 2.5,
    driftCorr: 2,
    noiseCvZ: 2.5,
  },
  ranking: { requireMultiCurveTopN: 2, multiCurveMinSupport: 2, gapToleranceFt: 8 },
  detection: { spikeZ: 3, stepZ: 2.5, driftSlopeZ: 2, noiseCvZ: 2.5 },
};

function merge(base, extra) {
  if (!extra || typeof extra !== "object") return { ...base };
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = merge(out[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

export function getThresholds() {
  if (cache) return cache;
  const p = path.join(process.cwd(), "config", "thresholds.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    cache = merge(DEFAULTS, JSON.parse(raw));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}


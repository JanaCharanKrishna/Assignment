import fs from "fs";
import path from "path";
import { pgPool } from "../db/postgres.js";
import { getDb } from "../db/mongo.js";

const THRESH_PATH = path.join(process.cwd(), "config", "thresholds.json");

// Postgres candidate raw-sample table (used only if it exists).
const WELL_SAMPLES_TABLE = "well_samples";
const COL_WELL_ID = "well_id";
const COL_DEPTH = "depth";
const COL_VALUES = "values";

let pgSamplesAvailability = null;

const DEFAULT_THRESHOLDS = {
  anomalyScoreBands: { low: 0.35, medium: 0.55, high: 0.72, critical: 0.85 },
  interval: {
    topN: 10,
    minRows: 20,
    minFiniteRatio: 0.7,
    enforceMinMultiCurve: 2,
    multiCurveBoost: 0.12,
    singleCurvePenalty: 0.08,
  },
  baseline: {
    windowPadFt: 1500,
    noisyStdMultiplier: 1.8,
    spikeRobustZ: 6.0,
    spikeZ: 5.5,
    stepShiftStdMultiplier: 1.2,
    driftCorr: 0.55,
  },
};

function mergeObjects(base, ext) {
  if (!ext || typeof ext !== "object") return { ...base };
  const out = { ...base };
  for (const [k, v] of Object.entries(ext)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = mergeObjects(out[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

export function loadThresholds() {
  try {
    const raw = fs.readFileSync(THRESH_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return mergeObjects(DEFAULT_THRESHOLDS, parsed);
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

async function hasPgSamplesTable() {
  if (pgSamplesAvailability !== null) return pgSamplesAvailability;
  try {
    const out = await pgPool.query(
      `SELECT to_regclass('public.${WELL_SAMPLES_TABLE}') AS reg`
    );
    pgSamplesAvailability = !!out?.rows?.[0]?.reg;
  } catch {
    pgSamplesAvailability = false;
  }
  return pgSamplesAvailability;
}

function projectCurves(values, curves) {
  if (!Array.isArray(curves) || !curves.length) return values && typeof values === "object" ? values : {};
  const out = {};
  const src = values && typeof values === "object" ? values : {};
  for (const c of curves) out[c] = src[c] ?? null;
  return out;
}

async function fetchRowsFromPg({ wellId, fromDepth, toDepth, curves, limit }) {
  const sql = `
    SELECT
      ${COL_DEPTH}::double precision AS depth,
      ${COL_VALUES} AS values
    FROM ${WELL_SAMPLES_TABLE}
    WHERE ${COL_WELL_ID} = $1
      AND ${COL_DEPTH} >= $2
      AND ${COL_DEPTH} <= $3
    ORDER BY ${COL_DEPTH} ASC
    LIMIT $4
  `;
  const out = await pgPool.query(sql, [wellId, fromDepth, toDepth, limit]);
  const rows = Array.isArray(out?.rows) ? out.rows : [];
  return rows.map((r) => ({
    depth: Number(r?.depth),
    values: projectCurves(r?.values, curves),
  }));
}

async function fetchRowsFromMongo({ wellId, fromDepth, toDepth, curves, limit }) {
  const db = getDb();
  const docs = await db
    .collection("well_points")
    .find(
      {
        wellId,
        depth: { $gte: fromDepth, $lte: toDepth },
      },
      { projection: { _id: 0, depth: 1, values: 1 } }
    )
    .sort({ depth: 1 })
    .limit(limit)
    .toArray();

  return docs.map((d) => ({
    depth: Number(d?.depth),
    values: projectCurves(d?.values, curves),
  }));
}

// DB-backed fetch:
// 1) Postgres well_samples if present
// 2) otherwise Mongo well_points (current project source of raw well rows)
export async function fetchRowsForRangeDB({
  wellId,
  fromDepth,
  toDepth,
  curves = [],
  limit = 30000,
}) {
  const lo = Math.min(Number(fromDepth), Number(toDepth));
  const hi = Math.max(Number(fromDepth), Number(toDepth));
  if (!wellId || !Number.isFinite(lo) || !Number.isFinite(hi)) return [];

  if (await hasPgSamplesTable()) {
    try {
      return await fetchRowsFromPg({
        wellId,
        fromDepth: lo,
        toDepth: hi,
        curves,
        limit,
      });
    } catch (e) {
      console.warn("[baselineEngine] Postgres well_samples fetch failed; falling back to Mongo:", e?.message || e);
    }
  }

  return fetchRowsFromMongo({
    wellId,
    fromDepth: lo,
    toDepth: hi,
    curves,
    limit,
  });
}

function finiteVals(rows, curve) {
  const vals = [];
  for (const r of rows || []) {
    const v = Number(r?.values?.[curve]);
    if (Number.isFinite(v)) vals.push(v);
  }
  return vals;
}

function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

function std(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
  return Math.sqrt(v);
}

function median(a) {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y);
  const mid = Math.floor(b.length / 2);
  return b.length % 2 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
}

function mad(a) {
  const m = median(a);
  if (m == null) return null;
  const dev = a.map((x) => Math.abs(x - m));
  return median(dev);
}

function corrIndex(a) {
  const n = a.length;
  if (n < 6) return null;
  const mx = (n - 1) / 2;
  const my = mean(a);
  if (my == null) return null;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const vx = i - mx;
    const vy = a[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  return den ? num / den : null;
}

function computeStats(vals) {
  if (!vals.length) return null;
  return { mean: mean(vals), std: std(vals), median: median(vals), mad: mad(vals), count: vals.length };
}

function computeLocalStats(vals) {
  const base = computeStats(vals);
  if (!base) return null;
  const mid = Math.floor(vals.length / 2);
  return {
    ...base,
    firstHalfMean: mean(vals.slice(0, mid)),
    secondHalfMean: mean(vals.slice(mid)),
    trendCorr: corrIndex(vals),
  };
}

function addZExtremes(localVals, baseline) {
  let maxAbsZ = 0;
  let maxAbsRobustZ = 0;

  if (baseline?.mean != null && baseline?.std && baseline.std > 0) {
    for (const v of localVals) {
      const z = Math.abs((v - baseline.mean) / baseline.std);
      if (z > maxAbsZ) maxAbsZ = z;
    }
  }
  if (baseline?.median != null && baseline?.mad && baseline.mad > 0) {
    const denom = 1.4826 * baseline.mad;
    for (const v of localVals) {
      const rz = Math.abs((v - baseline.median) / denom);
      if (rz > maxAbsRobustZ) maxAbsRobustZ = rz;
    }
  }
  return { maxAbsZ, maxAbsRobustZ };
}

function classifyTypes({ baseline, local, thr }) {
  const t = [];
  const sig = {};
  if (!baseline || !local) return { types: ["insufficient_data"], signals: sig };

  if (baseline.std && local.std && local.std > thr.noisyStdMultiplier * baseline.std) t.push("noisy_zone");

  if (local.firstHalfMean != null && local.secondHalfMean != null) {
    const shift = Math.abs(local.secondHalfMean - local.firstHalfMean);
    sig.step_shift = shift;
    const scale = baseline.std || local.std || 1e-9;
    if (shift > thr.stepShiftStdMultiplier * scale) t.push("step_change");
  }

  if (local.trendCorr != null && Math.abs(local.trendCorr) > thr.driftCorr) t.push("drift");
  if (local.maxAbsRobustZ != null && local.maxAbsRobustZ > thr.spikeRobustZ) t.push("spike");
  else if (local.maxAbsZ != null && local.maxAbsZ > thr.spikeZ) t.push("spike");

  if (!t.length) t.push("baseline_ok");
  return { types: t, signals: sig };
}

export function buildBaselineContext({ baselineRows, localRows, curves, thresholds }) {
  const thr = thresholds?.baseline || DEFAULT_THRESHOLDS.baseline;
  const out = {};
  for (const c of curves || []) {
    const bVals = finiteVals(baselineRows, c);
    const lVals = finiteVals(localRows, c);
    const baseline = computeStats(bVals);
    const local = computeLocalStats(lVals);

    if (baseline && local) {
      const z = addZExtremes(lVals, baseline);
      local.maxAbsZ = z.maxAbsZ;
      local.maxAbsRobustZ = z.maxAbsRobustZ;
    }

    const classification = classifyTypes({ baseline, local, thr });
    const finite_ratio = (localRows?.length || 0) > 0 ? lVals.length / localRows.length : 0;
    out[c] = { baseline, local, classification, finite_ratio };
  }
  return out;
}


import { createHash } from "node:crypto";
import { fetchRowsForRangeDB } from "./baselineEngine.js";

const FEATURE_VERSION = "crossplot-v1";
const THRESHOLD_VERSION = "thresholds-v1";
const DET_MODEL_VERSION = "det-v1";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mad(arr, med) {
  if (!arr.length || !Number.isFinite(med)) return null;
  const dev = arr.map((x) => Math.abs(x - med));
  return median(dev);
}

export function robustZ(v, med, madValue) {
  if (!Number.isFinite(v) || !Number.isFinite(med) || !Number.isFinite(madValue) || madValue === 0) return 0;
  return 0.6745 * (v - med) / madValue;
}

function sampleRows(rows, sampleLimit) {
  const n = Math.max(100, Math.min(10000, Number(sampleLimit) || 5000));
  if ((rows || []).length <= n) return rows || [];
  const stride = Math.max(1, Math.floor(rows.length / n));
  const out = [];
  for (let i = 0; i < rows.length && out.length < n; i += stride) {
    out.push(rows[i]);
  }
  return out;
}

function algoHash(parts = []) {
  return createHash("md5").update(parts.join(":")).digest("hex").slice(0, 10);
}

function validatePairs(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return { ok: false, error: "pairs are required" };
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length !== 2) {
      return { ok: false, error: "each pair must be [x,y]" };
    }
    const x = String(p[0] || "").trim();
    const y = String(p[1] || "").trim();
    if (!x || !y) return { ok: false, error: "pair names must be non-empty" };
  }
  return { ok: true };
}

export async function computeCrossplotMatrix({
  wellId,
  fromDepth,
  toDepth,
  pairs,
  sampleLimit = 5000,
}) {
  const fd = toNum(fromDepth);
  const td = toNum(toDepth);
  if (!Number.isFinite(fd) || !Number.isFinite(td)) {
    throw new Error("fromDepth and toDepth are required numbers");
  }
  const pairCheck = validatePairs(pairs);
  if (!pairCheck.ok) throw new Error(pairCheck.error);

  const uniqCurves = [...new Set(pairs.flat().map((c) => String(c).trim()))];
  const rowsAll = await fetchRowsForRangeDB({
    wellId,
    fromDepth: Math.min(fd, td),
    toDepth: Math.max(fd, td),
    curves: uniqCurves,
    limit: 120000,
  });
  const rows = sampleRows(rowsAll, sampleLimit);

  const plots = [];
  for (const pair of pairs) {
    const xName = String(pair[0]).trim();
    const yName = String(pair[1]).trim();
    const points = [];
    for (const r of rows) {
      const x = toNum(r?.values?.[xName]);
      const y = toNum(r?.values?.[yName]);
      const depth = toNum(r?.depth);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(depth)) continue;
      points.push({ depth, x, y });
    }

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMed = median(xs);
    const yMed = median(ys);
    const xMad = mad(xs, xMed);
    const yMad = mad(ys, yMed);

    for (const p of points) {
      const zx = robustZ(p.x, xMed, xMad);
      const zy = robustZ(p.y, yMed, yMad);
      const isOutlier = Math.abs(zx) > 3.5 || Math.abs(zy) > 3.5;
      p.cluster = isOutlier ? -1 : 1;
      p.isOutlier = isOutlier;
    }

    let inlierCount = 0;
    let outlierCount = 0;
    let inlierXSum = 0;
    let inlierYSum = 0;
    let outlierXSum = 0;
    let outlierYSum = 0;
    for (const p of points) {
      if (p.isOutlier) {
        outlierCount += 1;
        outlierXSum += p.x;
        outlierYSum += p.y;
      } else {
        inlierCount += 1;
        inlierXSum += p.x;
        inlierYSum += p.y;
      }
    }

    const clusterSummary = [];
    if (inlierCount > 0) {
      clusterSummary.push({
        cluster: 1,
        count: inlierCount,
        xMean: Number((inlierXSum / inlierCount).toFixed(3)),
        yMean: Number((inlierYSum / inlierCount).toFixed(3)),
        abnormalityScore: Number((outlierCount / points.length).toFixed(4)),
      });
    }
    if (outlierCount > 0) {
      clusterSummary.push({
        cluster: -1,
        count: outlierCount,
        xMean: Number((outlierXSum / outlierCount).toFixed(3)),
        yMean: Number((outlierYSum / outlierCount).toFixed(3)),
        abnormalityScore: 1,
      });
    }

    plots.push({
      x: xName,
      y: yName,
      points: points.map((p) => ({
        depth: Number(p.depth.toFixed(4)),
        x: Number(p.x.toFixed(4)),
        y: Number(p.y.toFixed(4)),
        cluster: p.cluster,
        isOutlier: p.isOutlier,
      })),
      clusterSummary,
    });
  }

  return {
    plots,
    versions: {
      featureVersion: FEATURE_VERSION,
      thresholdVersion: THRESHOLD_VERSION,
      detModelVersion: DET_MODEL_VERSION,
      algoHash: algoHash([FEATURE_VERSION, THRESHOLD_VERSION, DET_MODEL_VERSION]),
    },
  };
}

export { FEATURE_VERSION as CROSSPLOT_FEATURE_VERSION, validatePairs };


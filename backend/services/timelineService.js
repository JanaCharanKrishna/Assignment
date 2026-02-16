import { createHash } from "node:crypto";
import { fetchRowsForRangeDB } from "./baselineEngine.js";
import { callAiInterpret } from "./aiClient.js";

const FEATURE_VERSION = "event-timeline-v1";
const DET_MODEL_VERSION = "det-v1";
const THRESHOLD_VERSION = "thresholds-v1";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRange(fromDepth, toDepth) {
  const a = toNum(fromDepth);
  const b = toNum(toDepth);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { fromDepth: Math.min(a, b), toDepth: Math.max(a, b) };
}

export function buildTimelineBuckets(fromDepth, toDepth, bucketSize) {
  const lo = Number(fromDepth);
  const hi = Number(toDepth);
  const step = Math.max(0.1, Number(bucketSize) || 10);
  const out = [];
  for (let d = lo; d < hi; d += step) {
    out.push({
      from: d,
      to: Math.min(d + step, hi),
      density: 0,
      maxConfidence: 0,
      severity: 0,
      count: 0,
    });
  }
  return out;
}

function overlapLen(a0, a1, b0, b1) {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return Math.max(0, hi - lo);
}

function toSeverityScore(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  const s = String(v || "").toUpperCase();
  if (s.includes("CRITICAL")) return 1;
  if (s.includes("HIGH")) return 0.75;
  if (s.includes("MEDIUM")) return 0.5;
  if (s.includes("LOW")) return 0.25;
  return 0;
}

function makeAlgoHash(parts = []) {
  return createHash("md5").update(parts.join(":")).digest("hex").slice(0, 10);
}

export async function buildEventTimeline({
  wellId,
  fromDepth,
  toDepth,
  bucketSize = 10,
  curves = [],
}) {
  const range = normalizeRange(fromDepth, toDepth);
  if (!range) throw new Error("fromDepth and toDepth are required numbers");
  if (!Array.isArray(curves) || !curves.length) throw new Error("curves are required");
  const warnings = [];

  const rows = await fetchRowsForRangeDB({
    wellId,
    fromDepth: range.fromDepth,
    toDepth: range.toDepth,
    curves,
    limit: 80000,
  });
  let det = {};
  let findings = [];
  if ((rows || []).length < 20) {
    warnings.push(`insufficient_rows_for_ai:${rows?.length || 0}`);
  } else {
    try {
      const ai = await callAiInterpret({
        wellId,
        fromDepth: range.fromDepth,
        toDepth: range.toDepth,
        curves,
        rows,
      });
      det = ai?.deterministic || ai || {};
      findings = Array.isArray(det?.intervalFindings) ? det.intervalFindings : [];
    } catch (err) {
      warnings.push(`ai_interpret_unavailable:${err?.message || "unknown_error"}`);
      det = {};
      findings = [];
    }
  }

  const buckets = buildTimelineBuckets(range.fromDepth, range.toDepth, bucketSize);
  if (!buckets.length) {
    return {
      wellId,
      fromDepth: range.fromDepth,
      toDepth: range.toDepth,
      bucketSize: Math.max(0.1, Number(bucketSize) || 10),
      timeline: [],
      versions: {
        detModelVersion: DET_MODEL_VERSION,
        thresholdVersion: THRESHOLD_VERSION,
        featureVersion: FEATURE_VERSION,
        algoHash: makeAlgoHash([FEATURE_VERSION, DET_MODEL_VERSION, THRESHOLD_VERSION]),
      },
      warnings,
    };
  }

  for (const f of findings) {
    const f0 = Number(f?.fromDepth);
    const f1 = Number(f?.toDepth);
    if (!Number.isFinite(f0) || !Number.isFinite(f1)) continue;
    const lo = Math.min(f0, f1);
    const hi = Math.max(f0, f1);
    const width = Math.max(1e-9, hi - lo);
    const conf = Math.max(0, Math.min(1, Number(f?.confidence ?? det?.detectionConfidence ?? 0)));
    const sev = toSeverityScore(f?.severity ?? f?.score ?? det?.severityBand);

    for (const b of buckets) {
      const ov = overlapLen(lo, hi, b.from, b.to);
      if (ov <= 0) continue;
      b.count += ov / width;
      if (conf > b.maxConfidence) b.maxConfidence = conf;
      if (sev > b.severity) b.severity = sev;
    }
  }

  const maxCount = Math.max(0, ...buckets.map((b) => b.count));
  const timeline = buckets.map((b) => ({
    from: Number(b.from.toFixed(4)),
    to: Number(b.to.toFixed(4)),
    density: maxCount > 0 ? Number((b.count / maxCount).toFixed(4)) : 0,
    maxConfidence: Number(b.maxConfidence.toFixed(4)),
    severity: Number(b.severity.toFixed(4)),
  }));

  return {
    wellId,
    fromDepth: range.fromDepth,
    toDepth: range.toDepth,
    bucketSize: Math.max(0.1, Number(bucketSize) || 10),
    timeline,
    versions: {
      detModelVersion: DET_MODEL_VERSION,
      thresholdVersion: THRESHOLD_VERSION,
      featureVersion: FEATURE_VERSION,
      algoHash: makeAlgoHash([FEATURE_VERSION, DET_MODEL_VERSION, THRESHOLD_VERSION]),
    },
    warnings,
  };
}

export { FEATURE_VERSION as TIMELINE_FEATURE_VERSION };

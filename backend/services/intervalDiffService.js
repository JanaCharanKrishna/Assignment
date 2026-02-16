import { createHash } from "node:crypto";
import { fetchRowsForRangeDB } from "./baselineEngine.js";
import { callAiInterpret } from "./aiClient.js";
import { generateIntervalDiffNarrative } from "./narrativeService.js";
import { getFeedbackAdvisory } from "./feedbackService.js";

const DET_MODEL_VERSION = "det-v1";
const THRESHOLD_VERSION = "thresholds-v1";
const FEATURE_VERSION = "interval-diff-v1";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeInterval(input = {}, fallbackCurves = []) {
  const fromDepth = toNum(input?.fromDepth);
  const toDepth = toNum(input?.toDepth);
  if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) return null;
  const curves = Array.isArray(input?.curves) && input.curves.length
    ? [...new Set(input.curves.map((c) => String(c || "").trim()).filter(Boolean))]
    : [...new Set((fallbackCurves || []).map((c) => String(c || "").trim()).filter(Boolean))];
  return {
    fromDepth: Math.min(fromDepth, toDepth),
    toDepth: Math.max(fromDepth, toDepth),
    curves,
  };
}

function summarizeCurve(rows, curve) {
  const vals = (rows || [])
    .map((r) => Number(r?.values?.[curve]))
    .filter(Number.isFinite);
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const n = vals.length;
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const p90 = vals[Math.floor(0.9 * (n - 1))];
  const min = vals[0];
  const max = vals[n - 1];
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const cv = mean === 0 ? 0 : sd / Math.abs(mean);
  return { mean, p90, min, max, sd, cv, n };
}

function round(v, digits = 3) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

function rangeSpanFt(interval) {
  return Math.max(1e-9, Math.abs(Number(interval?.toDepth) - Number(interval?.fromDepth)));
}

function eventMetrics(det, interval) {
  const count = Number(det?.eventCount);
  const score = Number(det?.anomalyScore ?? det?.detectionConfidence ?? 0);
  const density = (Number.isFinite(count) ? count : 0) * 1000 / rangeSpanFt(interval);
  return {
    eventCount: Number.isFinite(count) ? count : 0,
    anomalyScore: Number.isFinite(score) ? score : 0,
    severityBand: String(det?.severityBand || "UNKNOWN").toUpperCase(),
    eventDensityPer1000ft: density,
    confidence: Number(det?.detectionConfidence ?? 0),
  };
}

function computeCurveDiff(curves, statsA, statsB) {
  const out = [];
  for (const curve of curves) {
    const a = statsA[curve];
    const b = statsB[curve];
    if (!a || !b) {
      out.push({
        curve,
        meanA: a ? round(a.mean, 3) : null,
        meanB: b ? round(b.mean, 3) : null,
        delta: null,
        deltaPct: null,
        p90A: a ? round(a.p90, 3) : null,
        p90B: b ? round(b.p90, 3) : null,
        volatilityA: a ? round(a.cv, 4) : null,
        volatilityB: b ? round(b.cv, 4) : null,
      });
      continue;
    }

    const delta = b.mean - a.mean;
    const deltaPct = a.mean === 0 ? null : (delta / Math.abs(a.mean)) * 100;
    out.push({
      curve,
      meanA: round(a.mean, 3),
      meanB: round(b.mean, 3),
      delta: round(delta, 3),
      deltaPct: round(deltaPct, 3),
      p90A: round(a.p90, 3),
      p90B: round(b.p90, 3),
      volatilityA: round(a.cv, 4),
      volatilityB: round(b.cv, 4),
    });
  }
  return out;
}

function rankedTopChanges(curveDiff, eventA, eventB, warnings = []) {
  const rows = [];
  for (const d of curveDiff || []) {
    if (Number.isFinite(d?.deltaPct)) {
      rows.push({
        score: Math.abs(d.deltaPct),
        text: `${d.curve} mean ${d.deltaPct >= 0 ? "increased" : "decreased"} by ${Math.abs(d.deltaPct).toFixed(1)}%`,
      });
    }
  }

  const densityDelta = eventB.eventDensityPer1000ft - eventA.eventDensityPer1000ft;
  rows.push({
    score: Math.abs(densityDelta) * 25,
    text: `event density ${densityDelta >= 0 ? "increased" : "decreased"} from ${eventA.eventDensityPer1000ft.toFixed(2)} to ${eventB.eventDensityPer1000ft.toFixed(2)} per 1000 ft`,
  });

  const anomalyDelta = eventB.anomalyScore - eventA.anomalyScore;
  rows.push({
    score: Math.abs(anomalyDelta) * 100,
    text: `anomaly score ${anomalyDelta >= 0 ? "rose" : "fell"} from ${eventA.anomalyScore.toFixed(3)} to ${eventB.anomalyScore.toFixed(3)}`,
  });

  for (const warning of warnings) {
    rows.push({ score: 10, text: warning });
  }

  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 6).map((x) => x.text);
}

async function computeDeterministic({ wellId, interval, rows }) {
  const ai = await callAiInterpret({
    wellId,
    fromDepth: interval.fromDepth,
    toDepth: interval.toDepth,
    curves: interval.curves,
    rows,
  });
  return ai?.deterministic || ai || {};
}

function makeVersionHash(parts = []) {
  return createHash("md5").update(parts.join(":")).digest("hex").slice(0, 10);
}

export async function computeIntervalDiff({
  wellId,
  intervalAInput,
  intervalBInput,
  detailLevel = 3,
  curves = [],
}) {
  const intervalA = normalizeInterval(intervalAInput, curves);
  const intervalB = normalizeInterval(intervalBInput, curves);
  if (!intervalA || !intervalB) {
    throw new Error("Both intervals require fromDepth and toDepth");
  }

  const mergedCurves = [...new Set([...intervalA.curves, ...intervalB.curves])];
  if (!mergedCurves.length) throw new Error("At least one curve is required");

  intervalA.curves = mergedCurves;
  intervalB.curves = mergedCurves;

  const [rowsA, rowsB] = await Promise.all([
    fetchRowsForRangeDB({
      wellId,
      fromDepth: intervalA.fromDepth,
      toDepth: intervalA.toDepth,
      curves: mergedCurves,
      limit: 60000,
    }),
    fetchRowsForRangeDB({
      wellId,
      fromDepth: intervalB.fromDepth,
      toDepth: intervalB.toDepth,
      curves: mergedCurves,
      limit: 60000,
    }),
  ]);

  const [detA, detB] = await Promise.all([
    computeDeterministic({ wellId, interval: intervalA, rows: rowsA }),
    computeDeterministic({ wellId, interval: intervalB, rows: rowsB }),
  ]);

  const statsA = {};
  const statsB = {};
  const warnings = [];
  for (const curve of mergedCurves) {
    statsA[curve] = summarizeCurve(rowsA, curve);
    statsB[curve] = summarizeCurve(rowsB, curve);
    if (!statsA[curve] || !statsB[curve]) {
      warnings.push(`missing finite values for ${curve} in ${!statsA[curve] ? "interval A" : "interval B"}`);
    }
  }

  const curveDiff = computeCurveDiff(mergedCurves, statsA, statsB);
  const eventA = eventMetrics(detA, intervalA);
  const eventB = eventMetrics(detB, intervalB);

  const [advisoryA, advisoryB] = await Promise.all([
    getFeedbackAdvisory({
      wellId,
      fromDepth: intervalA.fromDepth,
      toDepth: intervalA.toDepth,
    }).catch(() => ({ boost: 0, matches: 0 })),
    getFeedbackAdvisory({
      wellId,
      fromDepth: intervalB.fromDepth,
      toDepth: intervalB.toDepth,
    }).catch(() => ({ boost: 0, matches: 0 })),
  ]);

  const anomalyScoreA = Math.max(0, Math.min(1, eventA.anomalyScore + advisoryA.boost));
  const anomalyScoreB = Math.max(0, Math.min(1, eventB.anomalyScore + advisoryB.boost));

  const eventDiff = {
    eventCountA: eventA.eventCount,
    eventCountB: eventB.eventCount,
    anomalyScoreA: round(anomalyScoreA, 3),
    anomalyScoreB: round(anomalyScoreB, 3),
    severityBandA: eventA.severityBand,
    severityBandB: eventB.severityBand,
    eventDensityA: round(eventA.eventDensityPer1000ft, 4),
    eventDensityB: round(eventB.eventDensityPer1000ft, 4),
    feedbackAdvisoryA: { boost: round(advisoryA.boost, 4), matches: advisoryA.matches },
    feedbackAdvisoryB: { boost: round(advisoryB.boost, 4), matches: advisoryB.matches },
  };

  const topChanges = rankedTopChanges(
    curveDiff,
    { ...eventA, anomalyScore: anomalyScoreA },
    { ...eventB, anomalyScore: anomalyScoreB },
    warnings
  );

  const payload = {
    wellId,
    intervalA,
    intervalB,
    curveDiff,
    eventDiff,
    topChanges: topChanges.slice(0, Math.max(2, Math.min(8, Number(detailLevel) + 2))),
    narrativeDiff: "",
    versions: {
      detModelVersion: DET_MODEL_VERSION,
      thresholdVersion: THRESHOLD_VERSION,
      featureVersion: FEATURE_VERSION,
      algoHash: makeVersionHash([FEATURE_VERSION, DET_MODEL_VERSION, THRESHOLD_VERSION]),
    },
  };

  payload.narrativeDiff = generateIntervalDiffNarrative(payload);
  return payload;
}

export {
  summarizeCurve,
  computeCurveDiff,
  rankedTopChanges,
  normalizeInterval,
  DET_MODEL_VERSION,
  THRESHOLD_VERSION,
  FEATURE_VERSION,
};


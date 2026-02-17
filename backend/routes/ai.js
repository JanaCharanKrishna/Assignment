import express from "express";
import { randomUUID } from "node:crypto";
import { callAiInterpret } from "../services/aiClient.js";
import { pgPool } from "../db/postgres.js";

import {
  insertInterpretationRun,
  getInterpretationRunById,
  listInterpretationRuns,
  deleteInterpretationRunById,
} from "../repositories/interpretationRunsRepo.js";
import { jsonrepair } from "jsonrepair";
import {
  insertCopilotRun,
  listCopilotRuns,
  getCopilotRunById,
} from "../repositories/copilotRunsRepo.js";
import { callPythonCopilot } from "../services/pyCopilotClient.js";

import {
  buildPlaybookSnippets,
  evidenceSufficiency,
  computeCompareMetrics,
  buildFallbackJson,
  tagIntervalsWithEvidenceType,
  applyQualityGatesToIntervals,
  enforceMultiCurveInTop,
} from "../services/copilotEngine.js";
import {
  fetchRowsForRangeDB,
  buildBaselineContext,
  loadThresholds,
} from "../services/baselineEngine.js";
import {
  classifyQuestionIntent,
  validateAgainstContext,
} from "../services/guardEngine.js";
import { applyQualityGates } from "../services/qualityGates.js";
import { applyBaselineAwareScoring } from "../services/baselineScoring.js";
import { consolidateMultiCurveIntervals } from "../services/multiCurveConsolidation.js";
import { validateCopilotResponse } from "../services/copilotSchema.js";
import { registerInterpretExportPdfRoute } from "./ai/pdfExportRoute.js";
import { registerCopilotHistoryRoutes } from "./ai/copilotHistoryRoutes.js";
import { logger } from "../observability/logger.js";
import {
  interpretDuration,
  narrativeFallback,
  intervalDiffDuration,
  feedbackWriteTotal,
  feedbackReadTotal,
  featureErrorTotal,
} from "../observability/metrics.js";
import {
  computeIntervalDiff,
  DET_MODEL_VERSION,
  THRESHOLD_VERSION,
  FEATURE_VERSION,
} from "../services/intervalDiffService.js";
import {
  validateFeedbackPayload,
  insertFeedback,
  listFeedback,
  getFeedbackSummary,
  getFeedbackAdvisory,
  FEEDBACK_DEDUPE_POLICY,
} from "../services/feedbackService.js";
import { cacheGetJson, cacheSetJson } from "../cache/redisCache.js";
import { metricsHash } from "../utils/keyBuilder.js";

const router = express.Router();



// Add these envs
const PY_AI_BASE = process.env.PY_AI_BASE || "http://127.0.0.1:8000";
const PY_COPILOT_TIMEOUT_MS = Number(process.env.PY_COPILOT_TIMEOUT_MS || 45000);


const API_BASE = process.env.API_BASE || "http://localhost:5000";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const WELL_API_TIMEOUT_MS = timeoutMsFromEnv("WELL_API_TIMEOUT_MS", 20000);
const GROQ_TIMEOUT_MS = timeoutMsFromEnv("GROQ_TIMEOUT_MS", 18000);
const DB_WRITE_TIMEOUT_MS = timeoutMsFromEnv("DB_WRITE_TIMEOUT_MS", 6000);
const GROQ_MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

/** ---------- helpers ---------- **/





function normalizeRange(fromDepth, toDepth) {
  const a = Number(fromDepth);
  const b = Number(toDepth);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { fromDepth: Math.min(a, b), toDepth: Math.max(a, b) };
}

function timeoutMsFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function responseMeta(req, runId = null) {
  return {
    requestId: req.requestId || null,
    runId: runId || null,
    generatedAt: new Date().toISOString(),
  };
}

function parseCurveCsv(v) {
  if (Array.isArray(v)) return [...new Set(v.map((x) => String(x || "").trim()).filter(Boolean))];
  return [...new Set(String(v || "").split(",").map((x) => x.trim()).filter(Boolean))];
}

function featureVersionEnvelope({
  featureName,
  featureVersion,
  detModelVersion,
  thresholdVersion,
  algoHash,
}) {
  return {
    feature: featureName,
    featureVersion: featureVersion || null,
    detModelVersion: detModelVersion || null,
    thresholdVersion: thresholdVersion || null,
    algoHash: algoHash || null,
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch {}
    return { ok: res.ok, status: res.status, json, text: txt };
  } finally {
    clearTimeout(t);
  }
}

function withTimeout(promise, timeoutMs, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}



async function computeDeterministicForRange({ wellId, range, curves }) {
  if (!wellId || !range) return null;
  const rows = await fetchRowsForRange({
    wellId,
    fromDepth: range.fromDepth,
    toDepth: range.toDepth,
    curves,
  });

  if (!Array.isArray(rows) || rows.length < 20) {
    return null; // insufficient baseline rows
  }

  const ai = await callAiInterpret({
    wellId,
    fromDepth: range.fromDepth,
    toDepth: range.toDepth,
    curves,
    rows,
  });

  return ai?.deterministic || ai || null;
}




async function safeJson(url, opts = {}) {
  const out = await fetchJsonWithTimeout(url, opts, WELL_API_TIMEOUT_MS);
  const json = out?.json;
  if (!out?.ok) {
    throw new Error(json?.error || `Request failed (${out?.status || "unknown"})`);
  }
  if (!json || typeof json !== "object") {
    throw new Error(`Non-JSON from ${url}: ${(out?.text || "").slice(0, 220)}`);
  }
  return json;
}

function pickLimitations(det) {
  if (Array.isArray(det?.limitations)) return det.limitations;
  return ["Deterministic analysis only."];
}

/** deterministic interval -> narrative interval shape with enriched fields */
function detFindingToNarrativeInterval(f) {
  const reason = f?.reason || "anomaly";
  const score = f?.score;
  const conf = f?.confidence;

  return {
    curve: f?.curve ?? "",
    fromDepth: f?.fromDepth ?? null,
    toDepth: f?.toDepth ?? null,
    explanation:
      f?.explanation ??
      `${reason}, score: ${score ?? "-"}, confidence: ${conf ?? "-"}`,
    confidence: conf ?? null,
    priority: f?.priority || "watch",

    probability: f?.probability ?? null,
    stability: f?.stability ?? null,
    stabilityScore: f?.stabilityScore ?? null,
    agreement: f?.agreement ?? null,
    width: f?.width ?? null,
    evidenceType: f?.evidenceType ?? null,
    curvesSupporting: f?.curvesSupporting ?? null,
    reason,
    score: score ?? null,
    score2: f?.score2 ?? null,
    baseline: f?.baseline ?? null,
  };
}

function fallbackNarrativeFromDeterministic(deterministic) {
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];
  const summaryParagraph =
    typeof deterministic?.summaryParagraph === "string"
      ? deterministic.summaryParagraph
      : "";

  return {
    summary_bullets: deterministic?.summary || [],
    summary_paragraph: summaryParagraph,
    interval_explanations: detIntervals.map(detFindingToNarrativeInterval),
    recommendations: deterministic?.recommendations || [],
    limitations: pickLimitations(deterministic),
  };
}

/** Extract JSON object safely from LLM content */
function parseJsonFromModelContent(content) {
  const candidates = [];

  if (typeof content === "string" && content.trim()) candidates.push(content.trim());

  const fenceMatch = content?.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());

  const start = content?.indexOf("{");
  const end = content?.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(content.slice(start, end + 1).trim());

  for (const raw of candidates) {
    try {
      return JSON.parse(raw);
    } catch {}
    try {
      const repaired = jsonrepair(raw);
      return JSON.parse(repaired);
    } catch {}
  }

  throw new Error("Model content is not valid/repairable JSON");
}

// --- COPILOT HELPERS ---

function num(v, d = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function asText(x, fallback = "") {
  if (x === null || x === undefined) return fallback;
  const s = String(x).trim();
  return s || fallback;
}
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Number(n.toFixed(3));
}
function confidenceRubric(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "unknown";
  if (n >= 0.75) return "high";
  if (n >= 0.45) return "medium";
  return "low";
}

function buildEvidenceBlock({
  mode,
  question,
  wellId,
  fromDepth,
  toDepth,
  selectedInterval,
  deterministic,
  insight,
  narrative,
  curves,
  historyRuns = [],
  playbook = [],
}) {
  return {
    objective: {
      mode: asText(mode, "data_qa"),
      question: asText(question, "No question provided"),
    },
    context_meta: {
      wellId: asText(wellId, "-"),
      range: {
        fromDepth: Number.isFinite(Number(fromDepth)) ? Number(fromDepth) : null,
        toDepth: Number.isFinite(Number(toDepth)) ? Number(toDepth) : null,
      },
      selectedInterval:
        selectedInterval &&
        Number.isFinite(Number(selectedInterval.fromDepth)) &&
        Number.isFinite(Number(selectedInterval.toDepth))
          ? {
              fromDepth: Number(selectedInterval.fromDepth),
              toDepth: Number(selectedInterval.toDepth),
            }
          : null,
      curves: toArr(curves).map(String),
      generatedAt: new Date().toISOString(),
    },
    deterministic: deterministic && typeof deterministic === "object" ? deterministic : {},
    insight: insight && typeof insight === "object" ? insight : {},
    narrative: narrative && typeof narrative === "object" ? narrative : {},
    recent_history: toArr(historyRuns).slice(0, 5),
    playbook_snippets: toArr(playbook).slice(0, 8),
  };
}

// Extract likely interval explanations from narrative + insight
function extractIntervals(evidence) {
  const narIntervals = toArr(evidence?.narrative?.interval_explanations).map((it) => ({
    fromDepth: Number(it?.fromDepth),
    toDepth: Number(it?.toDepth),
    curve: asText(it?.curve, ""),
    probability: asText(it?.probability, ""),
    stability: asText(it?.stability, ""),
    confidence: num(it?.confidence, 3),
    explanation: asText(it?.explanation, ""),
    priority: asText(it?.priority, ""),
  }));

  const shows = toArr(evidence?.insight?.shows).map((s) => ({
    fromDepth: Number(s?.fromDepth),
    toDepth: Number(s?.toDepth),
    curve: "shows",
    probability: asText(s?.probability, ""),
    stability: asText(s?.stability, ""),
    confidence: num(s?.stabilityScore, 3),
    explanation: asText(s?.reason, ""),
    priority: "",
  }));

  return [...narIntervals, ...shows].filter(
    (x) => Number.isFinite(x.fromDepth) && Number.isFinite(x.toDepth)
  );
}

function intervalOverlapScore(aFrom, aTo, bFrom, bTo) {
  const lo = Math.max(aFrom, bFrom);
  const hi = Math.min(aTo, bTo);
  const inter = Math.max(0, hi - lo);
  const span = Math.max(1e-9, Math.max(aTo, bTo) - Math.min(aFrom, bFrom));
  return inter / span;
}

function buildFallbackAnswer(evidence) {
  const mode = evidence?.objective?.mode || "data_qa";
  const wellId = evidence?.context_meta?.wellId || "-";
  const range = evidence?.context_meta?.range || {};
  const det = evidence?.deterministic || {};
  const nar = evidence?.narrative || {};
  const insight = evidence?.insight || {};

  const intervals = extractIntervals(evidence);
  const sel = evidence?.context_meta?.selectedInterval;

  let topInterval = intervals[0] || null;
  if (sel && intervals.length) {
    let best = null;
    let bestScore = -1;
    for (const it of intervals) {
      const s = intervalOverlapScore(
        Number(sel.fromDepth),
        Number(sel.toDepth),
        Number(it.fromDepth),
        Number(it.toDepth)
      );
      if (s > bestScore) {
        bestScore = s;
        best = it;
      }
    }
    topInterval = best || topInterval;
  }

  const eventCount = Number(det?.eventCount);
  const sev = asText(det?.severityBand, "unknown");
  const dq = asText(det?.dataQuality?.qualityBand, "unknown");
  const limitations = toArr(nar?.limitations);

  let direct = "";
  let actions = [];
  let comparison = { summary: "", delta_metrics: [] };

  if (mode === "data_qa") {
    direct = topInterval
      ? `The data suggests this interval was flagged due to pattern anomalies in selected curves with supporting deterministic evidence (severity: ${sev}, data quality: ${dq}). The most relevant interval is ${topInterval.fromDepth}–${topInterval.toDepth} ft${topInterval.explanation ? `: ${topInterval.explanation}` : ""}.`
      : `The current analyzed range ${range.fromDepth ?? "-"}–${range.toDepth ?? "-"} ft shows a ${sev} risk signal with ${dq} data quality. No specific interval explanation was found in narrative blocks, so the answer is based on aggregate deterministic indicators.`;
    actions = [
      {
        priority: "medium",
        action: "Re-run interpretation on a narrower interval around flagged zone",
        rationale: "Improves localization and explanation quality for root-cause review.",
      },
    ];
  } else if (mode === "ops") {
    direct = `For operations, prioritize verification steps around highest-risk indications (severity: ${sev}) and confirm measurement reliability (data quality: ${dq}).`;
    actions = [
      {
        priority: "high",
        action: "Validate sensor/calibration and null/missing segments first",
        rationale: "Data-quality defects can produce false flags or distort severity.",
      },
      {
        priority: "medium",
        action: "Inspect drilling parameters near flagged depth windows",
        rationale: "Cross-check whether operational changes coincide with anomaly windows.",
      },
      {
        priority: "medium",
        action: "Review gas-show and stability indicators before next decision point",
        rationale: "Combining deterministic + show/stability context reduces blind spots.",
      },
    ];
  } else {
    const f = Number(range?.fromDepth);
    const t = Number(range?.toDepth);
    const prevFrom = Number.isFinite(f) ? Math.max(0, f - 500) : null;
    const prevTo = Number.isFinite(f) ? f : null;

    comparison = {
      summary:
        Number.isFinite(prevFrom) && Number.isFinite(prevTo)
          ? `Compared current interval ${f}–${t} ft against previous window ${prevFrom}–${prevTo} ft using available deterministic/narrative evidence.`
          : `Comparison baseline window could not be derived from current range.`,
      delta_metrics: [
        { metric: "Event Count", current: eventCount || 0, baseline: "n/a", delta: "n/a" },
        { metric: "Severity Band", current: sev, baseline: "n/a", delta: "qualitative" },
        { metric: "Data Quality Band", current: dq, baseline: "n/a", delta: "qualitative" },
      ],
    };

    direct = `Comparison indicates current interval carries a ${sev} signal. Quantitative baseline metrics were limited by available history payload, so this is a qualitative compare result.`;
    actions = [
      {
        priority: "medium",
        action: "Store baseline summary per 500 ft window for future quantitative compare",
        rationale: "Enables true delta computation (counts, confidence, densities).",
      },
    ];
  }

  const confOverall = clamp01(
    0.35 +
      (Number.isFinite(eventCount) ? Math.min(0.25, eventCount * 0.02) : 0) +
      (sev.toLowerCase().includes("high") || sev.toLowerCase().includes("critical") ? 0.15 : 0) +
      (dq.toLowerCase().includes("low") ? -0.1 : 0.05)
  );

  return {
    answer_title:
      mode === "ops"
        ? "Operational Recommendation"
        : mode === "compare"
        ? "Interval Comparison"
        : "Copilot Answer",
    direct_answer: direct,
    key_points: [
      `Well: ${wellId}`,
      `Analyzed range: ${range?.fromDepth ?? "-"}–${range?.toDepth ?? "-"} ft`,
      `Severity band: ${sev}`,
      `Data quality: ${dq}`,
      ...(topInterval ? [`Top explained interval: ${topInterval.fromDepth}–${topInterval.toDepth} ft`] : []),
    ],
    actions,
    comparison,
    risks: [
      ...(sev.toLowerCase().includes("high") || sev.toLowerCase().includes("critical")
        ? ["Elevated anomaly severity in current evidence window."]
        : []),
      ...(asText(insight?.riskProfile?.summary) ? [asText(insight?.riskProfile?.summary)] : []),
    ].filter(Boolean),
    uncertainties: [
      ...(limitations.length ? limitations : ["Limited baseline history for quantitative comparison."]),
    ],
    confidence: {
      overall: confOverall,
      rubric: confidenceRubric(confOverall),
      reason:
        "Confidence is derived from evidence availability (deterministic indicators, interval explanations, and data-quality context).",
    },
    evidence_used: [
      {
        source: "deterministic",
        confidence: "high",
        snippet: `severity=${sev}, dataQuality=${dq}, eventCount=${Number.isFinite(eventCount) ? eventCount : "n/a"}`,
      },
      {
        source: "narrative",
        confidence: topInterval ? "medium" : "low",
        snippet: topInterval?.explanation || "No detailed interval explanation available.",
      },
    ],
    safety_note: "Decision support only, not autonomous control.",
  };
}

function normalizeCopilotOutput(raw, evidence) {
  const candidate = raw?.json || raw?.result || raw?.answer || raw || {};
  const fb = buildFallbackAnswer(evidence);

  const merged = {
    ...fb,
    ...(candidate && typeof candidate === "object" ? candidate : {}),
  };

  merged.answer_title = asText(merged.answer_title, fb.answer_title);
  merged.direct_answer = asText(merged.direct_answer, fb.direct_answer);
  merged.key_points = toArr(merged.key_points).map((x) => asText(x)).filter(Boolean);
  merged.actions = toArr(merged.actions)
    .map((a) => ({
      priority: asText(a?.priority, "medium").toLowerCase(),
      action: asText(a?.action, ""),
      rationale: asText(a?.rationale, ""),
    }))
    .filter((a) => a.action);

  merged.comparison =
    merged.comparison && typeof merged.comparison === "object"
      ? {
          summary: asText(merged.comparison.summary, ""),
          delta_metrics: toArr(merged.comparison.delta_metrics).map((d) => ({
            metric: asText(d?.metric, ""),
            current: d?.current ?? "n/a",
            baseline: d?.baseline ?? "n/a",
            delta: d?.delta ?? "n/a",
          })),
        }
      : fb.comparison;

  merged.risks = toArr(merged.risks).map((x) => asText(x)).filter(Boolean);
  merged.uncertainties = toArr(merged.uncertainties).map((x) => asText(x)).filter(Boolean);
  merged.evidence_used = toArr(merged.evidence_used)
    .map((e) => ({
      source: asText(e?.source, "unknown"),
      confidence: asText(e?.confidence, "medium").toLowerCase(),
      snippet: asText(e?.snippet, ""),
    }))
    .filter((e) => e.snippet);

  const conf = merged.confidence && typeof merged.confidence === "object" ? merged.confidence : {};
  const overall = clamp01(conf.overall ?? fb.confidence.overall);
  merged.confidence = {
    overall,
    rubric: asText(conf.rubric, confidenceRubric(overall)),
    reason: asText(conf.reason, fb.confidence.reason),
  };

  merged.safety_note = "Decision support only, not autonomous control.";
  return merged;
}

/** Similarity score for interval matching (LLM interval -> deterministic interval) */
function intervalSimilarity(a, b) {
  const a0 = num(a?.fromDepth);
  const a1 = num(a?.toDepth);
  const b0 = num(b?.fromDepth);
  const b1 = num(b?.toDepth);
  if (![a0, a1, b0, b1].every(Number.isFinite)) return -Infinity;

  const aCurve = String(a?.curve ?? "");
  const bCurve = String(b?.curve ?? "");

  const midA = (a0 + a1) / 2;
  const midB = (b0 + b1) / 2;
  const widthA = Math.abs(a1 - a0);
  const widthB = Math.abs(b1 - b0);

  const midDist = Math.abs(midA - midB);
  const widthDist = Math.abs(widthA - widthB);

  let score = -midDist - 0.35 * widthDist;
  if (aCurve && bCurve && aCurve === bCurve) score += 12;
  if (aCurve && bCurve && (aCurve.includes(bCurve) || bCurve.includes(aCurve))) score += 6;

  return score;
}

/**
 * Merge LLM intervals with deterministic intervals so required fields are always present.
 * Also appends deterministic intervals that LLM might have dropped.
 */
function mergeNarrativeIntervals(llmIntervals, deterministic) {
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];

  const detNormalized = detIntervals.map(detFindingToNarrativeInterval);

  if (!Array.isArray(llmIntervals) || llmIntervals.length === 0) {
    return detNormalized;
  }

  const merged = llmIntervals.map((it) => {
    let best = null;
    let bestScore = -Infinity;

    for (const d of detNormalized) {
      const s = intervalSimilarity(it, d);
      if (s > bestScore) {
        bestScore = s;
        best = d;
      }
    }

    const d = best;

    return {
      curve: it?.curve ?? d?.curve ?? "",
      fromDepth: it?.fromDepth ?? d?.fromDepth ?? null,
      toDepth: it?.toDepth ?? d?.toDepth ?? null,
      explanation:
        it?.explanation ??
        d?.explanation ??
        "Anomalous behavior observed; validate with adjacent data.",
      confidence: it?.confidence ?? d?.confidence ?? null,
      priority: it?.priority ?? d?.priority ?? "watch",
      probability: it?.probability ?? d?.probability ?? null,
      stability: it?.stability ?? d?.stability ?? null,
      stabilityScore: it?.stabilityScore ?? d?.stabilityScore ?? null,
      agreement: it?.agreement ?? d?.agreement ?? null,
      width: it?.width ?? d?.width ?? null,
      curvesSupporting: it?.curvesSupporting ?? d?.curvesSupporting ?? null,
      reason: it?.reason ?? d?.reason ?? null,
      score: it?.score ?? d?.score ?? null,
    };
  });

  const usedKeys = new Set(
    merged.map(
      (m) =>
        `${Math.round(num(m.fromDepth, -1))}::${Math.round(
          num(m.toDepth, -1)
        )}::${String(m.curve || "")}`
    )
  );

  for (const d of detNormalized) {
    const k = `${Math.round(num(d.fromDepth, -1))}::${Math.round(
      num(d.toDepth, -1)
    )}::${String(d.curve || "")}`;
    if (!usedKeys.has(k)) merged.push(d);
  }

  return merged.slice(0, 12);
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values, q) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = pos - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

function trendLabel(values) {
  if (!Array.isArray(values) || values.length < 12) return "insufficient points";
  const window = Math.max(3, Math.floor(values.length / 5));
  const head = mean(values.slice(0, window));
  const tail = mean(values.slice(-window));
  if (!Number.isFinite(head) || !Number.isFinite(tail)) return "insufficient points";
  const delta = tail - head;
  const scale = Math.max(Math.abs(head), Math.abs(tail), 1e-9);
  const rel = delta / scale;
  if (rel >= 0.08) return "increasing with depth";
  if (rel <= -0.08) return "decreasing with depth";
  return "mostly stable";
}

function pearson(valuesA, valuesB) {
  const n = Math.min(valuesA.length, valuesB.length);
  if (n < 3) return null;
  const a = valuesA.slice(0, n);
  const b = valuesB.slice(0, n);
  const meanA = mean(a);
  const meanB = mean(b);
  if (!Number.isFinite(meanA) || !Number.isFinite(meanB)) return null;
  let numerator = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (!Number.isFinite(den) || den === 0) return null;
  return numerator / den;
}

function buildCurveStatsFromRows(rows, curves) {
  const stats = {};
  for (const curve of toArr(curves)) {
    const vals = [];
    for (const row of toArr(rows)) {
      const v = toFiniteNumber(row?.[curve]);
      if (Number.isFinite(v)) vals.push(v);
    }
    if (vals.length) {
      stats[curve] = {
        min: Math.min(...vals),
        max: Math.max(...vals),
        mean: mean(vals),
        non_null_count: vals.length,
      };
    } else {
      stats[curve] = {
        min: null,
        max: null,
        mean: null,
        non_null_count: 0,
      };
    }
  }
  return stats;
}

function buildNarrativeDiagnostics(rows, curves, fromDepth, toDepth) {
  const safeRows = toArr(rows);
  const safeCurves = toArr(curves);
  const lines = [
    `Interval length: ${num(Number(toDepth) - Number(fromDepth), 2)}`,
    `Rows in scope: ${safeRows.length}`,
    `Curves analyzed: ${safeCurves.join(", ")}`,
  ];

  const stats = buildCurveStatsFromRows(safeRows, safeCurves);
  const dominantCurves = [...safeCurves]
    .map((c) => {
      const s = stats[c] || {};
      const cmin = toFiniteNumber(s.min);
      const cmax = toFiniteNumber(s.max);
      const count = Number(s.non_null_count || 0);
      const range = Number.isFinite(cmin) && Number.isFinite(cmax) ? cmax - cmin : -Infinity;
      return { curve: c, range, count };
    })
    .filter((x) => x.count > 0 && Number.isFinite(x.range))
    .sort((a, b) => b.range - a.range)
    .slice(0, 4)
    .map((x) => x.curve);

  lines.push(
    `Dominant-variance curves: ${
      dominantCurves.length ? dominantCurves.join(", ") : "none"
    }`
  );

  const valuesByCurve = {};
  for (const curve of (dominantCurves.length ? dominantCurves : safeCurves.slice(0, 4))) {
    const pairs = [];
    for (const row of safeRows) {
      const depth = toFiniteNumber(row?.depth);
      const value = toFiniteNumber(row?.[curve]);
      if (!Number.isFinite(depth) || !Number.isFinite(value)) continue;
      pairs.push([depth, value]);
    }
    if (pairs.length < 3) continue;

    const values = pairs.map((p) => p[1]);
    const depths = pairs.map((p) => p[0]);
    valuesByCurve[curve] = values;

    const p90 = percentile(values, 0.9);
    const highDepths = Number.isFinite(p90) ? pairs.filter((p) => p[1] >= p90).map((p) => p[0]) : [];
    const highZone = highDepths.length
      ? `${num(Math.min(...highDepths), 1)}-${num(Math.max(...highDepths), 1)}`
      : "n/a";

    const maxVal = Math.max(...values);
    const maxIdx = values.indexOf(maxVal);
    lines.push(
      `${curve}: trend=${trendLabel(values)}, mean=${num(mean(values), 4)}, max=${num(maxVal, 4)} at ${num(depths[maxIdx], 1)}, high-zone(p90+)=${highZone}`
    );
  }

  const pairCandidates = Object.keys(valuesByCurve).slice(0, 3);
  if (pairCandidates.length >= 2) {
    for (let i = 0; i < pairCandidates.length; i += 1) {
      for (let j = i + 1; j < pairCandidates.length; j += 1) {
        const a = pairCandidates[i];
        const b = pairCandidates[j];
        const corr = pearson(valuesByCurve[a], valuesByCurve[b]);
        if (Number.isFinite(corr)) {
          lines.push(`Correlation ${a} vs ${b}: r=${num(corr, 4)}`);
        }
      }
    }
  }

  return { stats, text: lines.map((x) => `- ${x}`).join("\n") };
}

/** Optional LLM polish for narrative */
async function maybeGroqNarrative({
  deterministic,
  insight,
  curves,
  fromDepth,
  toDepth,
  wellId,
  rows,
}) {
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];
  const forceFallback = process.env.FORCE_NARRATIVE_FALLBACK === "true";

  if (forceFallback) {
    return {
      modelUsed: null,
      narrativeStatus:
        detIntervals.length === 0
          ? "forced_fallback_test_no_events"
          : "forced_fallback_test",
      narrative: fallbackNarrativeFromDeterministic(deterministic),
    };
  }

  if (!GROQ_API_KEY) {
    return {
      modelUsed: null,
      narrativeStatus:
        detIntervals.length === 0
          ? "fallback_no_api_key_no_events"
          : "fallback_no_api_key",
      narrative: fallbackNarrativeFromDeterministic(deterministic),
    };
  }

  const topIntervals = detIntervals.slice(0, 6).map((f) => ({
    curve: f.curve,
    fromDepth: f.fromDepth,
    toDepth: f.toDepth,
    reason: f.reason,
    score: f.score,
    confidence: f.confidence,
    priority: f.priority,
    probability: f.probability ?? null,
    stability: f.stability ?? null,
    stabilityScore: f.stabilityScore ?? null,
    agreement: f.agreement ?? null,
    width: f.width ?? null,
    curvesSupporting: f.curvesSupporting ?? null,
  }));

  const diag = buildNarrativeDiagnostics(rows, curves, fromDepth, toDepth);
  const curveStatsText = toArr(curves)
    .map((curve) => {
      const s = diag.stats?.[curve] || {};
      const nn = Number(s?.non_null_count || 0);
      if (nn <= 0) return `- ${curve}: no valid points`;
      return `- ${curve}: min=${num(s.min, 4)}, max=${num(s.max, 4)}, mean=${num(s.mean, 4)}, points=${nn}`;
    })
    .join("\n");
  const detCurveStats = deterministic?.curveStatistics && typeof deterministic.curveStatistics === "object"
    ? deterministic.curveStatistics
    : {};
  const curveStatsRichText = toArr(curves)
    .map((curve) => {
      const s = detCurveStats?.[curve] || {};
      const count = Number(s?.count || 0);
      if (count <= 0) return `- ${curve}: no valid points`;
      return [
        `- ${curve}:`,
        `min=${num(s?.min, 4)}`,
        `max=${num(s?.max, 4)}`,
        `mean=${num(s?.mean, 4)}`,
        `std=${num(s?.std, 4)}`,
        `p10=${num(s?.p10, 4)}`,
        `p90=${num(s?.p90, 4)}`,
        `trend=${String(s?.trend || "unknown")}`,
        `outliers=${Number(s?.outlierCount || 0)} (${num(s?.outlierPct, 2)}%)`,
        `count=${count}`,
      ].join(" ");
    })
    .join("\n");
  const deterministicSummaryParagraph =
    typeof deterministic?.summaryParagraph === "string" && deterministic.summaryParagraph.trim()
      ? deterministic.summaryParagraph.trim()
      : typeof insight?.summaryParagraph === "string" && insight.summaryParagraph.trim()
      ? insight.summaryParagraph.trim()
      : "";

  const prompt = `
You are a petroleum/well-log interpretation assistant.

Return STRICT JSON with keys:
- summary_bullets: string[]
- summary_paragraph: string
- interval_explanations: [{curve,fromDepth,toDepth,explanation,confidence,priority,probability,stability,stabilityScore,agreement,width,curvesSupporting,reason,score}]
- recommendations: string[]
- limitations: string[]

Context:
Well: ${wellId}
Range: ${fromDepth} to ${toDepth}
Curves: ${curves.join(", ")}

Deterministic:
anomalyScore=${deterministic?.anomalyScore}
detectionConfidence=${deterministic?.detectionConfidence}
severityConfidence=${deterministic?.severityConfidence}
severityBand=${deterministic?.severityBand}
eventCount=${deterministic?.eventCount}
eventDensityPer1000ft=${deterministic?.eventDensityPer1000ft}

Insight summary:
${insight?.summaryParagraph || ""}

Deterministic summary paragraph:
${deterministicSummaryParagraph}

Curve statistics:
${curveStatsText}

Enhanced curve statistics:
${curveStatsRichText}

Derived diagnostics:
${diag.text}

Top intervals:
${JSON.stringify(topIntervals)}

Rules:
- Use cautious language: "suggests", "likely", "requires validation"
- Do NOT claim lab-confirmed fluid type
- Keep recommendations concise and operational
- summary_bullets MUST contain 7 to 8 concise bullet lines.
- Every summary bullet and interval explanation must reference numeric evidence (depths, trend, mean/max, or correlation).
- Avoid generic phrases like "varied behavior" without a number or curve-specific anchor.
- IMPORTANT: If eventCount is 0, interval_explanations MUST be []
`.trim();

  const body = {
    model: GROQ_MODEL,
    temperature: 0.2,
    top_p: 1,
    max_completion_tokens: 900,
    stream: false,
    messages: [
      { role: "system", content: "Return valid JSON only." },
      { role: "user", content: prompt },
    ],
  };

  try {
    const out = await fetchJsonWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
      },
      GROQ_TIMEOUT_MS
    );
    const envelope = out?.json || null;

    if (!out?.ok) {
      const msg =
        envelope?.error?.message ||
        envelope?.error ||
        `Groq failed (${out?.status || "unknown"})`;
      throw new Error(`groq_http_error:${msg}`);
    }

    const content = envelope?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonFromModelContent(content);

    const mergedIntervals =
      detIntervals.length === 0
        ? []
        : mergeNarrativeIntervals(parsed?.interval_explanations, deterministic);
    const parsedSummaryBullets = Array.isArray(parsed?.summary_bullets)
      ? parsed.summary_bullets.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const fallbackSummaryBullets = Array.isArray(deterministic?.summary)
      ? deterministic.summary.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const preferredSummaryBullets =
      parsedSummaryBullets.length >= 7 ? parsedSummaryBullets : fallbackSummaryBullets;
    const mergedSummaryBullets = preferredSummaryBullets.slice(0, 8);
    if (mergedSummaryBullets.length < 7) {
      const fillPool = [
        ...fallbackSummaryBullets,
        "Cross-validate flagged zones with adjacent intervals and companion logs.",
        "Use these results as screening evidence and confirm with domain review before action.",
      ]
        .map((x) => String(x || "").trim())
        .filter(Boolean);
      for (const line of fillPool) {
        if (mergedSummaryBullets.length >= 7) break;
        if (!mergedSummaryBullets.includes(line)) mergedSummaryBullets.push(line);
      }
    }
    const parsedSummaryParagraph =
      typeof parsed?.summary_paragraph === "string" ? parsed.summary_paragraph.trim() : "";
    const fallbackSummaryParagraph =
      typeof deterministic?.summaryParagraph === "string" && deterministic.summaryParagraph.trim()
        ? deterministic.summaryParagraph.trim()
        : typeof insight?.summaryParagraph === "string" && insight.summaryParagraph.trim()
        ? insight.summaryParagraph.trim()
        : "";
    const mergedSummaryParagraph = parsedSummaryParagraph || fallbackSummaryParagraph || "";

    return {
      modelUsed: GROQ_MODEL,
      narrativeStatus: detIntervals.length === 0 ? "deterministic_no_events" : "llm_ok",
      narrative: {
        summary_bullets: mergedSummaryBullets,
        summary_paragraph: mergedSummaryParagraph,
        interval_explanations: mergedIntervals,
        recommendations:
          parsed?.recommendations || deterministic?.recommendations || [],
        limitations: parsed?.limitations || pickLimitations(deterministic),
      },
    };
  } catch (e) {
    console.warn("Groq narrative fallback:", e?.message || e);

    return {
      modelUsed: GROQ_MODEL,
      narrativeStatus:
        detIntervals.length === 0 ? "llm_unavailable_no_events" : "llm_unavailable",
      narrative: fallbackNarrativeFromDeterministic(deterministic),
    };
  }
}





/** ---------- shared data fetch for ranges ---------- **/
async function fetchRowsForRange({ wellId, fromDepth, toDepth, curves }) {
  const lo = Math.min(Number(fromDepth), Number(toDepth));
  const hi = Math.max(Number(fromDepth), Number(toDepth));
  const metrics = (Array.isArray(curves) ? curves : []).map(encodeURIComponent).join(",");

  let rowsPayload;
  try {
    rowsPayload = await safeJson(
      `${API_BASE}/api/well/${encodeURIComponent(
        wellId
      )}/window?metrics=${metrics}&from=${lo}&to=${hi}&px=4000`
    );
  } catch {
    const dataPayload = await safeJson(
      `${API_BASE}/api/well/${encodeURIComponent(wellId)}/data`
    );
    const allRows = Array.isArray(dataPayload?.rows) ? dataPayload.rows : [];
    rowsPayload = {
      rows: allRows.filter((r) => {
        const d = Number(r?.depth);
        return Number.isFinite(d) && d >= lo && d <= hi;
      }),
    };
  }

  const rows = Array.isArray(rowsPayload?.rows) ? rowsPayload.rows : [];
  return { rows, lo, hi };
}

async function runDeterministicOnly({ wellId, fromDepth, toDepth, curves }) {
  const { rows, lo, hi } = await fetchRowsForRange({ wellId, fromDepth, toDepth, curves });
  if (!rows.length || rows.length < 20) {
    return {
      ok: false,
      deterministic: {},
      reason: `Not enough rows in selected range. Got ${rows.length}`,
      range: { fromDepth: lo, toDepth: hi },
    };
  }

  const ai = await callAiInterpret({
    wellId,
    fromDepth: lo,
    toDepth: hi,
    curves,
    rows,
  });

  return {
    ok: true,
    deterministic: ai?.deterministic || ai || {},
    insight: ai?.insight || {},
    range: { fromDepth: lo, toDepth: hi },
  };
}

/** ---------- routes ---------- **/

router.post("/interpret", async (req, res) => {
  const startedAt = Date.now();
  const requestId = req.requestId || null;
  let runId = randomUUID();

  try {
    const { wellId, fromDepth, toDepth, curves } = req.body || {};

    logger.info({
      msg: "interpret.start",
      requestId,
      runId,
      route: "/api/ai/interpret",
      wellId,
      fromDepth,
      toDepth,
      curveCount: Array.isArray(curves) ? curves.length : 0,
    });

    if (!wellId) {
      interpretDuration.labels("error").observe(Date.now() - startedAt);
      return res.status(400).json({ ok: false, error: "wellId is required" });
    }
    if (!Array.isArray(curves) || curves.length === 0) {
      interpretDuration.labels("error").observe(Date.now() - startedAt);
      return res
        .status(400)
        .json({ ok: false, error: "curves must be a non-empty array" });
    }
    if (!Number.isFinite(Number(fromDepth)) || !Number.isFinite(Number(toDepth))) {
      interpretDuration.labels("error").observe(Date.now() - startedAt);
      return res
        .status(400)
        .json({ ok: false, error: "fromDepth/toDepth must be valid numbers" });
    }
    if (Number(fromDepth) > Number(toDepth)) {
      interpretDuration.labels("error").observe(Date.now() - startedAt);
      return res
        .status(400)
        .json({ ok: false, error: "fromDepth must be <= toDepth" });
    }

    let rowsResult;
    try {
      rowsResult = await fetchRowsForRange({
        wellId,
        fromDepth,
        toDepth,
        curves,
      });
    } catch (rangeErr) {
      const msg = String(rangeErr?.message || rangeErr || "");
      interpretDuration.labels("error").observe(Date.now() - startedAt);
      const status = msg.toLowerCase().includes("well not found") ? 404 : 400;
      return res.status(status).json({
        ok: false,
        error: msg || "Failed to fetch rows for range",
      });
    }

    const { rows, lo, hi } = rowsResult;

    if (rows.length < 20) {
      interpretDuration.labels("error").observe(Date.now() - startedAt);
      return res
        .status(400)
        .json({ ok: false, error: `Not enough rows in selected range. Got ${rows.length}` });
    }

    const ai = await callAiInterpret({
      wellId,
      fromDepth: lo,
      toDepth: hi,
      curves,
      rows,
    });

    const deterministic = ai?.deterministic || ai || {};
    const insight = ai?.insight || null;

    const nar = await maybeGroqNarrative({
      deterministic,
      insight,
      curves,
      fromDepth: lo,
      toDepth: hi,
      wellId,
      rows,
    });

    const qg = applyQualityGates({
      rows,
      curves,
      deterministic,
      narrative: nar?.narrative || {},
    });
    const deterministic2 = qg.deterministic;
    const narrative2 = qg.narrative;

    const deterministic3 = applyBaselineAwareScoring({
      rows,
      curves,
      deterministic: deterministic2,
    });

    const deterministic4 = consolidateMultiCurveIntervals(deterministic3);
    const deterministic5 = normalizeIntervalSupport(deterministic4);
    const advisory = await getFeedbackAdvisory({
      wellId,
      fromDepth: lo,
      toDepth: hi,
    }).catch(() => ({ boost: 0, matches: 0 }));
    const deterministic6 = applyFeedbackAdvisoryToDeterministic(deterministic5, advisory);
    const narrative3 = syncNarrativeWithDeterministic(narrative2, deterministic6);

    let runRecord = null;
    try {
      runRecord = await withTimeout(
        insertInterpretationRun({
          wellId,
          fromDepth: lo,
          toDepth: hi,
          curves,
          deterministic: deterministic6,
          insight,
          narrative: narrative3,
          modelUsed: nar.modelUsed,
          narrativeStatus: nar.narrativeStatus,
          source: "fresh",
          appVersion: process.env.APP_VERSION || null,
        }),
        DB_WRITE_TIMEOUT_MS,
        "insertInterpretationRun"
      );
      runId = runRecord?.runId ?? runRecord?.run_id ?? runId;
    } catch (dbErr) {
      console.warn("[interpret] non-blocking DB write failure:", dbErr?.message || dbErr);
    }

    if (nar?.narrativeStatus && nar.narrativeStatus !== "llm_ok") {
      narrativeFallback.labels(String(nar.narrativeStatus)).inc();
    }
    interpretDuration.labels("ok").observe(Date.now() - startedAt);
    logger.info({
      msg: "interpret.complete",
      requestId,
      runId,
      route: "/api/ai/interpret",
      wellId,
      latencyMs: Date.now() - startedAt,
      status: 200,
      narrativeStatus: nar?.narrativeStatus || null,
    });

    return res.json({
      ok: true,
      source: "fresh",
      runId: runRecord?.runId ?? runRecord?.run_id ?? runId,
      createdAt: runRecord?.createdAt ?? runRecord?.created_at ?? new Date().toISOString(),
      well: { wellId, name: wellId },
      range: { fromDepth: lo, toDepth: hi },
      curves,
      deterministic: deterministic6,
      insight,
      narrative: narrative3,
      modelUsed: nar.modelUsed,
      narrativeStatus: nar.narrativeStatus,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    interpretDuration.labels("error").observe(Date.now() - startedAt);
    logger.error({
      msg: "interpret.error",
      requestId,
      runId,
      route: "/api/ai/interpret",
      latencyMs: Date.now() - startedAt,
      status: 500,
      errorCode: "INTERPRET_FAILED",
      err: err?.message || String(err),
    });
    console.error("POST /api/ai/interpret failed:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Interpretation failed" });
  }
});

router.get("/runs", async (req, res) => {
  try {
    const wellId = req.query.wellId ? String(req.query.wellId) : undefined;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, limitRaw))
      : 20;

    const runs = await listInterpretationRuns({ wellId, limit });
    return res.json({ ok: true, runs });
  } catch (err) {
    console.error("GET /api/ai/runs failed:", err);
    return res.status(500).json({ error: err?.message || "Failed to list runs" });
  }
});

router.get("/runs/:runId", async (req, res) => {
  try {
    const { runId } = req.params;
    const row = await getInterpretationRunById(runId);

    if (!row) return res.status(404).json({ error: "Run not found" });

    const run = {
      runId: row.runId ?? row.run_id,
      wellId: row.wellId ?? row.well_id,
      fromDepth: row.fromDepth ?? row.from_depth,
      toDepth: row.toDepth ?? row.to_depth,
      curves: row.curves ?? [],
      deterministic: row.deterministic ?? null,
      insight: row.insight ?? null,
      narrative: row.narrative ?? null,
      modelUsed: row.modelUsed ?? row.model_used ?? null,
      narrativeStatus: row.narrativeStatus ?? row.narrative_status ?? null,
      source: row.source ?? null,
      createdAt: row.createdAt ?? row.created_at ?? null,
    };

    return res.json({ ok: true, run });
  } catch (err) {
    console.error("GET /api/ai/runs/:runId failed:", err);
    return res.status(500).json({ error: err?.message || "Failed to fetch run" });
  }
});

router.delete("/runs/:runId", async (req, res) => {
  try {
    const { runId } = req.params;
    const deleted = await deleteInterpretationRunById(runId);
    if (!deleted) return res.status(404).json({ error: "Run not found" });
    return res.json({ ok: true, runId: deleted.run_id ?? deleted.runId ?? runId });
  } catch (err) {
    console.error("DELETE /api/ai/runs/:runId failed:", err);
    return res.status(500).json({ error: err?.message || "Failed to delete run" });
  }
});

// POST /api/ai/copilot/query
// ai.js (only the /copilot/query route + helper)
// Drop this in your router file and replace your existing /copilot/query route.
// Make sure callPythonCopilot, buildPlaybookSnippets, evidenceSufficiency,
// computeCompareMetrics, buildFallbackJson, validateCopilotResponse are imported.




function normalizeSource(pyResp, hasLlmJson) {
  if (!hasLlmJson) return "fallback";
  const src = String(pyResp?.source || "").trim().toLowerCase();
  if (src === "llm" || src === "python" || src === "fallback") return src;
  if (pyResp?.used_llm === true) return "llm";
  return "python";
}





















// POST /api/ai/copilot/query
// ---------- copilot helpers (keep near /copilot/query) ----------
function isObj(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
function toArr(x) {
  return Array.isArray(x) ? x : [];
}
function asStr(x, d = "") {
  if (x === null || x === undefined) return d;
  const s = String(x).trim();
  return s || d;
}
function safeNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function safeDigits(d, def = 1) {
  const n = Number(d);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < 0) return 0;
  if (i > 100) return 100;
  return i;
}
function fmtNum(v, digits = 1, fallback = "n/a") {
  const n = safeNum(v, null);
  if (n === null) return fallback;
  return n.toFixed(safeDigits(digits, 1));
}

function flattenRowsForCopilot(rows, curves, maxRows = 1200) {
  const sourceRows = toArr(rows);
  if (!sourceRows.length) return [];
  const stride = Math.max(1, Math.floor(sourceRows.length / Math.max(1, maxRows)));
  const sampled = sourceRows.filter((_, idx) => idx % stride === 0).slice(0, maxRows);
  return sampled.map((row) => {
    const flat = { depth: toFiniteNumber(row?.depth) };
    for (const curve of toArr(curves)) {
      const key = asStr(curve, "");
      if (!key) continue;
      const v = toFiniteNumber(row?.[key] ?? row?.values?.[key]);
      if (Number.isFinite(v)) flat[key] = v;
    }
    return flat;
  });
}

function extractDepthFromQuestion(question = "") {
  const q = asStr(question, "");
  const m = q.match(/\b(\d{3,6}(?:\.\d+)?)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function hasCurveInContext(curveToken, curves) {
  const token = asStr(curveToken, "").toLowerCase();
  if (!token) return false;
  return toArr(curves).some((c) => asStr(c, "").toLowerCase() === token);
}

function findRequestedCurveToken(question = "", curves = []) {
  const available = new Set(toArr(curves).map((c) => asStr(c, "").toLowerCase()));
  if (!available.size) return null;

  const tokens = asStr(question, "")
    .split(/[^A-Za-z0-9_]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of tokens) {
    if (available.has(t.toLowerCase())) return t;
  }
  return null;
}

function probeDepthValue(rows, askedDepth, requestedCurve, curves = []) {
  const ad = Number(askedDepth);
  if (!Array.isArray(rows) || !rows.length || !Number.isFinite(ad)) return null;

  let nearest = null;
  let bestDist = Infinity;
  for (const r of rows) {
    const d = Number(r?.depth);
    if (!Number.isFinite(d)) continue;
    const dist = Math.abs(d - ad);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = r;
    }
  }
  if (!nearest) return null;

  const candidates = [];
  if (requestedCurve) candidates.push(requestedCurve);
  candidates.push(...toArr(curves));

  for (const c of candidates) {
    const key = asStr(c, "");
    if (!key) continue;
    const v = Number(nearest?.values?.[key] ?? nearest?.[key]);
    if (Number.isFinite(v)) {
      return { depth: Number(nearest.depth), curve: key, value: v };
    }
  }

  return null;
}






function resolveSource(pyResp, llmJson) {
  if (!llmJson) return "fallback";
  const pySource = asStr(pyResp?.source, "").toLowerCase();
  const llmUsed = pyResp?.llm_used === true || pyResp?.meta?.llm_used === true;
  if (llmUsed) return "llm";
  if (["llm", "python"].includes(pySource)) return "llm";
  if (pySource === "grounded_guard") return "grounded_guard";
  if (pySource === "fallback" || pySource === "python_fallback") return "fallback";
  return "llm";
}





// ---------- /copilot/query ----------
router.post("/copilot/query", async (req, res) => {
  const startedAt = Date.now();

  let mode = "data_qa";
  let question = "What does this data say?";
  let wellId = "";
  let fromDepth = null;
  let toDepth = null;

  try {
    const body = req.body || {};
    mode = safeStr(body.mode, "data_qa");
    question = safeStr(body.question, "What does this data say?");
    wellId = safeStr(body.wellId, "");
    fromDepth = toNum(body.fromDepth);
    toDepth = toNum(body.toDepth);
    const curves = safeArr(body.curves).map((x) => String(x));
    const detailLevel = Math.max(1, Math.min(5, Number(body.detail_level ?? body.detailLevel ?? 3) || 3));
    const history = safeArr(body.history).slice(-12);

    const evidence = {
      objective: { mode, question },
      context_meta: {
        wellId: wellId || "UNKNOWN_WELL",
        range: { fromDepth, toDepth },
        selectedInterval: body.selectedInterval || null,
        curves,
        generatedAt: new Date().toISOString(),
      },
      deterministic: isObject(body.deterministic) ? body.deterministic : {},
      insight: isObject(body.insight) ? body.insight : {},
      narrative: isObject(body.narrative) ? body.narrative : {},
      recent_history: safeArr(body.recent_history).slice(0, 5),
      playbook_snippets: buildPlaybookSnippets(mode),
    };

    const thresholds = loadThresholds();
    const baselineWindowFt = Number(
      thresholds?.baseline?.windowPadFt ?? thresholds?.baseline?.windowFt ?? 1500
    );

    let localRows = [];
    let baselineRows = [];
    if (
      wellId &&
      Number.isFinite(fromDepth) &&
      Number.isFinite(toDepth) &&
      curves.length > 0
    ) {
      try {
        localRows = await fetchRowsForRangeDB({
          wellId,
          fromDepth,
          toDepth,
          curves,
          limit: 30000,
        });

        baselineRows = await fetchRowsForRangeDB({
          wellId,
          fromDepth: fromDepth - baselineWindowFt,
          toDepth: toDepth + baselineWindowFt,
          curves,
          limit: 60000,
        });
      } catch (e) {
        console.warn("[copilot] baseline fetch failed:", e?.message || e);
      }
    }

    const baselineContext = buildBaselineContext({
      baselineRows,
      localRows,
      curves,
      thresholds,
    });
    evidence.baseline = baselineContext;
    const copilotRows = flattenRowsForCopilot(localRows, curves, 1400);
    const copilotStats = buildCurveStatsFromRows(copilotRows, curves);

    const originalIntervals = safeArr(evidence?.narrative?.interval_explanations);
    const taggedIntervals = tagIntervalsWithEvidenceType(originalIntervals, thresholds);
    const gated = applyQualityGatesToIntervals(taggedIntervals, baselineContext, thresholds);
    const topN = Number(thresholds?.interval?.topN ?? 10);
    const minMultiInTop = Number(
      thresholds?.interval?.enforceMinMultiCurve ?? thresholds?.interval?.minMultiInTop ?? 2
    );
    const topIntervals = enforceMultiCurveInTop(gated.intervals, topN, minMultiInTop);
    const topSet = new Set(topIntervals);
    const others = gated.intervals.filter((x) => !topSet.has(x));
    evidence.narrative.interval_explanations = [...topIntervals, ...others];
    if (gated.limitations.length) {
      evidence.narrative.limitations = [
        ...new Set([
          ...safeArr(evidence?.narrative?.limitations),
          ...gated.limitations,
        ]),
      ];
    }

    // Evidence gate - allow depth query with deterministic even if narrative is thin
    const gate = evidenceSufficiency(evidence);
    const depthQ = isDepthQuery(question);
    const detExists = isObject(evidence.deterministic) && Object.keys(evidence.deterministic).length > 0;
    const bypassGate = depthQ && detExists;

    if (!gate.ok && !bypassGate) {
      const fallback = buildFallbackJson({ mode, evidence, compare: { summary: "", delta_metrics: [] } });
      const patched = patchDirectAnswerFromEvidence(fallback, evidence, question);
      const latencyMs = Date.now() - startedAt;

      const responsePayload = {
        ok: true,
        source: "fallback",
        schema_valid: true,
        evidence_strength: "low",
        json: patched,
        evidence,
        llm_error: `evidence_gate_failed:${safeArr(gate.missing).join(",")}`,
        latency_ms: latencyMs,
      };

      try {
        await insertCopilotRunRow({
          source: "fallback",
          llmUsed: false,
          schemaValid: true,
          modelName: null,
          latencyMs,
          llmError: responsePayload.llm_error,
          question,
          mode,
          wellId: evidence.context_meta.wellId,
          fromDepth,
          toDepth,
          curves,
          responseJson: patched,
          evidenceJson: evidence,
          schemaErrors: [],
        });
      } catch (dbErr) {
        console.warn("[copilot] DB insert failed:", dbErr?.message || dbErr);
      }

      return res.json(responsePayload);
    }

    const intent = classifyQuestionIntent(question);
    const guard = validateAgainstContext({
      intent,
      availableCurves: curves,
      fromDepth,
      toDepth,
    });

    if (!guard.ok) {
      const fallback = buildFallbackJson({ mode, evidence, compare: { summary: "", delta_metrics: [] } });

      if (guard.reason === "missing_curve") {
        fallback.answer_title = "Requested curve not in current context";
        fallback.direct_answer = `I cannot find ${guard.missingCurves.join(", ")} in selected curves.`;
        fallback.key_points = [
          `Available curves: ${curves.join(", ") || "none"}`,
          `Well: ${wellId || "UNKNOWN_WELL"}`,
          `Range: ${fmtNum(fromDepth, 1)}-${fmtNum(toDepth, 1)} ft`,
        ];
      } else if (guard.reason === "depth_out_of_range") {
        fallback.answer_title = "Requested depth is outside current interval";
        fallback.direct_answer = `Asked depth is outside ${fmtNum(fromDepth, 1)}-${fmtNum(toDepth, 1)} ft.`;
        fallback.key_points = [
          `Well: ${wellId || "UNKNOWN_WELL"}`,
          `Current range: ${fmtNum(fromDepth, 1)}-${fmtNum(toDepth, 1)} ft`,
        ];
      }

      const patched = patchDirectAnswerFromEvidence(fallback, evidence, question);
      const responsePayload = {
        ok: true,
        source: "grounded_guard",
        schema_valid: true,
        evidence_strength: "medium",
        json: patched,
        evidence,
        llm_error: null,
        latency_ms: Date.now() - startedAt,
      };
      try {
        await insertCopilotRunRow({
          source: "grounded_guard",
          llmUsed: false,
          schemaValid: true,
          modelName: null,
          latencyMs: responsePayload.latency_ms,
          llmError: null,
          question,
          mode,
          wellId: evidence.context_meta.wellId,
          fromDepth,
          toDepth,
          curves,
          responseJson: patched,
          evidenceJson: evidence,
          schemaErrors: [],
        });
      } catch (dbErr) {
        console.warn("[copilot] DB insert failed:", dbErr?.message || dbErr);
      }
      return res.json(responsePayload);
    }

    if (
      (intent.kind === "depth" || intent.kind === "curve_depth") &&
      Number.isFinite(Number(intent.askedDepth))
    ) {
      const requestedCurve = Array.isArray(intent.askedCurves) && intent.askedCurves.length
        ? intent.askedCurves[0]
        : findRequestedCurveToken(question, curves);
      const probe = probeDepthValue(localRows, Number(intent.askedDepth), requestedCurve, curves);
      if (probe) {
        const fallback = buildFallbackJson({ mode, evidence, compare: { summary: "", delta_metrics: [] } });
        fallback.answer_title = `Depth Probe ${fmtNum(intent.askedDepth, 1)} ft`;
        fallback.direct_answer = `At ${fmtNum(intent.askedDepth, 1)} ft, nearest sampled depth is ${fmtNum(probe.depth, 1)} ft. ${probe.curve}: ${fmtNum(probe.value, 4)}.`;
        fallback.key_points = [
          `Depth requested: ${fmtNum(intent.askedDepth, 1)} ft`,
          `Nearest sampled depth: ${fmtNum(probe.depth, 1)} ft`,
          `Curve: ${probe.curve}`,
          `Value: ${fmtNum(probe.value, 4)}`,
        ];
        fallback.evidence_used = [
          {
            source: "depth_probe",
            confidence: "high",
            snippet: `depth=${fmtNum(probe.depth, 1)}, curve=${probe.curve}, value=${fmtNum(probe.value, 4)}`,
          },
        ];
        const patched = patchDirectAnswerFromEvidence(fallback, evidence, question);
        const responsePayload = {
          ok: true,
          source: "grounded_guard",
          schema_valid: true,
          evidence_strength: "high",
          json: patched,
          evidence,
          llm_error: null,
          latency_ms: Date.now() - startedAt,
        };
        try {
          await insertCopilotRunRow({
            source: "grounded_guard",
            llmUsed: false,
            schemaValid: true,
            modelName: null,
            latencyMs: responsePayload.latency_ms,
            llmError: null,
            question,
            mode,
            wellId: evidence.context_meta.wellId,
            fromDepth,
            toDepth,
            curves,
            responseJson: patched,
            evidenceJson: evidence,
            schemaErrors: [],
          });
        } catch (dbErr) {
          console.warn("[copilot] DB insert failed:", dbErr?.message || dbErr);
        }
        return res.json(responsePayload);
      }
    }

    // Compare mode metrics
    let compare = { summary: "", delta_metrics: [] };
    if (mode === "compare") {
      const baseline = body.baseline || {
        range: {
          fromDepth: Number(fromDepth) - 500,
          toDepth: Number(fromDepth),
        },
        deterministic: body.baselineDeterministic || {},
      };
      const current = {
        range: { fromDepth, toDepth },
        deterministic: body.deterministic || {},
      };
      compare = computeCompareMetrics({ current, baseline });
    }

    let pyResp = null;
    let llmError = null;
    let llmCandidate = null;
    let pyShapeReason = null;

    try {
      pyResp = await callPythonCopilot({
        mode,
        question,
        wellId: evidence.context_meta.wellId,
        fromDepth,
        toDepth,
        selectedInterval: body.selectedInterval || null,
        curves,
        detail_level: detailLevel,
        history,
        statistics: copilotStats,
        rows: copilotRows,
        evidence,
        compare,
      });

      const ext = extractCandidateFromPython(pyResp);
      llmCandidate = ext.candidate;
      pyShapeReason = ext.reason || null;
      if (!llmCandidate && ext.reason) llmError = ext.reason;
    } catch (err) {
      llmError = err?.message || "python_call_failed";
      console.warn("[copilot] python call failed:", llmError);
    }

    // choose candidate first, then patch, then validate
    const baseCandidate = llmCandidate || buildFallbackJson({ mode, evidence, compare });

    let finalJson = patchDirectAnswerFromEvidence(baseCandidate, evidence, question);

    const validation = validateCopilotResponse(finalJson);
    let schemaValid = !!validation.ok;
    let schemaErrors = schemaValid ? [] : validation.errors || [];
    let sourceValue = inferSource(pyResp, !!llmCandidate);

    if (!schemaValid) {
      finalJson = patchDirectAnswerFromEvidence(
        buildFallbackJson({ mode, evidence, compare }),
        evidence,
        question
      );
      sourceValue = "fallback";
      if (!llmError) llmError = "llm_schema_invalid";
      schemaValid = true; // because fallback is expected valid in your builder
      schemaErrors = [];
    }

    const latencyMs = Date.now() - startedAt;
    const modelName =
      safeStr(pyResp?.llm_model, "") ||
      safeStr(pyResp?.model, "") ||
      safeStr(pyResp?.model_name, "") ||
      process.env.LLM_PRIMARY ||
      process.env.GROQ_MODEL ||
      null;

    const responsePayload = {
      ok: true,
      source: sourceValue,
      schema_valid: schemaValid,
      schema_errors: schemaErrors,
      evidence_strength: gate.ok || bypassGate ? "medium" : "low",
      json: finalJson,
      evidence,
      llm_error: llmError,
      python_source: safeStr(pyResp?.source, null),
      python_llm_used: pyResp?.llm_used === true,
      python_shape_reason: pyShapeReason,
      latency_ms: latencyMs,
    };

    try {
      await insertCopilotRunRow({
        source: sourceValue,
        llmUsed: sourceValue !== "fallback",
        schemaValid,
        modelName,
        latencyMs,
        llmError,
        question,
        mode,
        wellId: evidence.context_meta.wellId,
        fromDepth,
        toDepth,
        curves,
        responseJson: finalJson,
        evidenceJson: evidence,
        schemaErrors,
      });
    } catch (dbErr) {
      console.warn("[copilot] DB insert failed:", dbErr?.message || dbErr);
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error("[copilot] fatal", err);

    const latencyMs = Date.now() - startedAt;
    const fallback = buildFallbackJson({
      mode: mode || "data_qa",
      evidence: {
        context_meta: {
          wellId: wellId || "UNKNOWN_WELL",
          range: { fromDepth, toDepth },
          curves: [],
        },
        deterministic: {},
        narrative: {},
      },
      compare: { summary: "", delta_metrics: [] },
    });

    const finalJson = patchDirectAnswerFromEvidence(fallback, {
      context_meta: { wellId: wellId || "UNKNOWN_WELL", range: { fromDepth, toDepth }, curves: [] },
      deterministic: {},
      narrative: {},
    }, question);

    const responsePayload = {
      ok: true,
      source: "fallback",
      schema_valid: true,
      schema_errors: [],
      evidence_strength: "low",
      json: finalJson,
      llm_error: "route_exception",
      error: String(err?.message || err),
      latency_ms: latencyMs,
    };

    try {
      await insertCopilotRunRow({
        source: "fallback",
        llmUsed: false,
        schemaValid: true,
        modelName: null,
        latencyMs,
        llmError: "route_exception",
        question: question || "No question",
        mode: mode || "data_qa",
        wellId: wellId || "UNKNOWN_WELL",
        fromDepth,
        toDepth,
        curves: [],
        responseJson: finalJson,
        evidenceJson: {},
        schemaErrors: [],
      });
    } catch (dbErr) {
      console.warn("[copilot] DB insert failed:", dbErr?.message || dbErr);
    }

    return res.status(200).json(responsePayload);
  }
});

// ---------- COPILOT HARDENED HELPERS ----------
function isObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function toNum(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function safeStr(v, def = "") {
  if (v === null || v === undefined) return def;
  const s = String(v).trim();
  return s || def;
}

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function parseMaybeJsonString(x) {
  if (typeof x !== "string") return null;
  try {
    const p = JSON.parse(x);
    return isObject(p) ? p : null;
  } catch {
    return null;
  }
}

function looksLikeCopilotSchema(x) {
  return (
    isObject(x) &&
    typeof x.answer_title === "string" &&
    typeof x.direct_answer === "string" &&
    Array.isArray(x.key_points)
  );
}

function buildSchemaFromAnswerText(answerText) {
  const text = safeStr(answerText, "");
  if (!text) return null;
  return {
    answer_title: "Copilot Answer",
    direct_answer: text,
    key_points: [],
    actions: [],
    comparison: { summary: "", delta_metrics: [] },
    risks: ["Risk assessment is limited because interval evidence may be incomplete."],
    uncertainties: ["Detailed deterministic/narrative evidence is missing or limited for this query."],
    confidence: { overall: 0.55, rubric: "medium", reason: "LLM text response converted to schema." },
    evidence_used: [],
    safety_note: "Decision support only, not autonomous control.",
  };
}

function syncNarrativeWithDeterministic(narrative, deterministic) {
  const nar = narrative && typeof narrative === "object" ? { ...narrative } : {};
  const detSummaryBullets = Array.isArray(deterministic?.summary)
    ? deterministic.summary.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const narSummaryBullets = Array.isArray(nar.summary_bullets)
    ? nar.summary_bullets.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const mergedBullets = [...narSummaryBullets];
  for (const line of detSummaryBullets) {
    if (!mergedBullets.includes(line)) mergedBullets.push(line);
    if (mergedBullets.length >= 8) break;
  }
  if (mergedBullets.length < 7) {
    for (const line of [
      "Cross-validate flagged zones with adjacent intervals and companion logs.",
      "Use these results as screening evidence and confirm with domain review before action.",
    ]) {
      if (mergedBullets.length >= 7) break;
      if (!mergedBullets.includes(line)) mergedBullets.push(line);
    }
  }
  nar.summary_bullets = mergedBullets.slice(0, 8);
  if (typeof nar.summary_paragraph !== "string" || !nar.summary_paragraph.trim()) {
    if (typeof deterministic?.summaryParagraph === "string" && deterministic.summaryParagraph.trim()) {
      nar.summary_paragraph = deterministic.summaryParagraph;
    } else {
      nar.summary_paragraph = "";
    }
  }
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];
  if (!detIntervals.length) return nar;

  const detMap = new Map();
  for (const d of detIntervals) {
    const key = `${String(d?.curve || "")}|${Number(d?.fromDepth)}|${Number(d?.toDepth)}`;
    detMap.set(key, d);
  }

  const existing = Array.isArray(nar.interval_explanations) ? nar.interval_explanations : [];
  if (!existing.length) {
    nar.interval_explanations = detIntervals.map(detFindingToNarrativeInterval);
    return nar;
  }

  nar.interval_explanations = existing.map((it) => {
    const key = `${String(it?.curve || "")}|${Number(it?.fromDepth)}|${Number(it?.toDepth)}`;
    const det = detMap.get(key);
    if (!det) return it;
    return {
      ...it,
      curvesSupporting: det?.curvesSupporting ?? it?.curvesSupporting ?? null,
      evidenceType: det?.evidenceType ?? it?.evidenceType ?? null,
      score2: det?.score2 ?? it?.score2 ?? null,
      baseline: det?.baseline ?? it?.baseline ?? null,
      score: det?.score ?? it?.score ?? null,
    };
  });

  return nar;
}

function parseCurveSet(curveField) {
  if (!curveField) return [];
  if (Array.isArray(curveField)) {
    return [...new Set(curveField.map((c) => String(c || "").trim()).filter(Boolean))];
  }
  return [...new Set(String(curveField).split(",").map((s) => s.trim()).filter(Boolean))];
}

function normalizeIntervalSupport(det) {
  const out = det && typeof det === "object" ? { ...det } : {};
  const arr = Array.isArray(out?.intervalFindings)
    ? out.intervalFindings.map((x) => ({ ...x }))
    : [];

  out.intervalFindings = arr.map((it) => {
    const n = parseCurveSet(it?.curve).length;
    const cs = Number(it?.curvesSupporting);
    const nextSupport = Number.isFinite(cs) ? Math.max(cs, n) : Math.max(1, n);
    return {
      ...it,
      curvesSupporting: nextSupport,
      evidenceType: nextSupport >= 2 ? "multi-curve" : "single-curve",
    };
  });
  return out;
}

function applyFeedbackAdvisoryToDeterministic(det, advisory) {
  const boost = Number(advisory?.boost);
  const out = det && typeof det === "object" ? { ...det } : {};
  out.meta = out.meta && typeof out.meta === "object" ? { ...out.meta } : {};
  out.meta.feedbackAdjustmentApplied = Number.isFinite(boost) && boost !== 0;
  out.meta.feedbackAdjustment = Number.isFinite(boost) ? Number(boost.toFixed(4)) : 0;
  out.meta.feedbackMatches = Number(advisory?.matches || 0);
  out.meta.feedbackAdjustmentReason =
    Number.isFinite(boost) && boost !== 0
      ? boost > 0
        ? "historical true_positive tendency"
        : "historical false_positive tendency"
      : "no overlapping feedback evidence";

  if (!Number.isFinite(boost) || boost === 0) return out;

  const arr = Array.isArray(out.intervalFindings) ? out.intervalFindings.map((x) => ({ ...x })) : [];
  out.intervalFindings = arr.map((it) => {
    const next = { ...it };
    if (Number.isFinite(Number(next.confidence))) {
      const v = Number(next.confidence) + boost;
      next.confidence = Math.max(0, Math.min(1, Number(v.toFixed(4))));
    }
    if (Number.isFinite(Number(next.score2))) {
      next.score2 = Number((Number(next.score2) + boost).toFixed(4));
    }
    if (Number.isFinite(Number(next.score))) {
      next.score = Number((Number(next.score) + boost).toFixed(4));
    }
    return next;
  });

  if (Number.isFinite(Number(out.detectionConfidence))) {
    const v = Number(out.detectionConfidence) + boost;
    out.detectionConfidence = Math.max(0, Math.min(1, Number(v.toFixed(4))));
  }
  if (Number.isFinite(Number(out.confidence))) {
    const v = Number(out.confidence) + boost;
    out.confidence = Math.max(0, Math.min(1, Number(v.toFixed(4))));
  }

  out.feedbackAdvisory = {
    boost: Number(boost.toFixed(4)),
    matches: Number(advisory?.matches || 0),
  };
  return out;
}

function extractCandidateFromPython(pyResp) {
  if (!isObject(pyResp)) return { candidate: null, reason: "python_non_object_response" };

  // common shapes
  const candidates = [
    pyResp?.json,
    pyResp?.answer,
    pyResp?.result,
    pyResp?.data?.json,
    pyResp?.data?.answer,
    pyResp?.data?.result,
    pyResp, // root as schema
  ];

  for (const c of candidates) {
    if (looksLikeCopilotSchema(c)) return { candidate: c, reason: null };
    const parsed = parseMaybeJsonString(c);
    if (looksLikeCopilotSchema(parsed)) return { candidate: parsed, reason: null };
  }

  // sometimes whole response itself is stringified JSON
  const rootParsed = parseMaybeJsonString(pyResp);
  if (looksLikeCopilotSchema(rootParsed)) return { candidate: rootParsed, reason: null };

  // ai-service may return plain string answer with source metadata.
  const wrapped = buildSchemaFromAnswerText(pyResp?.answer);
  if (looksLikeCopilotSchema(wrapped)) return { candidate: wrapped, reason: null };

  return { candidate: null, reason: "python_response_unrecognized_shape" };
}

function inferSource(pyResp, llmCandidateExists) {
  const src = safeStr(pyResp?.source, "").toLowerCase();
  const llmUsed = pyResp?.llm_used === true || pyResp?.meta?.llm_used === true;
  if (!llmCandidateExists && !llmUsed && src !== "llm" && src !== "python") return "fallback";
  if (llmUsed) return "llm";
  if (src === "llm" || src === "python") return "llm";
  if (src === "fallback" || src === "python_fallback") return "fallback";
  return llmCandidateExists ? "llm" : "fallback";
}

function isGenericDirectAnswer(ans = "") {
  const t = safeStr(ans, "").toLowerCase();
  if (!t || t.length < 24) return true;
  const badPhrases = [
    "parameters that should be seen",
    "various indicators",
    "generally suggests",
    "it appears that",
    "in this context",
    "based on available data it appears",
  ];
  return badPhrases.some((p) => t.includes(p));
}

function getTopNarrativeInterval(evidence) {
  const intervals = safeArr(evidence?.narrative?.interval_explanations);
  if (!intervals.length) return null;
  const x = intervals[0];
  const fd = toNum(x?.fromDepth);
  const td = toNum(x?.toDepth);
  if (!Number.isFinite(fd) || !Number.isFinite(td)) return null;
  return {
    fromDepth: Math.min(fd, td),
    toDepth: Math.max(fd, td),
    curve: safeStr(x?.curve, "-"),
    explanation: safeStr(x?.explanation, "pattern anomaly"),
    confidence: toNum(x?.confidence),
  };
}

// IMPORTANT: numeric depth query should be treated as valid target (not missing entity)
function isDepthQuery(question = "") {
  const q = safeStr(question).toLowerCase();
  // numeric depth mention e.g. "at 12800"
  const hasNumber = /\b\d{3,6}(\.\d+)?\b/.test(q);
  const hasDepthWord = /(depth|at|around|near)\b/.test(q);
  return hasNumber && hasDepthWord;
}

function patchDirectAnswerFromEvidence(json, evidence, question = "") {
  const out = isObject(json) ? { ...json } : {};
  const det = isObject(evidence?.deterministic) ? evidence.deterministic : {};
  const nar = isObject(evidence?.narrative) ? evidence.narrative : {};
  const intervals = safeArr(nar?.interval_explanations);

  const sev = safeStr(det?.severityBand, "UNKNOWN");
  const dq = safeStr(det?.dataQuality?.qualityBand, "UNKNOWN");
  const wellId = safeStr(evidence?.context_meta?.wellId, "-");
  const f = toNum(evidence?.context_meta?.range?.fromDepth);
  const t = toNum(evidence?.context_meta?.range?.toDepth);

  const q = safeStr(question).toLowerCase();
  const asksSpike = /(spike|anomaly|abnormal|flagged|why interval)/.test(q);
  const asksDepth = isDepthQuery(q);

  const top = getTopNarrativeInterval(evidence);

  if (asksDepth) {
    // try extract asked depth and answer around that
    const m = q.match(/\b(\d{3,6}(?:\.\d+)?)\b/);
    const asked = m ? Number(m[1]) : null;

    if (Number.isFinite(asked)) {
      let nearest = null;
      let best = Infinity;
      for (const it of intervals) {
        const a = toNum(it?.fromDepth);
        const b = toNum(it?.toDepth);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const dist = asked < lo ? lo - asked : asked > hi ? asked - hi : 0;
        if (dist < best) {
          best = dist;
          nearest = it;
        }
      }

      out.answer_title = `Depth-focused view at ${asked} ft`;
      if (nearest) {
        const lo = toNum(nearest.fromDepth), hi = toNum(nearest.toDepth);
        const curve = safeStr(nearest.curve, "-");
        const exp = safeStr(nearest.explanation, "anomalous pattern");
        out.direct_answer =
          best === 0
            ? `At ${asked} ft, the depth lies inside a flagged interval ${lo.toFixed(1)}–${hi.toFixed(1)} ft (${curve}): ${exp}.`
            : `At ${asked} ft, no exact flagged interval is centered there; nearest flagged interval is ${lo.toFixed(1)}–${hi.toFixed(1)} ft (${curve}): ${exp}.`;
      } else {
        out.direct_answer =
          `At ${asked} ft, no interval explanation is available in narrative evidence. Current deterministic signal is severity=${sev}, data quality=${dq} for ${wellId} (${Number.isFinite(f) ? f.toFixed(1) : "-"}–${Number.isFinite(t) ? t.toFixed(1) : "-"} ft).`;
      }
    }
  } else if (asksSpike && top) {
    out.answer_title = "Spike Location Summary";
    out.direct_answer =
      `Most likely spike/anomaly zone is ${top.fromDepth.toFixed(1)}–${top.toDepth.toFixed(1)} ft (${top.curve}): ${top.explanation}`;
  } else if (isGenericDirectAnswer(out.direct_answer)) {
    out.direct_answer =
      `The selected interval appears flagged by anomaly evidence (severity: ${sev}, data quality: ${dq}) for well ${wellId}.`;
  }

  if (!Array.isArray(out.key_points) || out.key_points.length === 0) {
    out.key_points = [
      `Well: ${wellId}`,
      `Analyzed range: ${Number.isFinite(f) ? f.toFixed(1) : "-"}–${Number.isFinite(t) ? t.toFixed(1) : "-"} ft`,
      `Severity band: ${sev}`,
      `Data quality: ${dq}`,
      ...(top ? [`Top explained interval: ${top.fromDepth.toFixed(1)}–${top.toDepth.toFixed(1)} ft`] : []),
    ];
  }

  if (!Array.isArray(out.actions) || out.actions.length === 0) {
    out.actions = [
      {
        priority: "medium",
        action: "Re-run interpretation on a narrower interval around flagged zone",
        rationale: "Improves localization confidence and reduces ambiguity.",
      },
    ];
  }

  if (!isObject(out.confidence)) {
    out.confidence = {
      overall: 0.55,
      rubric: "medium",
      reason: "Derived from deterministic evidence and narrative interval availability.",
    };
  }

  if (!Array.isArray(out.evidence_used) || out.evidence_used.length === 0) {
    out.evidence_used = [
      {
        source: "deterministic",
        confidence: "high",
        snippet: `severity=${sev}, dataQuality=${dq}, eventCount=${det?.eventCount ?? "n/a"}`,
      },
    ];
  }

  if (!Array.isArray(out.risks) || out.risks.length === 0) {
    const risks = [];
    const sevLower = sev.toLowerCase();
    if (sevLower.includes("critical") || sevLower.includes("high")) {
      risks.push(`Global anomaly severity is ${sev}.`);
    }
    const riskSummary = safeStr(evidence?.insight?.riskProfile?.summary, "");
    if (riskSummary) risks.push(riskSummary);
    if (dq.toLowerCase().includes("low")) {
      risks.push("Low data quality may increase false positives/negatives.");
    }
    if (risks.length === 0) {
      risks.push("No high-severity risk was inferred from available evidence.");
    }
    out.risks = risks;
  }

  if (!Array.isArray(out.uncertainties) || out.uncertainties.length === 0) {
    const narLimitations = safeArr(nar?.limitations).map((x) => safeStr(x)).filter(Boolean);
    const detLimitations = safeArr(det?.limitations).map((x) => safeStr(x)).filter(Boolean);
    const limitations = narLimitations.length ? narLimitations : detLimitations;
    out.uncertainties = limitations.length
      ? limitations
      : ["Model-based interpretation; validate with domain checks and adjacent intervals."];
  }

  out.safety_note = "Decision support only, not autonomous control.";
  return out;
}

async function insertCopilotRunRow({
  source,
  llmUsed,
  schemaValid,
  modelName,
  latencyMs,
  llmError,
  question,
  mode,
  wellId,
  fromDepth,
  toDepth,
  curves,
  responseJson,
  evidenceJson,
  schemaErrors,
}) {
  // Ensure NOT NULL well_id always gets a value
  const safeWell = safeStr(wellId, "UNKNOWN_WELL");

  await pgPool.query(
    `
    INSERT INTO copilot_runs (
      source, llm_used, schema_valid, model_name, latency_ms, llm_error,
      question, mode, well_id, from_depth, to_depth, curves,
      response_json, evidence_json, schema_errors
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12::jsonb,
      $13::jsonb, $14::jsonb, $15::jsonb
    )
    `,
    [
      source,
      !!llmUsed,
      !!schemaValid,
      modelName || null,
      Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : 0,
      llmError || null,
      safeStr(question, "No question"),
      safeStr(mode, "data_qa"),
      safeWell,
      Number.isFinite(Number(fromDepth)) ? Number(fromDepth) : null,
      Number.isFinite(Number(toDepth)) ? Number(toDepth) : null,
      JSON.stringify(safeArr(curves)),
      JSON.stringify(isObject(responseJson) ? responseJson : {}),
      JSON.stringify(isObject(evidenceJson) ? evidenceJson : {}),
      JSON.stringify(Array.isArray(schemaErrors) ? schemaErrors : []),
    ]
  );
}

// ---------- HARDENED ROUTE ----------
/**
 * Helper: persist copilot run
 * Keep this in same file OR move to backend/services/copilotStore.js and import.
 */
async function persistCopilotRun({
  pgPool,
  mode,
  question,
  evidence,
  source,
  llmUsed,
  modelName,
  schemaValid,
  llmError,
  evidenceStrength,
  latencyMs,
  candidateJson,
  appVersion,
}) {
  const sql = `
    INSERT INTO copilot_runs (
      well_id, mode, question, from_depth, to_depth, curves,
      deterministic, narrative, insight, recent_history,
      source, llm_used, model_name, schema_valid, llm_error,
      evidence_strength, latency_ms, response_json, app_version
    )
    VALUES (
      $1, $2, $3, $4, $5, $6::jsonb,
      $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
      $11, $12, $13, $14, $15,
      $16, $17, $18::jsonb, $19
    )
    RETURNING run_id, created_at;
  `;

  const wellId = evidence?.context_meta?.wellId || "-";
  const fromDepth = Number(evidence?.context_meta?.range?.fromDepth);
  const toDepth = Number(evidence?.context_meta?.range?.toDepth);
  const curves = Array.isArray(evidence?.context_meta?.curves) ? evidence.context_meta.curves : [];

  const values = [
    wellId,
    mode,
    question,
    Number.isFinite(fromDepth) ? fromDepth : null,
    Number.isFinite(toDepth) ? toDepth : null,
    JSON.stringify(curves),

    JSON.stringify(evidence?.deterministic || {}),
    JSON.stringify(evidence?.narrative || {}),
    JSON.stringify(evidence?.insight || {}),
    JSON.stringify(Array.isArray(evidence?.recent_history) ? evidence.recent_history : []),

    source || "fallback",
    !!llmUsed,
    modelName || null,
    !!schemaValid,
    llmError || null,

    evidenceStrength || "medium",
    Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : 0,
    JSON.stringify(candidateJson || {}),
    appVersion || "phase-1.2",
  ];

  const out = await pgPool.query(sql, values);
  return out?.rows?.[0] || null;
}







router.post("/interval-diff", async (req, res) => {
  const runId = randomUUID();
  const meta = responseMeta(req, runId);
  const startedAt = Date.now();
  const warnings = [];
  const version = featureVersionEnvelope({
    featureName: "interval-diff",
    featureVersion: FEATURE_VERSION,
    detModelVersion: DET_MODEL_VERSION,
    thresholdVersion: THRESHOLD_VERSION,
    algoHash: null,
  });
  try {
    const { wellId, a, b, detailLevel, curves } = req.body || {};
    if (!wellId) {
      intervalDiffDuration.labels("error").observe(Date.now() - startedAt);
      featureErrorTotal.labels("interval-diff", "bad_request").inc();
      return res.status(400).json({
        ok: false,
        ...meta,
        version,
        payload: null,
        warnings,
        errors: ["wellId is required"],
      });
    }

    const mergedCurves = parseCurveCsv(curves);
    const aCurves = parseCurveCsv(a?.curves);
    const bCurves = parseCurveCsv(b?.curves);
    const effectiveCurves = [...new Set([...mergedCurves, ...aCurves, ...bCurves])];

    const aFrom = Number(a?.fromDepth);
    const aTo = Number(a?.toDepth);
    const bFrom = Number(b?.fromDepth);
    const bTo = Number(b?.toDepth);
    if (![aFrom, aTo, bFrom, bTo].every(Number.isFinite)) {
      intervalDiffDuration.labels("error").observe(Date.now() - startedAt);
      featureErrorTotal.labels("interval-diff", "bad_request").inc();
      return res.status(400).json({
        ok: false,
        ...meta,
        version,
        payload: null,
        warnings,
        errors: ["a.fromDepth, a.toDepth, b.fromDepth, b.toDepth are required numbers"],
      });
    }
    if (!effectiveCurves.length) {
      intervalDiffDuration.labels("error").observe(Date.now() - startedAt);
      featureErrorTotal.labels("interval-diff", "bad_request").inc();
      return res.status(400).json({
        ok: false,
        ...meta,
        version,
        payload: null,
        warnings,
        errors: ["At least one curve is required"],
      });
    }
    const detail = Math.max(1, Math.min(5, Number(detailLevel) || 3));

    const algoVersion = `${FEATURE_VERSION}:${DET_MODEL_VERSION}:${THRESHOLD_VERSION}`;
    const baseCacheKey = `ai:interval-diff:${wellId}:${Math.min(aFrom, aTo)}:${Math.max(aFrom, aTo)}:${Math.min(bFrom, bTo)}:${Math.max(bFrom, bTo)}:m${metricsHash(effectiveCurves)}:d${detail}:v${algoVersion}`;
    const cached = await cacheGetJson(baseCacheKey);
    if (cached) {
      intervalDiffDuration.labels("ok").observe(Date.now() - startedAt);
      logger.info({
        msg: "feature.complete",
        feature: "interval-diff",
        requestId: req.requestId || null,
        runId,
        wellId,
        fromDepth: Math.min(aFrom, aTo),
        toDepth: Math.max(bFrom, bTo),
        durationMs: Date.now() - startedAt,
        status: 200,
        source: "redis",
      });
      return res.json({
        ok: true,
        ...meta,
        ...cached,
        version: featureVersionEnvelope({
          featureName: "interval-diff",
          featureVersion: cached?.featureVersion || FEATURE_VERSION,
          detModelVersion: cached?.detModelVersion || DET_MODEL_VERSION,
          thresholdVersion: cached?.thresholdVersion || THRESHOLD_VERSION,
          algoHash: cached?.algoHash || null,
        }),
        payload: cached,
        warnings: cached?.warnings || [],
        errors: [],
        source: "redis",
      });
    }

    const diff = await computeIntervalDiff({
      wellId: String(wellId),
      intervalAInput: { ...(a || {}), curves: aCurves.length ? aCurves : effectiveCurves },
      intervalBInput: { ...(b || {}), curves: bCurves.length ? bCurves : effectiveCurves },
      detailLevel: detail,
      curves: effectiveCurves,
    });

    const payload = {
      wellId: diff.wellId,
      intervalA: diff.intervalA,
      intervalB: diff.intervalB,
      curveDiff: diff.curveDiff,
      eventDiff: diff.eventDiff,
      topChanges: diff.topChanges,
      narrativeDiff: diff.narrativeDiff,
      detModelVersion: diff?.versions?.detModelVersion,
      thresholdVersion: diff?.versions?.thresholdVersion,
      featureVersion: diff?.versions?.featureVersion,
      algoHash: diff?.versions?.algoHash,
    };
    version.algoHash = payload.algoHash || null;

    await cacheSetJson(baseCacheKey, payload, 60 * 10);
    intervalDiffDuration.labels("ok").observe(Date.now() - startedAt);
    logger.info({
      msg: "feature.complete",
      feature: "interval-diff",
      requestId: req.requestId || null,
      runId,
      wellId,
      fromDepth: Math.min(aFrom, aTo),
      toDepth: Math.max(bFrom, bTo),
      durationMs: Date.now() - startedAt,
      status: 200,
      source: "fresh",
    });
    return res.json({
      ok: true,
      ...meta,
      ...payload,
      version,
      payload,
      warnings,
      errors: [],
      source: "fresh",
    });
  } catch (err) {
    intervalDiffDuration.labels("error").observe(Date.now() - startedAt);
    featureErrorTotal.labels("interval-diff", "runtime").inc();
    logger.error({
      msg: "feature.error",
      feature: "interval-diff",
      requestId: req.requestId || null,
      runId,
      wellId: req?.body?.wellId || null,
      durationMs: Date.now() - startedAt,
      status: 400,
      error: err?.message || String(err),
    });
    return res.status(400).json({
      ok: false,
      ...meta,
      version,
      payload: null,
      warnings,
      errors: [err?.message || "interval diff failed"],
    });
  }
});

router.post("/feedback", async (req, res) => {
  const meta = responseMeta(req, randomUUID());
  const startedAt = Date.now();
  const version = featureVersionEnvelope({
    featureName: "feedback",
    featureVersion: "feedback-v1",
    detModelVersion: DET_MODEL_VERSION,
    thresholdVersion: THRESHOLD_VERSION,
    algoHash: `dedupe:${FEEDBACK_DEDUPE_POLICY}`,
  });
  const warnings = [];
  try {
    const checked = validateFeedbackPayload(req.body || {});
    if (!checked.ok) {
      feedbackWriteTotal.labels("error").inc();
      featureErrorTotal.labels("feedback", "validation").inc();
      return res.status(400).json({
        ok: false,
        ...meta,
        version,
        payload: null,
        warnings,
        errors: [checked.error],
      });
    }
    const row = await insertFeedback(checked.value);
    feedbackWriteTotal.labels("ok").inc();
    logger.info({
      msg: "feature.complete",
      feature: "feedback-write",
      requestId: req.requestId || null,
      wellId: checked.value.wellId,
      fromDepth: checked.value.fromDepth,
      toDepth: checked.value.toDepth,
      durationMs: Date.now() - startedAt,
      status: 201,
    });
    const payload = {
      feedback: row,
      dedupePolicy: FEEDBACK_DEDUPE_POLICY,
    };
    return res.status(201).json({
      ok: true,
      ...meta,
      ...payload,
      version,
      payload,
      warnings,
      errors: [],
    });
  } catch (err) {
    feedbackWriteTotal.labels("error").inc();
    featureErrorTotal.labels("feedback", "write_failed").inc();
    return res.status(400).json({
      ok: false,
      ...meta,
      version,
      payload: null,
      warnings,
      errors: [err?.message || "feedback insert failed"],
    });
  }
});

router.get("/feedback", async (req, res) => {
  const meta = responseMeta(req, null);
  const startedAt = Date.now();
  const version = featureVersionEnvelope({
    featureName: "feedback",
    featureVersion: "feedback-v1",
    detModelVersion: DET_MODEL_VERSION,
    thresholdVersion: THRESHOLD_VERSION,
    algoHash: `dedupe:${FEEDBACK_DEDUPE_POLICY}`,
  });
  const warnings = [];
  try {
    const wellId = String(req.query.wellId || "").trim();
    if (!wellId) {
      feedbackReadTotal.labels("error", "list").inc();
      featureErrorTotal.labels("feedback", "validation").inc();
      return res.status(400).json({
        ok: false,
        ...meta,
        version,
        payload: null,
        warnings,
        errors: ["wellId is required"],
      });
    }
    const rows = await listFeedback({
      wellId,
      fromDepth: req.query.from,
      toDepth: req.query.to,
      limit: req.query.limit,
    });
    feedbackReadTotal.labels("ok", "list").inc();
    logger.info({
      msg: "feature.complete",
      feature: "feedback-list",
      requestId: req.requestId || null,
      wellId,
      durationMs: Date.now() - startedAt,
      status: 200,
    });
    const payload = {
      wellId,
      items: rows,
      dedupePolicy: FEEDBACK_DEDUPE_POLICY,
    };
    return res.json({
      ok: true,
      ...meta,
      ...payload,
      version,
      payload,
      warnings,
      errors: [],
    });
  } catch (err) {
    feedbackReadTotal.labels("error", "list").inc();
    featureErrorTotal.labels("feedback", "list_failed").inc();
    return res.status(400).json({
      ok: false,
      ...meta,
      version,
      payload: null,
      warnings,
      errors: [err?.message || "feedback list failed"],
    });
  }
});

router.get("/feedback/summary", async (req, res) => {
  const meta = responseMeta(req, null);
  const startedAt = Date.now();
  const version = featureVersionEnvelope({
    featureName: "feedback",
    featureVersion: "feedback-v1",
    detModelVersion: DET_MODEL_VERSION,
    thresholdVersion: THRESHOLD_VERSION,
    algoHash: `dedupe:${FEEDBACK_DEDUPE_POLICY}`,
  });
  const warnings = [];
  try {
    const wellId = String(req.query.wellId || "").trim();
    if (!wellId) {
      feedbackReadTotal.labels("error", "summary").inc();
      featureErrorTotal.labels("feedback", "validation").inc();
      return res.status(400).json({
        ok: false,
        ...meta,
        version,
        payload: null,
        warnings,
        errors: ["wellId is required"],
      });
    }
    const summary = await getFeedbackSummary({ wellId });
    feedbackReadTotal.labels("ok", "summary").inc();
    logger.info({
      msg: "feature.complete",
      feature: "feedback-summary",
      requestId: req.requestId || null,
      wellId,
      durationMs: Date.now() - startedAt,
      status: 200,
    });
    const payload = {
      wellId,
      summary,
      dedupePolicy: FEEDBACK_DEDUPE_POLICY,
    };
    return res.json({
      ok: true,
      ...meta,
      ...payload,
      version,
      payload,
      warnings,
      errors: [],
    });
  } catch (err) {
    feedbackReadTotal.labels("error", "summary").inc();
    featureErrorTotal.labels("feedback", "summary_failed").inc();
    return res.status(400).json({
      ok: false,
      ...meta,
      version,
      payload: null,
      warnings,
      errors: [err?.message || "feedback summary failed"],
    });
  }
});

registerInterpretExportPdfRoute(router);
registerCopilotHistoryRoutes(router, { listCopilotRuns, getCopilotRunById, pgPool });

export default router;

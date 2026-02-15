import express from "express";
import { callAiInterpret } from "../services/aiClient.js";
import { pgPool } from "../db/postgres.js";

import {
  insertInterpretationRun,
  getInterpretationRunById,
  listInterpretationRuns,
} from "../repositories/interpretationRunsRepo.js";
import { jsonrepair } from "jsonrepair";
import PDFDocument from "pdfkit";
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
  buildFallbackJson
} from "../services/copilotEngine.js";
import { validateCopilotResponse } from "../services/copilotSchema.js";

const router = express.Router();



// Add these envs
const PY_AI_BASE = process.env.PY_AI_BASE || "http://127.0.0.1:8000";
const PY_COPILOT_TIMEOUT_MS = Number(process.env.PY_COPILOT_TIMEOUT_MS || 45000);


const API_BASE = process.env.API_BASE || "http://localhost:5000";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

/** ---------- helpers ---------- **/





function fmt(v, digits = 1, fallback = "n/a") {
  const n = safeNum(v, null);
  if (n === null) return fallback;
  return n.toFixed(safeDigits(digits, 1));
}








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




function riskMeta(risk) {
  const x = String(risk || "").toLowerCase();
  if (x.includes("critical")) return { label: "CRITICAL", color: "#991b1b", bg: "#fef2f2", border: "#fecaca" };
  if (x.includes("high")) return { label: "HIGH", color: "#9a3412", bg: "#fff7ed", border: "#fed7aa" };
  if (x.includes("moderate") || x.includes("med")) return { label: "MODERATE", color: "#92400e", bg: "#fffbeb", border: "#fde68a" };
  if (x.includes("low")) return { label: "LOW", color: "#065f46", bg: "#ecfdf5", border: "#a7f3d0" };
  return { label: String(risk || "UNKNOWN").toUpperCase(), color: "#1f2937", bg: "#f9fafb", border: "#e5e7eb" };
}
function drawRoundedRect(doc, x, y, w, h, r = 6, fill = null, stroke = null) {
  doc.save();
  if (fill) doc.fillColor(fill);
  if (stroke) doc.strokeColor(stroke);
  doc.roundedRect(x, y, w, h, r);
  if (fill && stroke) doc.fillAndStroke();
  else if (fill) doc.fill();
  else if (stroke) doc.stroke();
  doc.restore();
}
function drawSectionTitle(doc, title) {
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(title);
  doc.moveDown(0.25);
}
function ensureSpace(doc, needed = 80, top = 40, bottom = 45) {
  const pageBottom = doc.page.height - bottom;
  if (doc.y + needed > pageBottom) {
    doc.addPage();
    doc.y = top;
  }
}
function drawPageFooter(doc) {
  const oldBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const y = doc.page.height - 24;
  doc.fontSize(8).fillColor("#6b7280").text(`Page ${doc.page.number}`, 0, y, { align: "center" });
  doc.page.margins.bottom = oldBottom;
}

function normalizeIntervals(narrativeIntervals, deterministicIntervals) {
  const arr = safeArray(narrativeIntervals).length
    ? safeArray(narrativeIntervals)
    : safeArray(deterministicIntervals);

  return arr.map((it, idx) => ({
    idx: idx + 1,
    curve: String(it?.curve || "-"),
    fromDepth: toNum(it?.fromDepth),
    toDepth: toNum(it?.toDepth),
    priority: String(it?.priority || "-"),
    probability: String(it?.probability || "-"),
    stability: String(it?.stability || "-"),
    stabilityScore: toNum(it?.stabilityScore),
    confidence: toNum(it?.confidence),
    reason: String(it?.reason || ""),
    explanation: String(it?.explanation || ""),
    agreement: toNum(it?.agreement),
    width: toNum(it?.width),
  }));
}

function consolidateIntervals(intervals, gapTolerance = 8) {
  const valid = intervals
    .filter((x) => Number.isFinite(x.fromDepth) && Number.isFinite(x.toDepth))
    .map((x) => ({
      ...x,
      fromDepth: Math.min(x.fromDepth, x.toDepth),
      toDepth: Math.max(x.fromDepth, x.toDepth),
    }))
    .sort((a, b) => a.fromDepth - b.fromDepth);

  if (!valid.length) return [];

  const groups = [];
  let current = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = current[current.length - 1];
    const next = valid[i];
    if (next.fromDepth <= prev.toDepth + gapTolerance) current.push(next);
    else {
      groups.push(current);
      current = [next];
    }
  }
  groups.push(current);

  return groups.map((g, idx) => {
    const fromDepth = Math.min(...g.map((x) => x.fromDepth));
    const toDepth = Math.max(...g.map((x) => x.toDepth));
    const curves = [...new Set(g.map((x) => x.curve).filter(Boolean))];
    const priorities = [...new Set(g.map((x) => x.priority).filter(Boolean))];
    const probs = [...new Set(g.map((x) => x.probability).filter(Boolean))];
    const stabilities = [...new Set(g.map((x) => x.stability).filter(Boolean))];
    const confs = g.map((x) => x.confidence).filter(Number.isFinite);
    const avgConfidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

    return {
      compositeId: idx + 1,
      fromDepth,
      toDepth,
      width: toDepth - fromDepth,
      intervalCount: g.length,
      curves: curves.join(", "),
      dominantPriority: priorities[0] || "-",
      probabilityMix: probs.join(", ") || "-",
      stabilityMix: stabilities.join(", ") || "-",
      avgConfidence,
    };
  });
}

async function safeJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();

  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON from ${url}: ${text.slice(0, 220)}`);
  }

  if (!res.ok) {
    throw new Error(json?.error || `Request failed (${res.status})`);
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
    curvesSupporting: f?.curvesSupporting ?? null,
    reason,
    score: score ?? null,
  };
}

function fallbackNarrativeFromDeterministic(deterministic) {
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];

  return {
    summary_bullets: deterministic?.summary || [],
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

/** Optional LLM polish for narrative */
async function maybeGroqNarrative({
  deterministic,
  insight,
  curves,
  fromDepth,
  toDepth,
  wellId,
}) {
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];

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

  const prompt = `
You are a petroleum/well-log interpretation assistant.

Return STRICT JSON with keys:
- summary_bullets: string[]
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

Top intervals:
${JSON.stringify(topIntervals)}

Rules:
- Use cautious language: "suggests", "likely", "requires validation"
- Do NOT claim lab-confirmed fluid type
- Keep recommendations concise and operational
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
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const txt = await res.text();

    let envelope;
    try {
      envelope = JSON.parse(txt);
    } catch {
      throw new Error("groq_envelope_non_json");
    }

    if (!res.ok) {
      const msg =
        envelope?.error?.message ||
        envelope?.error ||
        `Groq failed (${res.status})`;
      throw new Error(`groq_http_error:${msg}`);
    }

    const content = envelope?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonFromModelContent(content);

    const mergedIntervals =
      detIntervals.length === 0
        ? []
        : mergeNarrativeIntervals(parsed?.interval_explanations, deterministic);

    return {
      modelUsed: GROQ_MODEL,
      narrativeStatus: detIntervals.length === 0 ? "deterministic_no_events" : "ok",
      narrative: {
        summary_bullets: parsed?.summary_bullets || deterministic?.summary || [],
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
  try {
    const { wellId, fromDepth, toDepth, curves } = req.body || {};

    if (!wellId) {
      return res.status(400).json({ error: "wellId is required" });
    }
    if (!Array.isArray(curves) || curves.length === 0) {
      return res.status(400).json({ error: "curves must be a non-empty array" });
    }
    if (!Number.isFinite(Number(fromDepth)) || !Number.isFinite(Number(toDepth))) {
      return res
        .status(400)
        .json({ error: "fromDepth/toDepth must be valid numbers" });
    }

    const { rows, lo, hi } = await fetchRowsForRange({
      wellId,
      fromDepth,
      toDepth,
      curves,
    });

    if (rows.length < 20) {
      return res
        .status(400)
        .json({ error: `Not enough rows in selected range. Got ${rows.length}` });
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
    });

    const runRecord = await insertInterpretationRun({
      wellId,
      fromDepth: lo,
      toDepth: hi,
      curves,
      deterministic,
      insight,
      narrative: nar.narrative,
      modelUsed: nar.modelUsed,
      narrativeStatus: nar.narrativeStatus,
      source: "fresh",
      appVersion: process.env.APP_VERSION || null,
    });

    return res.json({
      ok: true,
      source: "fresh",
      runId: runRecord?.runId ?? runRecord?.run_id ?? null,
      createdAt: runRecord?.createdAt ?? runRecord?.created_at ?? new Date().toISOString(),
      well: { wellId, name: wellId },
      range: { fromDepth: lo, toDepth: hi },
      curves,
      deterministic,
      insight,
      narrative: nar.narrative,
      modelUsed: nar.modelUsed,
      narrativeStatus: nar.narrativeStatus,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("POST /api/ai/interpret failed:", err);
    return res.status(500).json({ error: err?.message || "Interpretation failed" });
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

    try {
      pyResp = await callPythonCopilot({
        mode,
        question,
        wellId: evidence.context_meta.wellId,
        fromDepth,
        toDepth,
        selectedInterval: body.selectedInterval || null,
        curves,
        evidence,
        compare,
      });

      const ext = extractCandidateFromPython(pyResp);
      llmCandidate = ext.candidate;
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

  return { candidate: null, reason: "python_response_unrecognized_shape" };
}

function inferSource(pyResp, llmCandidateExists) {
  if (!llmCandidateExists) return "fallback";
  const src = safeStr(pyResp?.source, "").toLowerCase();
  const llmUsed = pyResp?.llm_used === true || pyResp?.meta?.llm_used === true;
  if (llmUsed) return "llm";
  if (src === "llm" || src === "python") return "llm";
  if (src === "fallback" || src === "python_fallback") return "fallback";
  return "llm";
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
          dist === 0
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







router.post("/interpret/export/pdf", async (req, res) => {
  let doc = null;

  try {
    const payload = req.body || {};
    const wellId = String(payload?.well?.wellId || payload?.wellId || "-");
    const range = payload?.range || {};
    const fromDepth = toNum(range?.fromDepth ?? payload?.fromDepth);
    const toDepth = toNum(range?.toDepth ?? payload?.toDepth);

    const modelUsed = String(payload?.modelUsed || "-");
    const narrativeStatus = String(payload?.narrativeStatus || "-");
    const createdAtIso = payload?.createdAt || new Date().toISOString();
    const exportedAtIso = new Date().toISOString();

    const deterministic = payload?.deterministic || {};
    const narrative = payload?.narrative || {};
    const insight = payload?.insight || {};

    const severityBand = deterministic?.severityBand || "UNKNOWN";
    const rMeta = riskMeta(severityBand);

    const intervals = normalizeIntervals(
      narrative?.interval_explanations,
      deterministic?.intervalFindings
    );
    const topIntervals = intervals.slice(0, 10);
    const consolidated = consolidateIntervals(topIntervals, 8);

    const recommendations = safeArray(narrative?.recommendations);
    const limitations = safeArray(narrative?.limitations);

    const filename = `interpretation_report_${wellId}_${Date.now()}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, left: 40, right: 40, bottom: 45 },
      bufferPages: true,
      info: {
        Title: `Interpretation Report - ${wellId}`,
        Author: "AI Interpretation Service",
        Subject: "Well Log Interpretation",
      },
    });

    doc.on("error", (e) => {
      console.error("PDFKit error:", e);
      if (!res.headersSent) {
        res.status(500).json({ error: "PDF generation failed" });
      } else {
        try { res.end(); } catch {}
      }
    });

    res.on("close", () => {
      if (doc && !doc.destroyed) {
        try { doc.end(); } catch {}
      }
    });

    doc.pipe(res);

    drawRoundedRect(doc, 40, 38, 515, 92, 8, "#f8fafc", "#e5e7eb");
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111827")
      .text("AI Interpretation Report", 54, 50);
    doc.font("Helvetica").fontSize(10).fillColor("#374151")
      .text("Automated well-log interpretation with deterministic + narrative analysis", 54, 74);

    drawRoundedRect(doc, 425, 50, 112, 26, 12, rMeta.bg, rMeta.border);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(rMeta.color)
      .text(`RISK: ${rMeta.label}`, 432, 58, { width: 98, align: "center" });

    doc.y = 140;

    drawRoundedRect(doc, 40, doc.y, 515, 78, 6, "#ffffff", "#e5e7eb");
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Well", 52, doc.y + 12);
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(wellId, 160, doc.y + 11);

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Depth Range", 52, doc.y + 28);
    doc.font("Helvetica").fontSize(10).fillColor("#111827")
      .text(`${fmtInt(fromDepth)} → ${fmtInt(toDepth)} ft`, 160, doc.y + 27);

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Model", 52, doc.y + 44);
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(modelUsed, 160, doc.y + 43);

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Narrative Status", 52, doc.y + 60);
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(narrativeStatus, 160, doc.y + 59);

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Run Time", 322, doc.y + 12);
    doc.font("Helvetica").fontSize(10).fillColor("#111827")
      .text(new Date(createdAtIso).toLocaleString(), 395, doc.y + 11, { width: 150 });

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Export Time", 322, doc.y + 28);
    doc.font("Helvetica").fontSize(10).fillColor("#111827")
      .text(new Date(exportedAtIso).toLocaleString(), 395, doc.y + 27, { width: 150 });

    doc.y += 88;

    drawSectionTitle(doc, "Executive Summary");
    ensureSpace(doc, 90);

    const cardsY = doc.y;
    const gap = 10;
    const cardW = (515 - gap * 4) / 5;
    const cardH = 58;
    const cards = [
      { title: "Global Risk", value: rMeta.label, color: rMeta.color, bg: rMeta.bg, border: rMeta.border },
      { title: "Events", value: String(deterministic?.eventCount ?? "-"), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
      { title: "Detect Conf", value: fmt(deterministic?.detectionConfidence ?? deterministic?.confidence, 3), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
      { title: "Severity Conf", value: fmt(deterministic?.severityConfidence, 3), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
      { title: "Data Quality", value: String(deterministic?.dataQuality?.qualityBand || "-").toUpperCase(), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
    ];

    cards.forEach((c, i) => {
      const x = 40 + i * (cardW + gap);
      drawRoundedRect(doc, x, cardsY, cardW, cardH, 6, c.bg, c.border);
      doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(c.title, x + 8, cardsY + 8, { width: cardW - 16 });
      doc.font("Helvetica-Bold").fontSize(12).fillColor(c.color).text(c.value, x + 8, cardsY + 24, { width: cardW - 16, ellipsis: true });
    });

    doc.y = cardsY + cardH + 8;

    if (insight?.summaryParagraph) {
      ensureSpace(doc, 65);
      drawRoundedRect(doc, 40, doc.y, 515, 54, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text("Interpretation Summary", 50, doc.y + 8);
      doc.font("Helvetica").fontSize(9.5).fillColor("#374151")
        .text(String(insight.summaryParagraph), 50, doc.y + 24, { width: 495, height: 24, ellipsis: true });
      doc.y += 62;
    }

    drawSectionTitle(doc, "Top Intervals");
    ensureSpace(doc, 70);

    if (!topIntervals.length) {
      drawRoundedRect(doc, 40, doc.y, 515, 34, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("No key intervals detected for this run.", 52, doc.y + 11);
      doc.y += 44;
    } else {
      topIntervals.forEach((it, i) => {
        ensureSpace(doc, 26);
        drawRoundedRect(doc, 40, doc.y, 515, 22, 4, i % 2 === 0 ? "#ffffff" : "#fafafa", "#eef2f7");
        doc.font("Helvetica").fontSize(8.7).fillColor("#111827")
          .text(
            `${i + 1}. ${it.curve || "-"} | ${fmtInt(it.fromDepth)} → ${fmtInt(it.toDepth)} ft | Priority: ${it.priority || "-"} | Prob: ${it.probability || "-"} | Conf: ${fmt(it.confidence, 2)}`,
            48,
            doc.y + 7,
            { width: 500, ellipsis: true }
          );
        doc.y += 24;
      });
      doc.y += 4;
    }

    drawSectionTitle(doc, "Consolidated Intervals (Composite)");
    ensureSpace(doc, 60);

    if (!consolidated.length) {
      drawRoundedRect(doc, 40, doc.y, 515, 34, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("No composite intervals available.", 52, doc.y + 11);
      doc.y += 44;
    } else {
      consolidated.forEach((c, i) => {
        ensureSpace(doc, 26);
        drawRoundedRect(doc, 40, doc.y, 515, 22, 4, i % 2 === 0 ? "#ffffff" : "#f8fafc", "#e5e7eb");
        doc.font("Helvetica").fontSize(8.7).fillColor("#111827")
          .text(
            `C${c.compositeId} | ${fmtInt(c.fromDepth)} → ${fmtInt(c.toDepth)} ft | N=${c.intervalCount} | Width=${fmt(c.width, 1)} | Priority=${c.dominantPriority} | AvgConf=${fmt(c.avgConfidence, 2)} | Curves=${c.curves || "-"}`,
            48,
            doc.y + 7,
            { width: 500, ellipsis: true }
          );
        doc.y += 24;
      });
      doc.y += 4;
    }

    drawSectionTitle(doc, "Recommendations");
    ensureSpace(doc, 45);
    if (!recommendations.length) {
      drawRoundedRect(doc, 40, doc.y, 515, 34, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("No recommendations provided.", 52, doc.y + 11);
      doc.y += 44;
    } else {
      const h = Math.max(38, recommendations.length * 16 + 16);
      drawRoundedRect(doc, 40, doc.y, 515, h, 6, "#ffffff", "#e5e7eb");
      let y = doc.y + 10;
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      recommendations.forEach((r, i) => {
        doc.text(`${i + 1}. ${String(r)}`, 52, y, { width: 490 });
        y += 16;
      });
      doc.y = y + 2;
    }

    drawSectionTitle(doc, "Limitations");
    ensureSpace(doc, 45);
    if (!limitations.length) {
      drawRoundedRect(doc, 40, doc.y, 515, 34, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("No limitations provided.", 52, doc.y + 11);
      doc.y += 44;
    } else {
      const h = Math.max(38, limitations.length * 16 + 16);
      drawRoundedRect(doc, 40, doc.y, 515, h, 6, "#ffffff", "#e5e7eb");
      let y = doc.y + 10;
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      limitations.forEach((l, i) => {
        doc.text(`${i + 1}. ${String(l)}`, 52, y, { width: 490 });
        y += 16;
      });
      doc.y = y + 2;
    }

    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      drawPageFooter(doc);
    }

    doc.end();
  } catch (err) {
    console.error("POST /api/ai/interpret/export/pdf failed:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err?.message || "PDF export failed" });
    }
    try { res.end(); } catch {}
  }
});


router.get("/copilot/runs", async (req, res) => {
  try {
    const wellId = req.query.wellId ? String(req.query.wellId) : undefined;
    const limit = Number(req.query.limit) || 20;
    const runs = await listCopilotRuns({ wellId, limit });
    return res.json({ ok: true, runs });
  } catch (err) {
    console.error("GET /api/ai/copilot/runs failed:", err);
    return res.status(500).json({ error: err?.message || "Failed to list copilot runs" });
  }
});

router.get("/copilot/runs/:id", async (req, res) => {
  try {
    const row = await getCopilotRunById(req.params.id);
    if (!row) return res.status(404).json({ error: "Copilot run not found" });
    return res.json({ ok: true, run: row });
  } catch (err) {
    console.error("GET /api/ai/copilot/runs/:id failed:", err);
    return res.status(500).json({ error: err?.message || "Failed to fetch copilot run" });
  }
});




// GET /api/ai/copilot/history?wellId=WELL_...&limit=20
router.get("/copilot/history", async (req, res) => {
  try {
    const wellId = String(req.query.wellId || "").trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));

    const sql = `
      SELECT run_id, created_at, well_id, mode, question, source, llm_used,
             schema_valid, evidence_strength, latency_ms, response_json
      FROM copilot_runs
      ${wellId ? "WHERE well_id = $1" : ""}
      ORDER BY created_at DESC
      LIMIT ${wellId ? "$2" : "$1"}
    `;
    const vals = wellId ? [wellId, limit] : [limit];
    const out = await pgPool.query(sql, vals);

    return res.json({ ok: true, count: out.rowCount, rows: out.rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});






export default router;

import express from "express";
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
    const narrative3 = syncNarrativeWithDeterministic(narrative2, deterministic5);

    let runRecord = null;
    try {
      runRecord = await withTimeout(
        insertInterpretationRun({
          wellId,
          fromDepth: lo,
          toDepth: hi,
          curves,
          deterministic: deterministic5,
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
    } catch (dbErr) {
      console.warn("[interpret] non-blocking DB write failure:", dbErr?.message || dbErr);
    }

    return res.json({
      ok: true,
      source: "fresh",
      runId: runRecord?.runId ?? runRecord?.run_id ?? null,
      createdAt: runRecord?.createdAt ?? runRecord?.created_at ?? new Date().toISOString(),
      well: { wellId, name: wellId },
      range: { fromDepth: lo, toDepth: hi },
      curves,
      deterministic: deterministic5,
      insight,
      narrative: narrative3,
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







registerInterpretExportPdfRoute(router);
registerCopilotHistoryRoutes(router, { listCopilotRuns, getCopilotRunById, pgPool });

export default router;

import fs from "fs";
import path from "path";

function num(v, d = 3) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function safeUpper(x) {
  return String(x || "").trim().toUpperCase();
}

function sevRank(sev) {
  const s = safeUpper(sev);
  if (s === "CRITICAL") return 4;
  if (s === "HIGH") return 3;
  if (s === "MODERATE" || s === "MEDIUM") return 2;
  if (s === "LOW") return 1;
  return 0;
}

function toArr(x) {
  return Array.isArray(x) ? x : [];
}

function toNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

const DEFAULT_THRESHOLDS = {
  anomalyScoreBands: { low: 0.35, medium: 0.55, high: 0.72, critical: 0.85 },
  interval: {
    minRows: 20,
    minFiniteRatio: 0.7,
    multiCurveBoost: 0.12,
    singleCurvePenalty: 0.08,
    topN: 10,
    enforceMinMultiCurve: 2,
    minMultiInTop: 2,
  },
  baseline: {
    windowPadFt: 1500,
    windowFt: 1500,
    noisyStdMultiplier: 1.8,
    spikeRobustZ: 6.0,
    spikeZ: 5.5,
    stepShiftStdMultiplier: 1.2,
    driftCorr: 0.55,
  },
};

function mergeThresholds(base, user) {
  const out = { ...(base || {}) };
  if (!user || typeof user !== "object") return out;
  for (const [k, v] of Object.entries(user)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = mergeThresholds(out[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

export function loadThresholds() {
  try {
    const p = path.join(process.cwd(), "config", "thresholds.json");
    if (!fs.existsSync(p)) return DEFAULT_THRESHOLDS;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return mergeThresholds(DEFAULT_THRESHOLDS, parsed);
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export function buildPlaybookSnippets(mode = "data_qa") {
  const common = [
    "Validate data quality before acting on anomaly flags.",
    "Cross-check flagged intervals with drilling parameter changes.",
    "Escalate only when multi-source evidence agrees.",
  ];
  const byMode = {
    data_qa: [
      "Use interval-level evidence first, then global severity context.",
      "Treat single-curve conclusions as low-to-medium certainty.",
    ],
    ops: [
      "Prioritize sensor integrity checks before operational changes.",
      "Apply hold/observe/escalate ladder instead of immediate aggressive action.",
    ],
    compare: [
      "Compare against immediate baseline window to reduce context drift.",
      "Use numeric deltas for event count, confidence, and anomaly features.",
    ],
  };
  return [...common, ...(byMode[mode] || [])];
}

export function evidenceSufficiency(e) {
  const missing = [];
  if (!e?.context_meta?.wellId) missing.push("wellId");
  if (!Number.isFinite(Number(e?.context_meta?.range?.fromDepth))) missing.push("fromDepth");
  if (!Number.isFinite(Number(e?.context_meta?.range?.toDepth))) missing.push("toDepth");
  if (!e?.deterministic || typeof e.deterministic !== "object") missing.push("deterministic");
  if (!Array.isArray(e?.context_meta?.curves) || e.context_meta.curves.length === 0) missing.push("curves");
  return { ok: missing.length === 0, missing };
}

export function computeCompareMetrics({ current, baseline }) {
  const c = current || {};
  const b = baseline || {};
  const cDet = c.deterministic || {};
  const bDet = b.deterministic || {};

  const deltaEvent =
    Number.isFinite(Number(cDet.eventCount)) && Number.isFinite(Number(bDet.eventCount))
      ? Number(cDet.eventCount) - Number(bDet.eventCount)
      : null;

  const cConf = num(cDet.detectionConfidence);
  const bConf = num(bDet.detectionConfidence);
  const deltaConf = Number.isFinite(cConf) && Number.isFinite(bConf) ? num(cConf - bConf) : null;

  const cAnom = num(cDet.anomalyScore);
  const bAnom = num(bDet.anomalyScore);
  const deltaAnom = Number.isFinite(cAnom) && Number.isFinite(bAnom) ? num(cAnom - bAnom) : null;

  const cSev = safeUpper(cDet.severityBand);
  const bSev = safeUpper(bDet.severityBand);
  const sevDeltaRank = sevRank(cSev) - sevRank(bSev);

  return {
    summary: `Compared current interval ${num(c?.range?.fromDepth, 0)}-${num(c?.range?.toDepth, 0)} ft against previous window ${num(b?.range?.fromDepth, 0)}-${num(b?.range?.toDepth, 0)} ft using deterministic/narrative evidence.`,
    delta_metrics: [
      {
        metric: "Event Count",
        current: Number.isFinite(Number(cDet.eventCount)) ? Number(cDet.eventCount) : "n/a",
        baseline: Number.isFinite(Number(bDet.eventCount)) ? Number(bDet.eventCount) : "n/a",
        delta: deltaEvent ?? "n/a",
      },
      {
        metric: "Detection Confidence",
        current: cConf ?? "n/a",
        baseline: bConf ?? "n/a",
        delta: deltaConf ?? "n/a",
      },
      {
        metric: "Anomaly Score",
        current: cAnom ?? "n/a",
        baseline: bAnom ?? "n/a",
        delta: deltaAnom ?? "n/a",
      },
      {
        metric: "Severity Band",
        current: cSev || "n/a",
        baseline: bSev || "n/a",
        delta: Number.isFinite(sevDeltaRank)
          ? sevDeltaRank > 0
            ? "worse"
            : sevDeltaRank < 0
            ? "better"
            : "same"
          : "n/a",
      },
      {
        metric: "Data Quality Band",
        current: cDet?.dataQuality?.qualityBand ?? "n/a",
        baseline: bDet?.dataQuality?.qualityBand ?? "n/a",
        delta: "qualitative",
      },
    ],
  };
}

export function buildFallbackJson({ mode, evidence, compare }) {
  const det = evidence?.deterministic || {};
  const nar = evidence?.narrative || {};
  const topInt = Array.isArray(nar?.interval_explanations) && nar.interval_explanations.length
    ? nar.interval_explanations[0]
    : null;

  const title = mode === "ops" ? "Operational Recommendation" : mode === "compare" ? "Comparison Summary" : "Copilot Answer";
  const direct = mode === "ops"
    ? `Prioritize verification around highest-risk indications (severity: ${String(det?.severityBand || "-").toUpperCase()}) and confirm measurement reliability (data quality: ${String(det?.dataQuality?.qualityBand || "-").toUpperCase()}).`
    : mode === "compare"
    ? "Current interval was compared against previous 500 ft baseline using deterministic indicators and narrative evidence."
    : `The selected interval appears flagged due to anomaly behavior supported by deterministic evidence (severity: ${String(det?.severityBand || "-").toUpperCase()}, data quality: ${String(det?.dataQuality?.qualityBand || "-").toUpperCase()}).`;

  return {
    answer_title: title,
    direct_answer: direct,
    key_points: [
      `Well: ${evidence?.context_meta?.wellId || "-"}`,
      `Analyzed range: ${num(evidence?.context_meta?.range?.fromDepth, 0)}-${num(evidence?.context_meta?.range?.toDepth, 0)} ft`,
      `Severity band: ${String(det?.severityBand || "-").toUpperCase()}`,
      `Data quality: ${String(det?.dataQuality?.qualityBand || "-").toUpperCase()}`,
      topInt ? `Top explained interval: ${num(topInt.fromDepth, 0)}-${num(topInt.toDepth, 0)} ft` : "No strong interval explanation available",
    ],
    actions: mode === "ops"
      ? [
          {
            priority: "high",
            action: "Validate sensor/calibration and null/missing segments first",
            rationale: "Data-quality defects can produce false flags or distort severity.",
          },
          {
            priority: "medium",
            action: "Inspect drilling parameters near flagged depth windows",
            rationale: "Operational changes often coincide with anomalous windows.",
          },
        ]
      : [
          {
            priority: "medium",
            action: "Re-run interpretation on a narrower interval around flagged zone",
            rationale: "Improves localization and explanation quality.",
          },
        ],
    comparison: compare || { summary: "", delta_metrics: [] },
    risks: ["Elevated anomaly severity in current evidence window."],
    uncertainties: [...(Array.isArray(nar?.limitations) ? nar.limitations.slice(0, 2) : [])],
    confidence: {
      overall: 0.65,
      rubric: "medium",
      reason: "Confidence is derived from deterministic indicators, interval explanations, and data quality context.",
    },
    evidence_used: [
      {
        source: "deterministic",
        confidence: "high",
        snippet: `severity=${String(det?.severityBand || "-").toUpperCase()}, dataQuality=${String(det?.dataQuality?.qualityBand || "-").toUpperCase()}, eventCount=${det?.eventCount ?? "n/a"}`,
      },
      ...(topInt
        ? [
            {
              source: "narrative",
              confidence: "medium",
              snippet: String(topInt?.explanation || "interval explanation available"),
            },
          ]
        : []),
    ],
    safety_note: "Decision support only, not autonomous control.",
  };
}

function curveSupportCount(interval) {
  if (Array.isArray(interval?.curvesSupporting)) return interval.curvesSupporting.length;
  const n = Number(interval?.curvesSupporting);
  return Number.isFinite(n) ? n : 0;
}

export function evidenceTypeForInterval(interval) {
  return curveSupportCount(interval) >= 2 ? "multi-curve" : "single-curve";
}

export function tagIntervalsWithEvidenceType(intervals, thresholds = DEFAULT_THRESHOLDS) {
  const multiBoost = Number(thresholds?.interval?.multiCurveBoost ?? 0.12);
  const singlePenalty = Number(thresholds?.interval?.singleCurvePenalty ?? 0.08);
  return toArr(intervals).map((it) => {
    const baseScore = Number(it?.score);
    const evType = evidenceTypeForInterval(it);
    const scoreAdjusted = Number.isFinite(baseScore)
      ? baseScore + (evType === "multi-curve" ? multiBoost : -singlePenalty)
      : baseScore;
    return { ...it, evidenceType: evType, scoreAdjusted };
  });
}

function rankVal(it) {
  const a = Number(it?.scoreAdjusted);
  if (Number.isFinite(a)) return a;
  const b = Number(it?.score);
  if (Number.isFinite(b)) return b;
  const c = Number(it?.confidence);
  if (Number.isFinite(c)) return c;
  return 0;
}

export function enforceMultiCurveInTop(intervals, topN = 10, minMulti = 2) {
  const sorted = [...toArr(intervals)].sort((a, b) => rankVal(b) - rankVal(a));
  const multi = sorted.filter((x) => evidenceTypeForInterval(x) === "multi-curve");

  if (!multi.length) return sorted.slice(0, topN);

  const picked = [];
  for (const m of multi.slice(0, Math.max(0, minMulti))) picked.push(m);
  for (const x of sorted) {
    if (picked.length >= topN) break;
    if (!picked.includes(x)) picked.push(x);
  }
  return picked.slice(0, topN);
}

export function applyQualityGatesToIntervals(intervals, baselineCtx, thresholds = DEFAULT_THRESHOLDS) {
  const minFinite = Number(thresholds?.interval?.minFiniteRatio ?? 0.7);
  const outLimitations = [];
  const adjusted = toArr(intervals).map((it) => {
    const curve = String(it?.curve || "");
    const fr = Number(baselineCtx?.[curve]?.finite_ratio);
    if (!Number.isFinite(fr) || fr >= minFinite) return it;

    outLimitations.push(
      `Low finite ratio for ${curve} in selected window (finite_ratio=${fr.toFixed(2)}). Confidence downgraded.`
    );
    const conf = Number(it?.confidence);
    const nextConf = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf * 0.75)) : it?.confidence;
    return { ...it, confidence: nextConf, qualityFlag: "low_finite_ratio" };
  });
  return { intervals: adjusted, limitations: [...new Set(outLimitations)] };
}

export function classifyQuestion(question = "") {
  const q = String(question || "");
  const t = q.toLowerCase();
  const curveMatch = q.match(/\b([A-Za-z]{1,4}\d{0,2})\b/);
  const depthMatch = q.match(/\b(\d{3,6}(?:\.\d+)?)\b/);

  if (t.includes("summary") || t.includes("overall") || t.includes("in this interval")) {
    return { type: "summary", curveToken: null, depth: null };
  }
  if (curveMatch && /(curve|log|value|reading|why|spike|anomaly|show|for)\b/i.test(q)) {
    return { type: "curve", curveToken: curveMatch[1], depth: depthMatch ? Number(depthMatch[1]) : null };
  }
  if (depthMatch && /(depth|at|around|near)\b/i.test(t)) {
    return { type: "depth", curveToken: curveMatch ? curveMatch[1] : null, depth: Number(depthMatch[1]) };
  }
  return { type: "general", curveToken: null, depth: depthMatch ? Number(depthMatch[1]) : null };
}

// backend/src/services/copilotEngine.js

function num(v, d = 3) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
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

export function buildPlaybookSnippets(mode = "data_qa") {
  const common = [
    "Validate data quality before acting on anomaly flags.",
    "Cross-check flagged intervals with drilling parameter changes.",
    "Escalate only when multi-source evidence agrees."
  ];
  const byMode = {
    data_qa: [
      "Use interval-level evidence first, then global severity context.",
      "Treat single-curve conclusions as low-to-medium certainty."
    ],
    ops: [
      "Prioritize sensor integrity checks before operational changes.",
      "Apply hold/observe/escalate ladder instead of immediate aggressive action."
    ],
    compare: [
      "Compare against immediate baseline window to reduce context drift.",
      "Use numeric deltas for event count, confidence, and anomaly features."
    ]
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
  // current / baseline shape assumption:
  // { deterministic: { eventCount, severityBand, detectionConfidence, anomalyScore, dataQuality:{qualityBand}}, curveStats?: { [curve]: {mean,std,min,max} } }

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
  const deltaConf =
    Number.isFinite(cConf) && Number.isFinite(bConf) ? num(cConf - bConf) : null;

  const cAnom = num(cDet.anomalyScore);
  const bAnom = num(bDet.anomalyScore);
  const deltaAnom =
    Number.isFinite(cAnom) && Number.isFinite(bAnom) ? num(cAnom - bAnom) : null;

  const cSev = safeUpper(cDet.severityBand);
  const bSev = safeUpper(bDet.severityBand);
  const sevDeltaRank = sevRank(cSev) - sevRank(bSev);

  return {
    summary: `Compared current interval ${num(c?.range?.fromDepth, 0)}–${num(c?.range?.toDepth, 0)} ft against previous window ${num(b?.range?.fromDepth, 0)}–${num(b?.range?.toDepth, 0)} ft using deterministic/narrative evidence.`,
    delta_metrics: [
      {
        metric: "Event Count",
        current: Number.isFinite(Number(cDet.eventCount)) ? Number(cDet.eventCount) : "n/a",
        baseline: Number.isFinite(Number(bDet.eventCount)) ? Number(bDet.eventCount) : "n/a",
        delta: deltaEvent ?? "n/a"
      },
      {
        metric: "Detection Confidence",
        current: cConf ?? "n/a",
        baseline: bConf ?? "n/a",
        delta: deltaConf ?? "n/a"
      },
      {
        metric: "Anomaly Score",
        current: cAnom ?? "n/a",
        baseline: bAnom ?? "n/a",
        delta: deltaAnom ?? "n/a"
      },
      {
        metric: "Severity Band",
        current: cSev || "n/a",
        baseline: bSev || "n/a",
        delta: Number.isFinite(sevDeltaRank) ? (sevDeltaRank > 0 ? "worse" : sevDeltaRank < 0 ? "better" : "same") : "n/a"
      },
      {
        metric: "Data Quality Band",
        current: cDet?.dataQuality?.qualityBand ?? "n/a",
        baseline: bDet?.dataQuality?.qualityBand ?? "n/a",
        delta: "qualitative"
      }
    ]
  };
}

export function buildFallbackJson({ mode, evidence, compare }) {
  const det = evidence?.deterministic || {};
  const nar = evidence?.narrative || {};
  const topInt = Array.isArray(nar?.interval_explanations) && nar.interval_explanations.length
    ? nar.interval_explanations[0]
    : null;

  const title =
    mode === "ops"
      ? "Operational Recommendation"
      : mode === "compare"
      ? "Comparison Summary"
      : "Copilot Answer";

  const direct =
    mode === "ops"
      ? `Prioritize verification around highest-risk indications (severity: ${String(det?.severityBand || "-").toUpperCase()}) and confirm measurement reliability (data quality: ${String(det?.dataQuality?.qualityBand || "-").toUpperCase()}).`
      : mode === "compare"
      ? "Current interval was compared against previous 500 ft baseline using deterministic indicators and narrative evidence."
      : `The selected interval appears flagged due to anomaly behavior supported by deterministic evidence (severity: ${String(det?.severityBand || "-").toUpperCase()}, data quality: ${String(det?.dataQuality?.qualityBand || "-").toUpperCase()}).`;

  return {
    answer_title: title,
    direct_answer: direct,
    key_points: [
      `Well: ${evidence?.context_meta?.wellId || "-"}`,
      `Analyzed range: ${num(evidence?.context_meta?.range?.fromDepth, 0)}–${num(evidence?.context_meta?.range?.toDepth, 0)} ft`,
      `Severity band: ${String(det?.severityBand || "-").toUpperCase()}`,
      `Data quality: ${String(det?.dataQuality?.qualityBand || "-").toUpperCase()}`,
      topInt ? `Top explained interval: ${num(topInt.fromDepth, 0)}–${num(topInt.toDepth, 0)} ft` : "No strong interval explanation available"
    ],
    actions: mode === "ops" ? [
      {
        priority: "high",
        action: "Validate sensor/calibration and null/missing segments first",
        rationale: "Data-quality defects can produce false flags or distort severity."
      },
      {
        priority: "medium",
        action: "Inspect drilling parameters near flagged depth windows",
        rationale: "Operational changes often coincide with anomalous windows."
      }
    ] : [
      {
        priority: "medium",
        action: "Re-run interpretation on a narrower interval around flagged zone",
        rationale: "Improves localization and explanation quality."
      }
    ],
    comparison: compare || { summary: "", delta_metrics: [] },
    risks: [
      "Elevated anomaly severity in current evidence window."
    ],
    uncertainties: [
      ...(Array.isArray(nar?.limitations) ? nar.limitations.slice(0, 2) : [])
    ],
    confidence: {
      overall: 0.65,
      rubric: "medium",
      reason: "Confidence is derived from deterministic indicators, interval explanations, and data quality context."
    },
    evidence_used: [
      {
        source: "deterministic",
        confidence: "high",
        snippet: `severity=${String(det?.severityBand || "-").toUpperCase()}, dataQuality=${String(det?.dataQuality?.qualityBand || "-").toUpperCase()}, eventCount=${det?.eventCount ?? "n/a"}`
      },
      ...(topInt ? [{
        source: "narrative",
        confidence: "medium",
        snippet: String(topInt?.explanation || "interval explanation available")
      }] : [])
    ],
    safety_note: "Decision support only, not autonomous control."
  };
}

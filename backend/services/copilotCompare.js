function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function clampRange(fromDepth, toDepth) {
  const a = n(fromDepth), b = n(toDepth);
  if (a == null || b == null) return null;
  return { fromDepth: Math.min(a, b), toDepth: Math.max(a, b) };
}

/**
 * Build baseline as previous 500ft window right before current window.
 * If current is [F,T], baseline is [F-500, F].
 */
export function buildPrevious500ftBaseline(currentRange) {
  const r = clampRange(currentRange?.fromDepth, currentRange?.toDepth);
  if (!r) return null;
  const width = r.toDepth - r.fromDepth;
  const baselineWidth = 500;
  return {
    fromDepth: r.fromDepth - baselineWidth,
    toDepth: r.fromDepth,
    reference: "previous_500ft",
    currentWidth: width,
  };
}

/**
 * Very lightweight deterministic comparison summary.
 * You can enrich with real baseline deterministic output later.
 */
export function buildComparisonDelta({ currentDet, baselineDet }) {
  const c = currentDet || {};
  const b = baselineDet || {};

  const cEvent = Number(c.eventCount ?? 0);
  const bEvent = Number(b.eventCount ?? 0);

  const cScore = Number(c.anomalyScore ?? 0);
  const bScore = Number(b.anomalyScore ?? 0);

  const cConf = Number(c.detectionConfidence ?? c.confidence ?? 0);
  const bConf = Number(b.detectionConfidence ?? b.confidence ?? 0);

  return {
    summary: "Current interval compared against previous 500ft baseline.",
    delta_metrics: [
      { metric: "eventCount", current: cEvent, baseline: bEvent, delta: cEvent - bEvent },
      { metric: "anomalyScore", current: cScore, baseline: bScore, delta: Number((cScore - bScore).toFixed(3)) },
      { metric: "detectionConfidence", current: cConf, baseline: bConf, delta: Number((cConf - bConf).toFixed(3)) },
    ],
  };
}

function fmtNum(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function severityRank(v) {
  const s = String(v || "").toUpperCase();
  if (s === "CRITICAL") return 4;
  if (s === "HIGH") return 3;
  if (s === "MEDIUM") return 2;
  if (s === "LOW") return 1;
  return 0;
}

export function generateIntervalDiffNarrative(diffPayload) {
  const event = diffPayload?.eventDiff || {};
  const top = Array.isArray(diffPayload?.topChanges) ? diffPayload.topChanges.slice(0, 3) : [];

  const aSeverity = String(event?.severityBandA || "UNKNOWN").toUpperCase();
  const bSeverity = String(event?.severityBandB || "UNKNOWN").toUpperCase();
  const sevDelta = severityRank(bSeverity) - severityRank(aSeverity);

  const trendPhrase =
    sevDelta > 0
      ? "risk intensity increased"
      : sevDelta < 0
      ? "risk intensity decreased"
      : "risk intensity remained broadly similar";

  const scoreA = fmtNum(event?.anomalyScoreA, 3);
  const scoreB = fmtNum(event?.anomalyScoreB, 3);

  const opening = `Interval comparison indicates ${trendPhrase} from A (${aSeverity}) to B (${bSeverity}), with anomaly score moving from ${scoreA} to ${scoreB}.`;
  if (!top.length) return opening;

  return `${opening} Top drivers: ${top.join("; ")}.`;
}


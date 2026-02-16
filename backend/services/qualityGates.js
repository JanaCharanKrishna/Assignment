import { getThresholds } from "./thresholds.js";

export function curveQualityStats(rows, curve) {
  const vals = (rows || []).map((r) => r?.values?.[curve] ?? r?.[curve]);
  const n = vals.length;
  if (!n) return { curve, points: 0, finite: 0, finiteRatio: 0, nullRatio: 1 };

  let finite = 0;
  let nul = 0;
  for (const raw of vals) {
    const v = Number(raw);
    if (raw === null || raw === undefined || Number.isNaN(v)) {
      nul += 1;
      continue;
    }
    if (Number.isFinite(v)) finite += 1;
    else nul += 1;
  }
  return {
    curve,
    points: n,
    finite,
    finiteRatio: finite / n,
    nullRatio: nul / n,
  };
}

export function applyQualityGates({ rows, curves, deterministic, narrative }) {
  const T = getThresholds();
  const q = (curves || []).map((c) => curveQualityStats(rows || [], c));
  const bad = q.filter(
    (x) =>
      x.points < Number(T?.quality?.minPoints ?? 20) ||
      x.finiteRatio < Number(T?.quality?.minFiniteRatio ?? 0.7) ||
      x.nullRatio > Number(T?.quality?.maxNullRatio ?? 0.25)
  );

  const limitations = Array.isArray(narrative?.limitations)
    ? [...narrative.limitations]
    : [];
  for (const b of bad) {
    limitations.push(
      `Data quality gate: curve ${b.curve} finiteRatio=${b.finiteRatio.toFixed(
        2
      )}, nullRatio=${b.nullRatio.toFixed(2)}. Confidence downgraded.`
    );
  }

  const det = deterministic && typeof deterministic === "object" ? { ...deterministic } : {};
  det.curveQuality = q;
  det.qualityPenalty = bad.length === 0 ? 1 : bad.length === 1 ? 0.85 : bad.length === 2 ? 0.7 : 0.55;

  return {
    deterministic: det,
    narrative: { ...(narrative || {}), limitations },
  };
}


import { getThresholds } from "./thresholds.js";

function overlap(aFrom, aTo, bFrom, bTo) {
  const lo = Math.max(aFrom, bFrom);
  const hi = Math.min(aTo, bTo);
  return Math.max(0, hi - lo);
}

function parseCurveSet(curveField) {
  if (!curveField) return [];
  if (Array.isArray(curveField)) {
    return [...new Set(curveField.map((c) => String(c || "").trim()).filter(Boolean))];
  }
  return [...new Set(String(curveField).split(",").map((s) => s.trim()).filter(Boolean))];
}

function toCurveField(curves) {
  return [...new Set((curves || []).map((c) => String(c || "").trim()).filter(Boolean))].join(",");
}

export function consolidateMultiCurveIntervals(deterministic) {
  const T = getThresholds();
  const det = deterministic && typeof deterministic === "object" ? { ...deterministic } : {};
  const arr = Array.isArray(det.intervalFindings)
    ? det.intervalFindings.map((x) => ({ ...x }))
    : [];
  if (!arr.length) return det;

  arr.sort((a, b) => Number(b.score2 ?? b.score ?? 0) - Number(a.score2 ?? a.score ?? 0));

  const minSupport = Number(T?.ranking?.multiCurveMinSupport ?? 2);
  for (const f of arr) {
    const supporters = new Set(parseCurveSet(f?.curve));
    for (const g of arr) {
      if (f === g) continue;
      const f0 = Number(f.fromDepth);
      const f1 = Number(f.toDepth);
      const g0 = Number(g.fromDepth);
      const g1 = Number(g.toDepth);
      if (![f0, f1, g0, g1].every(Number.isFinite)) continue;
      const ov = overlap(f0, f1, g0, g1);
      const minW = Math.max(1e-9, Math.min(Math.abs(f1 - f0), Math.abs(g1 - g0)));
      if (ov / minW >= 0.35) {
        for (const c of parseCurveSet(g?.curve)) supporters.add(c);
      }
    }
    const supportCount = supporters.size;
    f.curve = toCurveField([...supporters]) || String(f?.curve || "");
    f.curvesSupporting = supportCount;
    f.evidenceType = supportCount >= minSupport ? "multi-curve" : "single-curve";
  }

  const requireTopN = Number(T?.ranking?.requireMultiCurveTopN ?? 2);
  const multi = arr.filter((x) => Number(x.curvesSupporting) >= minSupport);

  if (multi.length) {
    const enforced = [];
    enforced.push(...multi.slice(0, requireTopN));
    for (const f of arr) {
      if (enforced.length >= Math.max(6, requireTopN)) break;
      if (!enforced.includes(f)) enforced.push(f);
    }
    det.intervalFindings = enforced;
  } else {
    det.intervalFindings = arr.slice(0, 8);
  }

  return det;
}

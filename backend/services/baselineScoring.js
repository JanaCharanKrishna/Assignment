import { getThresholds } from "./thresholds.js";

function mean(xs) {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function std(xs) {
  const m = mean(xs);
  if (m === null) return null;
  const v = xs.filter(Number.isFinite);
  const s2 = v.reduce((a, x) => a + (x - m) * (x - m), 0) / Math.max(1, v.length - 1);
  return Math.sqrt(s2);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function series(rows, curve) {
  const out = [];
  for (const r of rows || []) {
    const d = Number(r?.depth);
    const v = Number(r?.values?.[curve] ?? r?.[curve]);
    if (!Number.isFinite(d) || !Number.isFinite(v)) continue;
    out.push({ d, v });
  }
  return out;
}

function parseCurveSet(curveField) {
  if (!curveField) return [];
  if (Array.isArray(curveField)) {
    return [...new Set(curveField.map((c) => String(c || "").trim()).filter(Boolean))];
  }
  return [...new Set(String(curveField).split(",").map((s) => s.trim()).filter(Boolean))];
}

function windowSlice(s, fromD, toD) {
  const lo = Math.min(fromD, toD);
  const hi = Math.max(fromD, toD);
  return s.filter((p) => p.d >= lo && p.d <= hi).map((p) => p.v);
}

function featSpike(vals, mu, sd) {
  if (!vals.length || !Number.isFinite(mu) || !Number.isFinite(sd) || sd === 0) return 0;
  return Math.max(...vals.map((v) => Math.abs((v - mu) / sd)));
}

function featStep(vals) {
  if (vals.length < 8) return 0;
  const mid = Math.floor(vals.length / 2);
  const a = mean(vals.slice(0, mid));
  const b = mean(vals.slice(mid));
  if (a === null || b === null) return 0;
  return Math.abs(b - a);
}

function featDrift(vals) {
  if (vals.length < 10) return 0;
  const w = Math.max(2, Math.floor(vals.length * 0.2));
  const a = mean(vals.slice(0, w));
  const b = mean(vals.slice(-w));
  if (a === null || b === null) return 0;
  return Math.abs(b - a);
}

function featNoise(vals, mu, sd) {
  if (!vals.length || !Number.isFinite(mu) || mu === 0 || sd === null) return 0;
  return Math.abs(sd / mu);
}

function averageFinite(list) {
  const nums = (list || []).map((x) => Number(x)).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function aggregateBaseline(curveBaselines) {
  const valid = (curveBaselines || []).filter(Boolean);
  if (!valid.length) return null;

  const mu = averageFinite(valid.map((x) => x?.mu));
  const sd = averageFinite(valid.map((x) => x?.sd));
  const localMu = averageFinite(valid.map((x) => x?.localMu));
  const localSd = averageFinite(valid.map((x) => x?.localSd));
  const spikeZ = averageFinite(valid.map((x) => x?.spikeZ));
  const stepZ = averageFinite(valid.map((x) => x?.stepZ));
  const driftZ = averageFinite(valid.map((x) => x?.driftZ));
  const noiseCv = averageFinite(valid.map((x) => x?.noiseCv));

  return {
    mu: Number.isFinite(mu) ? Number(mu.toFixed(4)) : null,
    sd: Number.isFinite(sd) ? Number(sd.toFixed(4)) : null,
    localMu: Number.isFinite(localMu) ? Number(localMu.toFixed(4)) : null,
    localSd: Number.isFinite(localSd) ? Number(localSd.toFixed(4)) : null,
    spikeZ: Number.isFinite(spikeZ) ? Number(spikeZ.toFixed(3)) : null,
    stepZ: Number.isFinite(stepZ) ? Number(stepZ.toFixed(3)) : null,
    driftZ: Number.isFinite(driftZ) ? Number(driftZ.toFixed(3)) : null,
    noiseCv: Number.isFinite(noiseCv) ? Number(noiseCv.toFixed(3)) : null,
    evidenceType:
      (Number.isFinite(stepZ) ? stepZ : -Infinity) >
      (Number.isFinite(spikeZ) ? spikeZ : -Infinity)
        ? "step_change"
        : "spike",
    evidenceStrength: Number.isFinite(Math.max(spikeZ ?? 0, stepZ ?? 0, driftZ ?? 0))
      ? Number(Math.max(spikeZ ?? 0, stepZ ?? 0, driftZ ?? 0).toFixed(3))
      : 0,
  };
}

export function applyBaselineAwareScoring({ rows, curves, deterministic }) {
  const T = getThresholds();
  const det = deterministic && typeof deterministic === "object" ? { ...deterministic } : {};
  const findings = Array.isArray(det.intervalFindings)
    ? det.intervalFindings.map((x) => ({ ...x }))
    : [];
  if (!findings.length) return det;

  const curveBase = {};
  for (const c of curves || []) {
    const s = series(rows || [], c);
    const vals = s.map((p) => p.v);
    curveBase[c] = { mu: mean(vals), sd: std(vals) };
  }

  for (const f of findings) {
    const curveParts = parseCurveSet(f?.curve);
    const curveForSeries = curveParts[0] || String(f?.curve || "");
    const base = curveBase[curveForSeries] || {};
    const mu = base.mu;
    const sd = base.sd;

    const vals = windowSlice(
      series(rows || [], curveForSeries),
      Number(f.fromDepth),
      Number(f.toDepth)
    );
    const localMu = mean(vals);
    const localSd = std(vals);

    const spikeZ = featSpike(vals, mu, sd);
    const step = featStep(vals);
    const drift = featDrift(vals);
    const noiseCv = featNoise(vals, localMu ?? mu ?? 1, localSd ?? sd);

    const spikeScore = clamp01((spikeZ - Number(T?.detection?.spikeZ ?? 3)) / 3);
    const stepScore = clamp01(((step / (sd || 1e-9)) - Number(T?.detection?.stepZ ?? 2.5)) / 3);
    const driftScore = clamp01(((drift / (sd || 1e-9)) - Number(T?.detection?.driftSlopeZ ?? 2.0)) / 3);
    const noiseScore = clamp01(((noiseCv / 0.5) - Number(T?.detection?.noiseCvZ ?? 2.5)) / 3);

    const scored = [
      ["spike", spikeScore],
      ["step", stepScore],
      ["drift", driftScore],
      ["noisy", noiseScore],
    ].sort((a, b) => b[1] - a[1]);

    const [bestType, bestScore] = scored[0];
    f.baseline = {
      mu: Number.isFinite(mu) ? Number(mu.toFixed(4)) : null,
      sd: Number.isFinite(sd) ? Number(sd.toFixed(4)) : null,
      localMu: Number.isFinite(localMu) ? Number(localMu.toFixed(4)) : null,
      localSd: Number.isFinite(localSd) ? Number(localSd.toFixed(4)) : null,
      spikeZ: Number.isFinite(spikeZ) ? Number(spikeZ.toFixed(3)) : null,
      stepZ: Number.isFinite(sd) && sd ? Number((step / sd).toFixed(3)) : null,
      driftZ: Number.isFinite(sd) && sd ? Number((drift / sd).toFixed(3)) : null,
      noiseCv: Number.isFinite(noiseCv) ? Number(noiseCv.toFixed(3)) : null,
      evidenceType: bestType,
      evidenceStrength: Number(bestScore.toFixed(3)),
    };

    if (curveParts.length > 1) {
      const perCurve = curveParts.map((curveId) => {
        const b = curveBase[curveId] || {};
        const cVals = windowSlice(
          series(rows || [], curveId),
          Number(f.fromDepth),
          Number(f.toDepth)
        );
        const cLocalMu = mean(cVals);
        const cLocalSd = std(cVals);
        return {
          mu: b.mu,
          sd: b.sd,
          localMu: cLocalMu,
          localSd: cLocalSd,
          spikeZ: featSpike(cVals, b.mu, b.sd),
          stepZ: Number.isFinite(b?.sd) && b.sd ? featStep(cVals) / b.sd : null,
          driftZ: Number.isFinite(b?.sd) && b.sd ? featDrift(cVals) / b.sd : null,
          noiseCv: featNoise(cVals, cLocalMu ?? b.mu ?? 1, cLocalSd ?? b.sd),
        };
      });
      const agg = aggregateBaseline(perCurve);
      if (agg) f.baseline = agg;
    }

    const qp = Number(det.qualityPenalty ?? 1);
    const baseScore = Number(f.score ?? 0);
    f.score2 = Number((baseScore + bestScore * 0.25 * qp).toFixed(4));
  }

  det.intervalFindings = findings;
  return det;
}

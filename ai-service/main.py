from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Dict, List, Optional, Tuple
import numpy as np

app = FastAPI()

EPS = 1e-9


# -----------------------------
# Schemas
# -----------------------------
class Row(BaseModel):
    depth: float
    values: Dict[str, Optional[float]]


class InterpretRequest(BaseModel):
    wellId: str
    fromDepth: float
    toDepth: float
    curves: List[str] = Field(min_length=1)
    rows: List[Row] = Field(min_length=20)


# -----------------------------
# Math helpers
# -----------------------------
def safe_float(x, default=0.0):
    try:
        v = float(x)
        if np.isfinite(v):
            return v
        return default
    except Exception:
        return default


def robust_z(x: np.ndarray) -> np.ndarray:
    med = np.nanmedian(x)
    mad = np.nanmedian(np.abs(x - med))
    scale = 1.4826 * mad
    if not np.isfinite(scale) or scale < EPS:
        sd = np.nanstd(x)
        if not np.isfinite(sd) or sd < EPS:
            return np.zeros_like(x, dtype=float)
        return (x - np.nanmean(x)) / (sd + EPS)
    return (x - med) / (scale + EPS)


def rolling_mean(x: np.ndarray, w: int) -> np.ndarray:
    w = max(3, int(w))
    n = len(x)
    if n < w:
        return np.full_like(x, np.nan, dtype=float)

    # robust handling for NaNs
    z = np.nan_to_num(x, nan=0.0)
    mask = np.isfinite(x).astype(float)
    kernel = np.ones(w, dtype=float)

    num = np.convolve(z, kernel, mode="same")
    den = np.convolve(mask, kernel, mode="same")
    out = np.where(den > 0, num / np.maximum(den, EPS), np.nan)
    return out


def contiguous_runs(mask: np.ndarray) -> List[Tuple[int, int]]:
    runs = []
    n = len(mask)
    i = 0
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and mask[j + 1]:
            j += 1
        runs.append((i, j))
        i = j + 1
    return runs


def classify_interval(x: np.ndarray, depths: np.ndarray, i: int, j: int) -> str:
    seg = x[i:j + 1]
    if len(seg) < 4:
        return "spike"

    span = float(max(depths[j] - depths[i], 1e-6))
    seg_f = np.nan_to_num(seg, nan=np.nanmedian(seg))

    d1 = np.gradient(seg_f)
    d2 = np.gradient(d1)

    peakiness = float(np.nanmax(np.abs(seg_f - np.nanmedian(seg_f))))
    slope_strength = float(np.nanmean(np.abs(d1)))
    curvature = float(np.nanmean(np.abs(d2)))
    stdev = float(np.nanstd(seg_f)) + EPS

    if span < 12 and peakiness / stdev > 2.0:
        return "spike"

    if curvature < 0.12 * (slope_strength + EPS) and slope_strength > 0.0:
        return "drift"

    mid = len(seg_f) // 2
    if mid > 1:
        m1 = float(np.nanmean(seg_f[:mid]))
        m2 = float(np.nanmean(seg_f[mid:]))
        if abs(m2 - m1) / stdev > 0.8:
            return "step_change"

    return "noisy_zone"


def merge_intervals(raw_intervals, max_gap_idx: int):
    if not raw_intervals:
        return []
    raw_intervals = sorted(raw_intervals, key=lambda t: t["i"])
    out = [raw_intervals[0].copy()]

    for cur in raw_intervals[1:]:
        prev = out[-1]
        close = cur["i"] <= prev["j"] + max_gap_idx
        same_type = cur["type"] == prev["type"]
        if close and same_type:
            prev["j"] = max(prev["j"], cur["j"])
            prev["score"] = max(prev["score"], cur["score"])
            prev["curves"] = sorted(set(prev["curves"]) | set(cur["curves"]))
        else:
            out.append(cur.copy())
    return out


def interval_iou(a0: float, a1: float, b0: float, b1: float) -> float:
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    union = max(a1, b1) - min(a0, b0) + 1e-9
    return inter / union


def nms_intervals(findings: List[dict], iou_thr: float = 0.55) -> List[dict]:
    kept = []
    for f in findings:
        keep = True
        for k in kept:
            if interval_iou(f["fromDepth"], f["toDepth"], k["fromDepth"], k["toDepth"]) >= iou_thr:
                keep = False
                break
        if keep:
            kept.append(f)
    return kept


def enforce_zone_separation(findings: List[dict], min_sep: float = 22.0, max_keep: int = 6) -> List[dict]:
    out = []
    centers = []
    for f in findings:
        c = 0.5 * (f["fromDepth"] + f["toDepth"])
        if all(abs(c - cc) >= min_sep for cc in centers):
            out.append(f)
            centers.append(c)
        if len(out) >= max_keep:
            break
    return out


def clip_percentile(x: np.ndarray, p_lo=1, p_hi=99):
    vals = x[np.isfinite(x)]
    if len(vals) < 20:
        return x, 0, len(x)
    lo, hi = np.percentile(vals, [p_lo, p_hi])
    clipped = np.clip(x, lo, hi)
    changed = int(np.sum(np.isfinite(x) & (np.abs(clipped - x) > EPS)))
    return clipped, changed, len(x)


def _safe_corr(a: np.ndarray, b: np.ndarray) -> float:
    mask = np.isfinite(a) & np.isfinite(b)
    if np.sum(mask) < 5:
        return 0.0
    aa = a[mask]
    bb = b[mask]
    if np.nanstd(aa) < EPS or np.nanstd(bb) < EPS:
        return 0.0
    c = np.corrcoef(aa, bb)[0, 1]
    if not np.isfinite(c):
        return 0.0
    return float(c)


def _slope(depths: np.ndarray, values: np.ndarray) -> float:
    mask = np.isfinite(depths) & np.isfinite(values)
    if np.sum(mask) < 5:
        return 0.0
    x = depths[mask]
    y = values[mask]
    x0 = x - np.mean(x)
    denom = np.sum(x0 * x0)
    if denom < EPS:
        return 0.0
    m = np.sum(x0 * (y - np.mean(y))) / denom
    return float(m)


def _band(value: float, t1: float, t2: float, t3: float):
    if value >= t3:
        return "CRITICAL"
    if value >= t2:
        return "HIGH"
    if value >= t1:
        return "MODERATE"
    return "LOW"


def probability_bucket(score: float, conf: float) -> str:
    # Slightly conservative calibration
    s = safe_float(score)
    c = safe_float(conf)
    if c >= 0.80 and s >= 8.5:
        return "High"
    if c >= 0.64 and s >= 5.5:
        return "Medium"
    return "Low"


def compute_data_quality(data: dict, depths: np.ndarray, clipped_points_total: int, raw_points_total: int):
    if not data:
        return {
            "nullFraction": 1.0,
            "nullPercent": 100.0,
            "effectiveRows": 0,
            "depthResolutionMedian": None,
            "clippedFraction": 0.0,
            "clippedPercent": 0.0,
            "qualityBand": "LOW",
            "warnings": ["No curve data available."],
        }

    valid_rates = []
    for _, arr in data.items():
        if len(arr) == 0:
            valid_rates.append(0.0)
        else:
            valid_rates.append(float(np.mean(np.isfinite(arr))))
    mean_valid = float(np.mean(valid_rates)) if valid_rates else 0.0
    null_frac = float(np.clip(1.0 - mean_valid, 0.0, 1.0))

    stacked = np.stack([np.isfinite(v).astype(np.int8) for v in data.values()], axis=0)
    effective_rows = int(np.sum(np.any(stacked > 0, axis=0)))

    dd = np.diff(depths)
    dd = dd[np.isfinite(dd) & (dd > 0)]
    depth_res = float(np.median(dd)) if len(dd) else None

    clipped_frac = 0.0
    if raw_points_total > 0:
        clipped_frac = float(np.clip(clipped_points_total / raw_points_total, 0.0, 1.0))

    quality_score = (
        0.45 * (1.0 - null_frac)
        + 0.30 * (1.0 - clipped_frac)
        + 0.25 * float(np.clip(effective_rows / 2000.0, 0.0, 1.0))
    )

    if quality_score >= 0.72:
        q_band = "HIGH"
    elif quality_score >= 0.48:
        q_band = "MEDIUM"
    else:
        q_band = "LOW"

    warnings = []
    if null_frac > 0.35:
        warnings.append("High missing-value rate may reduce reliability.")
    if clipped_frac > 0.20:
        warnings.append("Significant outlier clipping detected; review sensor quality.")
    if effective_rows < 200:
        warnings.append("Low effective row count; consider wider depth interval.")
    if depth_res is not None and depth_res > 3.0:
        warnings.append("Coarse depth sampling may miss narrow events.")
    if mean_valid < 0.55:
        warnings.append("Many curve samples are sparse; cross-curve agreement may be unstable.")

    return {
        "nullFraction": round(null_frac, 4),
        "nullPercent": round(null_frac * 100.0, 2),
        "effectiveRows": effective_rows,
        "depthResolutionMedian": round(depth_res, 4) if depth_res is not None else None,
        "clippedFraction": round(clipped_frac, 4),
        "clippedPercent": round(clipped_frac * 100.0, 2),
        "qualityBand": q_band,
        "warnings": warnings,
    }


def annotate_interval_stability(findings: list, all_findings: list, center_tolerance: float = 10.0):
    if not findings:
        return findings

    all_centers = []
    for f in all_findings:
        c = 0.5 * (safe_float(f.get("fromDepth")) + safe_float(f.get("toDepth")))
        all_centers.append(c)

    for f in findings:
        c = 0.5 * (safe_float(f.get("fromDepth")) + safe_float(f.get("toDepth")))
        width = max(0.0, safe_float(f.get("toDepth")) - safe_float(f.get("fromDepth")))
        agreement = safe_float(f.get("agreement"), 0.0)
        curve_support = safe_float(f.get("curvesSupporting"), 1.0)

        neighbors = 0
        for ac in all_centers:
            if abs(c - ac) <= center_tolerance:
                neighbors += 1

        # composite stability score [0,1]
        st_score = (
            0.35 * min(1.0, neighbors / 4.0)
            + 0.30 * min(1.0, width / 18.0)
            + 0.25 * min(1.0, agreement)
            + 0.10 * min(1.0, curve_support / 2.0)
        )
        st_score = float(np.clip(st_score, 0.0, 1.0))

        if st_score >= 0.75:
            stability = "stable"
        elif st_score >= 0.52:
            stability = "moderate"
        else:
            stability = "unstable"

        f["stability"] = stability
        f["stabilityScore"] = round(st_score, 3)

    return findings


# -----------------------------
# Insight construction
# -----------------------------
def build_insight(
    well_id: str,
    from_depth: float,
    to_depth: float,
    curves: List[str],
    depths: np.ndarray,
    data: Dict[str, np.ndarray],
    findings: List[dict],
    anomaly_score: float,
    detection_conf: float,
    severity_conf: float,
    severity_band: str,
):
    c1 = curves[0] if len(curves) > 0 else None
    c2 = curves[1] if len(curves) > 1 else None

    arr1 = data.get(c1, np.array([])) if c1 else np.array([])
    arr2 = data.get(c2, np.array([])) if c2 else np.array([])

    mean1 = float(np.nanmean(arr1)) if arr1.size else np.nan
    mean2 = float(np.nanmean(arr2)) if arr2.size else np.nan
    slope1 = _slope(depths, arr1) if arr1.size else 0.0
    slope2 = _slope(depths, arr2) if arr2.size else 0.0
    corr12 = _safe_corr(arr1, arr2) if arr1.size and arr2.size else 0.0

    bh = None
    if np.isfinite(mean1) and np.isfinite(mean2):
        bh = float((mean1 + EPS) / (mean2 + EPS))

    wh = float(np.clip(0.45 * anomaly_score + 0.35 * (max(corr12, 0.0)) + 0.20 * severity_conf, 0.0, 1.0))
    ch = float(np.clip(abs(slope2) / (abs(slope1) + EPS), 0.0, 5.0)) if (arr1.size and arr2.size) else None

    def wh_text(v):
        if v >= 0.75:
            return "high likelihood of hydrocarbon-related activity"
        if v >= 0.50:
            return "moderate hydrocarbon indication"
        return "low-to-moderate hydrocarbon indication"

    def bh_text(v):
        if v is None or not np.isfinite(v):
            return "insufficient curve pair for balance ratio"
        if 0.8 <= v <= 1.25:
            return "balanced response between selected curves"
        if v > 1.25:
            return "first selected curve dominates"
        return "second selected curve dominates"

    def ch_text(v):
        if v is None or not np.isfinite(v):
            return "insufficient data for character ratio"
        if v >= 1.25:
            return "deeper interval trend strength is relatively higher in curve-2"
        if v >= 0.75:
            return "both selected curves show comparable trend strength"
        return "curve-1 trend dominates"

    fluid = "Uncertain"
    fluid_conf = float(np.clip(0.45 * severity_conf + 0.30 * max(corr12, 0.0) + 0.25 * anomaly_score, 0.0, 1.0))
    if fluid_conf >= 0.72 and corr12 >= 0.5:
        fluid = "Oil-prone (inferred)"
    elif fluid_conf >= 0.58:
        fluid = "Mixed hydrocarbon signal"
    elif anomaly_score >= 0.22:
        fluid = "Gas-show possible"
    else:
        fluid = "Weak fluid indication"

    evidence = []
    if c1:
        evidence.append(f"{c1} mean={mean1:.3f}" if np.isfinite(mean1) else f"{c1} has sparse values")
    if c2:
        evidence.append(f"{c2} mean={mean2:.3f}" if np.isfinite(mean2) else f"{c2} has sparse values")
        evidence.append(f"{c1}-{c2} correlation r={corr12:.3f}")
    evidence.append(f"Anomaly score={anomaly_score:.3f}, severity confidence={severity_conf:.3f}")

    shows = []
    for f in findings[:6]:
        p = f.get("probability", probability_bucket(f.get("score", 0.0), f.get("confidence", 0.0)))
        reason = f"{f.get('reason','anomaly')} | score={f.get('score','-')} | priority={f.get('priority','watch')}"
        shows.append(
            {
                "fromDepth": f["fromDepth"],
                "toDepth": f["toDepth"],
                "probability": p,
                "reason": reason,
                "stability": f.get("stability", "unknown"),
            }
        )

    seal_risk = "Low" if anomaly_score < 0.25 else ("Medium" if anomaly_score < 0.5 else "High")
    sat_risk = "Low" if severity_conf < 0.45 else ("Medium" if severity_conf < 0.75 else "High")
    risk_summary = (
        f"Global risk is {severity_band}. Seal risk {seal_risk.lower()}, saturation risk {sat_risk.lower()} "
        f"for selected interval."
    )

    zones = []
    z_edges = np.linspace(from_depth, to_depth, 5)
    for i in range(4):
        z0 = float(z_edges[i])
        z1 = float(z_edges[i + 1])
        mask = (depths >= z0) & (depths <= z1)

        local_vals = []
        for c in curves[:2]:
            arr = data.get(c)
            if arr is not None and arr.size == depths.size:
                local_vals.append(float(np.nanmean(arr[mask])) if np.any(mask) else np.nan)

        local_anom = 0.0
        if np.any(mask):
            overlaps = 0
            for f in findings:
                if not (f["toDepth"] < z0 or f["fromDepth"] > z1):
                    overlaps += 1
            local_anom = overlaps / max(1, len(findings))

        if local_anom >= 0.6:
            label = "High activity zone"
        elif local_anom >= 0.3:
            label = "Transitional zone"
        else:
            label = "Relatively stable zone"

        notes = []
        if c1 and len(local_vals) > 0 and np.isfinite(local_vals[0]):
            notes.append(f"{c1} avg={local_vals[0]:.3f}")
        if len(local_vals) > 1 and np.isfinite(local_vals[1]):
            notes.append(f"{c2} avg={local_vals[1]:.3f}")
        if not notes:
            notes = ["insufficient local signal"]

        zones.append(
            {
                "name": f"Zone {i + 1}",
                "fromDepth": round(z0, 3),
                "toDepth": round(z1, 3),
                "label": label,
                "notes": ", ".join(notes),
            }
        )

    summary_para = (
        f"For well {well_id}, interval {from_depth:.3f}–{to_depth:.3f} was analyzed across "
        f"{len(curves)} selected curve(s). Global risk is {severity_band}, with {len(findings)} key event(s) "
        f"and detection confidence {detection_conf:.3f}. Signals suggest {fluid.lower()}."
    )

    return {
        "well": well_id,
        "fromDepth": round(float(from_depth), 3),
        "toDepth": round(float(to_depth), 3),
        "analyzedCurves": curves,
        "indices": {
            "wetnessIndexWh": round(wh, 3),
            "balanceRatioBh": (round(float(bh), 3) if bh is not None and np.isfinite(bh) else None),
            "characterRatioCh": (round(float(ch), 3) if ch is not None and np.isfinite(ch) else None),
            "wetnessText": wh_text(wh),
            "balanceText": bh_text(bh),
            "characterText": ch_text(ch),
        },
        "primaryFluid": {
            "label": fluid,
            "confidence": round(float(fluid_conf), 3),
            "evidence": evidence[:5],
        },
        "shows": shows,
        "riskProfile": {
            "sealIntegrity": seal_risk,
            "saturationRisk": sat_risk,
            "summary": risk_summary,
        },
        "zones": zones,
        "summaryParagraph": summary_para,
    }


# -----------------------------
# Core analysis
# -----------------------------
def analyze(rows: List[Row], curves: List[str], from_depth: float, to_depth: float, well_id: str):
    depths_raw = np.array([r.depth for r in rows], dtype=float)
    ord_idx = np.argsort(depths_raw)
    depths = depths_raw[ord_idx]

    # remove duplicate/non-increasing depths
    uniq = np.ones(len(depths), dtype=bool)
    uniq[1:] = depths[1:] > depths[:-1]
    depths = depths[uniq]

    n = len(depths)
    range_width = max(float(to_depth - from_depth), 1e-9)

    # per-curve arrays
    data: Dict[str, np.ndarray] = {}
    for c in curves:
        vals = np.array([rows[i].values.get(c, np.nan) for i in ord_idx], dtype=float)
        vals = vals[uniq]
        data[c] = vals

    if n < 20:
        anomaly_score = 0.0
        detection_conf = 0.25
        severity_conf = 0.20
        severity_band = _band(anomaly_score, 0.25, 0.50, 0.75)
        findings: List[dict] = []
        # Consistency guard: prevent extreme global risk when no localized events survive
        if len(findings) == 0:
            anomaly_score = min(anomaly_score, 0.49)   # caps at MODERATE
            severity_conf = min(severity_conf, 0.55)

        event_count = 0
        event_density = 0.0

        dq = compute_data_quality(
            data=data,
            depths=depths,
            clipped_points_total=0,
            raw_points_total=max(1, n * max(1, len(curves))),
        )

        summary = [
            "Too few rows for robust interpretation.",
            f"Global risk is {severity_band}; anomalies are localized within selected interval(s).",
            f"Data quality is {dq['qualityBand']} (null={dq['nullPercent']}%, clipped={dq['clippedPercent']}%, effectiveRows={dq['effectiveRows']}).",
        ]
        recommendations = ["Increase selected depth range."]
        limitations = [
            "Too few rows for robust interpretation.",
            "Use a wider depth window.",
        ] + (dq.get("warnings") or [])

        deterministic = {
            "modelVersion": "det-v4",
            "eventCount": event_count,
            "eventDensityPer1000ft": round(event_density, 3),
            "anomalyScore": round(anomaly_score, 3),
            "confidence": round(detection_conf, 3),
            "detectionConfidence": round(detection_conf, 3),
            "severityConfidence": round(severity_conf, 3),
            "severityBand": severity_band,
            "dataQuality": dq,
            "thresholds": {
                "anomalyScore": {
                    "low_to_moderate": 0.25,
                    "moderate_to_high": 0.50,
                    "high_to_critical": 0.75,
                },
                "intervalScore": {
                    "watch_to_elevated": 3.0,
                    "elevated_to_strong": 5.0,
                },
                "probabilityBuckets": {
                    "high": "confidence>=0.80 AND score>=8.5",
                    "medium": "confidence>=0.64 AND score>=5.5",
                    "low": "otherwise",
                },
            },
            "summary": summary,
            "intervalFindings": findings,
            "recommendations": recommendations,
            "limitations": limitations,
        }

        insight = build_insight(
            well_id=well_id,
            from_depth=from_depth,
            to_depth=to_depth,
            curves=curves,
            depths=depths,
            data=data,
            findings=findings,
            anomaly_score=anomaly_score,
            detection_conf=detection_conf,
            severity_conf=severity_conf,
            severity_band=severity_band,
        )

        return deterministic, insight

    dd = np.diff(depths)
    dd = dd[np.isfinite(dd) & (dd > 0)]
    step = float(np.median(dd)) if len(dd) else 1.0

    smooth_win = int(max(9, min(121, round(18 / max(step, 1e-6)))))
    min_run = int(max(4, round(6 / max(step, 1e-6))))
    gap_merge = int(max(2, round(4 / max(step, 1e-6))))

    per_curve_scores = []
    raw_intervals = []
    curve_masks = {}

    clipped_points_total = 0
    raw_points_total = 0

    # Detect anomalies per curve
    for c in curves:
        x = data[c].copy()
        finite = np.isfinite(x)
        finite_ratio = float(np.mean(finite))
        raw_points_total += len(x)

        if finite_ratio < 0.30:
            # too sparse to trust
            continue

        x, changed_pts, total_pts = clip_percentile(x, 1, 99)
        clipped_points_total += changed_pts

        smooth = rolling_mean(x, smooth_win)
        resid = x - smooth

        z_level = np.abs(robust_z(resid))
        dx = np.gradient(np.nan_to_num(x, nan=np.nanmedian(x)), depths)
        z_slope = np.abs(robust_z(dx))

        score = 0.62 * z_level + 0.38 * z_slope
        score = np.where(np.isfinite(score), score, 0.0)

        # robust threshold
        thr = max(2.6, float(np.nanpercentile(score, 92)))
        mask = score >= thr
        curve_masks[c] = mask

        runs = [(i, j) for (i, j) in contiguous_runs(mask) if (j - i + 1) >= min_run]

        for (i, j) in runs:
            seg_score = float(np.nanmean(score[i:j + 1]))
            itype = classify_interval(x, depths, i, j)
            raw_intervals.append({
                "i": i,
                "j": j,
                "score": seg_score,
                "curves": [c],
                "type": itype,
            })

        # normalized per-curve anomaly intensity
        pc = float(np.clip(np.nanpercentile(score, 95) / 7.0, 0.0, 1.0))
        per_curve_scores.append(pc)

    # Cross-curve agreement
    agreement_mask = np.zeros(n, dtype=float)
    if len(curve_masks) >= 2:
        stack = np.stack([curve_masks[c].astype(float) for c in curve_masks], axis=0)
        agreement_mask = np.sum(stack, axis=0) / stack.shape[0]

    # Merge + findings
    merged = merge_intervals(raw_intervals, max_gap_idx=gap_merge)

    findings = []
    for it in merged:
        i, j = it["i"], it["j"]
        avg_agree = float(np.mean(agreement_mask[i:j + 1])) if len(agreement_mask) else 0.0
        boosted = it["score"] * (1.0 + 0.35 * avg_agree)

        int_conf = np.clip(
            0.35 + 0.10 * np.log1p(max(boosted, 0.0)) + 0.18 * avg_agree,
            0.35, 0.95
        )

        curve_tag = ",".join(sorted(it["curves"]))
        width = float(depths[j] - depths[i])

        findings.append({
            "curve": curve_tag,
            "fromDepth": float(depths[i]),
            "toDepth": float(depths[j]),
            "confidence": round(float(int_conf), 3),
            "score": round(float(boosted), 3),
            "reason": it["type"],
            "curvesSupporting": len([x for x in curve_tag.split(",") if x.strip()]),
            "width": round(width, 3),
            "agreement": round(float(avg_agree), 3),
        })

    findings = sorted(findings, key=lambda x: x["score"], reverse=True)
    all_ranked_findings = [dict(f) for f in findings]

    findings = nms_intervals(findings, iou_thr=0.55)
    findings = enforce_zone_separation(findings, min_sep=22.0, max_keep=6)
    findings = annotate_interval_stability(findings, all_ranked_findings, center_tolerance=10.0)

    # Priority + probability labels (always present)
    for f in findings:
        sc = float(f.get("score", 0.0))
        if sc > 5.0:
            f["priority"] = "strong"
        elif sc >= 3.0:
            f["priority"] = "elevated"
        else:
            f["priority"] = "watch"

        f["probability"] = probability_bucket(f.get("score", 0.0), f.get("confidence", 0.0))
    

    # Global metrics
    base_score = float(np.mean(per_curve_scores)) if per_curve_scores else 0.0
    agree_global = float(np.mean(agreement_mask)) if len(agreement_mask) else 0.0
    anomaly_score = float(np.clip(0.78 * base_score + 0.22 * agree_global, 0.0, 1.0))
    # Consistency guard: prevent extreme global risk when no localized events survive
    


    data_quality_scalar = float(np.mean([np.mean(np.isfinite(data[c])) for c in data])) if data else 0.0
    interval_stability_scalar = float(np.mean([
        min(1.0, safe_float(f["toDepth"] - f["fromDepth"], 0.0) / 20.0) for f in findings
    ])) if findings else 0.2
    strength = float(np.mean([min(1.0, safe_float(f["score"], 0.0) / 6.0) for f in findings])) if findings else 0.2

    detection_conf = float(np.clip(
        0.40 * data_quality_scalar + 0.30 * interval_stability_scalar + 0.30 * agree_global,
        0.25, 0.95
    ))

    severity_conf = float(np.clip(
        0.55 * anomaly_score + 0.45 * strength,
        0.20, 0.92
    ))

    confidence = detection_conf
    severity_band = _band(anomaly_score, 0.25, 0.50, 0.75)

    event_count = len(findings)
    event_density = event_count / (range_width / 1000.0)

    dq = compute_data_quality(
        data=data,
        depths=depths,
        clipped_points_total=clipped_points_total,
        raw_points_total=max(1, raw_points_total),
    )
    if len(findings) == 0:
        anomaly_score = min(anomaly_score, 0.49)   # caps at MODERATE
        severity_conf = min(severity_conf, 0.55)

    type_counts = {}
    for f in findings:
        type_counts[f["reason"]] = type_counts.get(f["reason"], 0) + 1
    type_str = ", ".join([f"{k}:{v}" for k, v in sorted(type_counts.items())]) if type_counts else "none"

    summary = [
        f"Processed {n} rows across {len(curves)} curve(s).",
        f"Detected {len(findings)} consolidated anomalous interval(s).",
        f"Anomaly score {anomaly_score:.3f}, detection confidence {detection_conf:.3f}, severity confidence {severity_conf:.3f}.",
        f"Interval types -> {type_str}.",
        f"Global risk is {severity_band}; anomalies are localized within selected interval(s).",
        "Global risk reflects aggregate behavior over the selected window; interval priority ranks local anomalies only.",
        f"Data quality is {dq['qualityBand']} (null={dq['nullPercent']}%, clipped={dq['clippedPercent']}%, effectiveRows={dq['effectiveRows']}).",
    ]

    recommendations = [
        "Validate top intervals against neighboring depth windows.",
        "Prioritize intervals with higher cross-curve agreement.",
        "For noisy/spike zones, inspect sensor quality and smoothing sensitivity.",
        "Treat probability as model-based screening confidence, not final fluid confirmation.",
    ]

    limitations = [
        "Model version: det-v4",
        f"Event count: {event_count}",
        "Confidence and severity scores are model-based and require domain validation.",
    ] + (dq.get("warnings") or [])

    deterministic = {
        "modelVersion": "det-v4",
        "eventCount": event_count,
        "eventDensityPer1000ft": round(event_density, 3),
        "anomalyScore": round(anomaly_score, 3),
        "confidence": round(confidence, 3),  # backward compatibility
        "detectionConfidence": round(detection_conf, 3),
        "severityConfidence": round(severity_conf, 3),
        "severityBand": severity_band,
        "dataQuality": dq,
        "thresholds": {
            "anomalyScore": {
                "low_to_moderate": 0.25,
                "moderate_to_high": 0.50,
                "high_to_critical": 0.75,
            },
            "intervalScore": {
                "watch_to_elevated": 3.0,
                "elevated_to_strong": 5.0
            },
            "probabilityBuckets": {
                "high": "confidence>=0.80 AND score>=8.5",
                "medium": "confidence>=0.64 AND score>=5.5",
                "low": "otherwise",
            }
        },
        "summary": summary,
        "intervalFindings": findings,
        "recommendations": recommendations,
        "limitations": limitations,
    }

    insight = build_insight(
        well_id=well_id,
        from_depth=from_depth,
        to_depth=to_depth,
        curves=curves,
        depths=depths,
        data=data,
        findings=findings,
        anomaly_score=anomaly_score,
        detection_conf=detection_conf,
        severity_conf=severity_conf,
        severity_band=severity_band,
    )

    return deterministic, insight


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/interpret")
def interpret(req: InterpretRequest):
    lo = min(req.fromDepth, req.toDepth)
    hi = max(req.fromDepth, req.toDepth)

    deterministic, insight = analyze(
        rows=req.rows,
        curves=req.curves,
        from_depth=lo,
        to_depth=hi,
        well_id=req.wellId,
    )

    return {
        "ok": True,
        "deterministic": deterministic,
        "insight": insight,
    }

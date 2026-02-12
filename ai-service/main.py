from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Dict, List, Optional
import numpy as np

app = FastAPI()


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


EPS = 1e-9


# -----------------------------
# Math helpers
# -----------------------------
def robust_z(x: np.ndarray) -> np.ndarray:
    """Median/MAD robust z-score with std fallback."""
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
    """NaN-aware moving average via convolution."""
    w = max(3, int(w))
    if len(x) < w:
        return np.full_like(x, np.nan, dtype=float)

    kernel = np.ones(w, dtype=float) / w
    z = np.nan_to_num(x, nan=0.0)

    y = np.convolve(z, kernel, mode="same")
    valid = np.convolve(np.isfinite(x).astype(float), np.ones(w), mode="same")

    # Renormalize near NaN regions
    y = np.where(valid > 0, y * (w / np.maximum(valid, 1.0)), np.nan)
    return y


def contiguous_runs(mask: np.ndarray):
    """Return list of (start_idx, end_idx) inclusive where mask is True."""
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
    """Heuristic type for interval."""
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

    # short, sharp
    if span < 12 and peakiness / stdev > 2.0:
        return "spike"

    # smooth monotone-like changes
    if curvature < 0.12 * (slope_strength + EPS) and slope_strength > 0.0:
        return "drift"

    # level shift (first half vs second half)
    mid = len(seg_f) // 2
    if mid > 1:
        m1 = float(np.nanmean(seg_f[:mid]))
        m2 = float(np.nanmean(seg_f[mid:]))
        if abs(m2 - m1) / stdev > 0.8:
            return "step_change"

    return "noisy_zone"


def merge_intervals(raw_intervals, max_gap_idx: int):
    """
    Merge nearby intervals of same type.
    raw item: {"i","j","score","curves":[...],"type"}
    """
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
    """Depth-interval NMS (findings sorted by score desc)."""
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
    """Keep top intervals but ensure distinct depth zones."""
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
        return x
    lo, hi = np.percentile(vals, [p_lo, p_hi])
    return np.clip(x, lo, hi)


# -----------------------------
# Core analysis
# -----------------------------
def analyze(rows: List[Row], curves: List[str], from_depth: float, to_depth: float):
    # Ensure positive width regardless of order
    lo = float(min(from_depth, to_depth))
    hi = float(max(from_depth, to_depth))
    range_width = max(hi - lo, 1e-9)

    # Sort + unique depth
    depths = np.array([r.depth for r in rows], dtype=float)
    ord_idx = np.argsort(depths)
    depths = depths[ord_idx]

    uniq = np.ones(len(depths), dtype=bool)
    uniq[1:] = depths[1:] > depths[:-1]
    depths = depths[uniq]

    n = len(depths)

    if n < 20:
        event_count = 0
        event_density = 0.0
        return {
            "modelVersion": "det-v3",
            "eventCount": event_count,
            "eventDensityPer1000ft": round(event_density, 3),
            "anomalyScore": 0.0,
            "confidence": 0.25,
            "detectionConfidence": 0.25,
            "severityConfidence": 0.20,
            "severityBand": "low",
            "thresholds": {
                "anomalyScore": {
                    "low_to_moderate": 0.25,
                    "moderate_to_high": 0.50,
                    "high_to_critical": 0.75
                },
                "intervalScore": {
                    "watch_to_elevated": 3.0,
                    "elevated_to_strong": 5.0
                }
            },
            "summary": ["Too few rows for robust interpretation."],
            "intervalFindings": [],
            "recommendations": ["Increase selected depth range."],
        }

    # Build per-curve arrays
    data = {}
    for c in curves:
        vals = np.array([rows[i].values.get(c, np.nan) for i in ord_idx], dtype=float)
        vals = vals[uniq]
        data[c] = vals

    # Depth resolution
    dd = np.diff(depths)
    dd = dd[np.isfinite(dd) & (dd > 0)]
    step = float(np.median(dd)) if len(dd) else 1.0

    smooth_win = int(max(9, min(121, round(18 / max(step, 1e-6)))))   # ~18 depth units
    min_run = int(max(4, round(6 / max(step, 1e-6))))                  # ~6 depth units
    gap_merge = int(max(2, round(4 / max(step, 1e-6))))                # merge nearby ~4 units

    per_curve_scores = []
    raw_intervals = []
    curve_masks = {}

    # Detect anomalies per curve
    for c in curves:
        x = data[c].copy()
        finite = np.isfinite(x)
        finite_ratio = float(np.mean(finite))
        if finite_ratio < 0.30:
            continue

        x = clip_percentile(x, 1, 99)
        smooth = rolling_mean(x, smooth_win)
        resid = x - smooth

        z_level = np.abs(robust_z(resid))
        dx = np.gradient(np.nan_to_num(x, nan=np.nanmedian(x)), depths)
        z_slope = np.abs(robust_z(dx))

        # composite score
        score = 0.62 * z_level + 0.38 * z_slope
        score = np.where(np.isfinite(score), score, 0.0)

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

        # per-curve severity proxy
        pc = float(np.clip(np.nanpercentile(score, 95) / 7.0, 0.0, 1.0))
        per_curve_scores.append(pc)

    # Cross-curve agreement mask
    agreement_mask = np.zeros(n, dtype=float)
    if len(curve_masks) >= 2:
        stack = np.stack([curve_masks[c].astype(float) for c in curve_masks], axis=0)
        agreement_mask = np.sum(stack, axis=0) / stack.shape[0]  # 0..1

    # Merge + build findings
    merged = merge_intervals(raw_intervals, max_gap_idx=gap_merge)

    findings = []
    for it in merged:
        i, j = it["i"], it["j"]
        avg_agree = float(np.mean(agreement_mask[i:j + 1])) if len(agreement_mask) else 0.0
        boosted = it["score"] * (1.0 + 0.35 * avg_agree)

        # per-interval confidence (detection reliability)
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

    # Rank and de-duplicate
    findings = sorted(findings, key=lambda x: x["score"], reverse=True)
    findings = nms_intervals(findings, iou_thr=0.55)
    findings = enforce_zone_separation(findings, min_sep=22.0, max_keep=6)

    # Add priority labels per interval (relative to current window distribution)
    scores = [float(f.get("score", 0.0)) for f in findings]
    p60 = float(np.percentile(scores, 60)) if scores else 0.0
    p85 = float(np.percentile(scores, 85)) if scores else 0.0

    for f in findings:
        sc = float(f.get("score", 0.0))
        if sc >= p85:
            f["priority"] = "strong"
        elif sc >= p60:
            f["priority"] = "elevated"
        else:
            f["priority"] = "watch"

        

    # Event stats (NOW findings exists)
    event_count = len(findings)
    event_density = event_count / (range_width / 1000.0)

    # Global scores
    base_score = float(np.mean(per_curve_scores)) if per_curve_scores else 0.0
    agree_global = float(np.mean(agreement_mask)) if len(agreement_mask) else 0.0
    anomaly_score = float(np.clip(0.78 * base_score + 0.22 * agree_global, 0.0, 1.0))

    data_quality = float(np.mean([np.mean(np.isfinite(data[c])) for c in data])) if data else 0.0
    interval_stability = float(np.mean([
        min(1.0, (f["toDepth"] - f["fromDepth"]) / 20.0) for f in findings
    ])) if findings else 0.2
    strength = float(np.mean([min(1.0, f["score"] / 6.0) for f in findings])) if findings else 0.2

    # Split confidence semantics
    detection_conf = float(np.clip(
        0.40 * data_quality + 0.30 * interval_stability + 0.30 * agree_global,
        0.25, 0.95
    ))

    severity_conf = float(np.clip(
        0.55 * anomaly_score + 0.45 * strength,
        0.20, 0.92
    ))

    # Backward-compatible confidence
    confidence = detection_conf



    def severity_band(s: float) -> str:
        if s >= 0.75:
            return "critical"
        if s >= 0.50:
            return "high"
        if s >= 0.25:
            return "moderate"
        return "low"

    global_band = severity_band(anomaly_score)

    # Interval type summary
    type_counts = {}
    for f in findings:
        type_counts[f["reason"]] = type_counts.get(f["reason"], 0) + 1
    if type_counts:
        type_str = ", ".join([f"{k}:{v}" for k, v in sorted(type_counts.items())])
    else:
        type_str = "none"

    summary = [
    f"Processed {n} rows across {len(curves)} curve(s).",
    f"Detected {len(findings)} consolidated anomalous interval(s).",
    f"Anomaly score {anomaly_score:.3f}, detection confidence {detection_conf:.3f}, severity confidence {severity_conf:.3f}.",
    f"Interval types -> {type_str}.",
    f"Global risk is {global_band.upper()}; anomalies are localized within selected interval(s).",
    "Global risk reflects aggregate behavior over the selected window; interval priority ranks local anomalies only.",
]


    recommendations = [
        "Validate top intervals against neighboring depth windows.",
        "Prioritize intervals with higher cross-curve agreement.",
        "For noisy/spike zones, inspect sensor quality and smoothing sensitivity.",
    ]

    

    return {
        "modelVersion": "det-v3",
        "eventCount": event_count,
        "eventDensityPer1000ft": round(event_density, 3),
        "anomalyScore": round(anomaly_score, 3),
        "confidence": round(confidence, 3),  # backward compatibility
        "detectionConfidence": round(detection_conf, 3),
        "severityConfidence": round(severity_conf, 3),
        "severityBand": global_band,
        "thresholds": {
            "anomalyScore": {
                "low_to_moderate": 0.25,
                "moderate_to_high": 0.50,
                "high_to_critical": 0.75
            },
            "intervalScore": {
                "watch_to_elevated": 3.0,
                "elevated_to_strong": 5.0
            }
        },
        "summary": summary,
        "intervalFindings": findings,
        "recommendations": recommendations,
    }


@app.post("/interpret")
def interpret(req: InterpretRequest):
    lo = min(req.fromDepth, req.toDepth)
    hi = max(req.fromDepth, req.toDepth)
    return analyze(req.rows, req.curves, lo, hi)

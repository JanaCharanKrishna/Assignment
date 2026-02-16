from typing import List, Tuple

import numpy as np

EPS = 1e-9


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

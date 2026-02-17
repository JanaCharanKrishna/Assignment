from __future__ import annotations

from typing import Dict, Iterable, List, Tuple

import numpy as np

from app.analysis_utils import EPS


def _to_float(value, default=np.nan) -> float:
    try:
        out = float(value)
        return out if np.isfinite(out) else default
    except Exception:
        return default


def _fmt(value, digits: int = 3) -> str:
    if value is None:
        return "n/a"
    v = _to_float(value)
    if not np.isfinite(v):
        return "n/a"
    return f"{v:.{digits}f}"


def _curve_tag(curve_name: str) -> str:
    raw = str(curve_name or "").upper().strip()
    base = raw.split("__", 1)[0]
    cleaned = "".join(ch for ch in base if ch.isalnum())
    return cleaned


def _trend_label(values: np.ndarray) -> str:
    n = int(values.size)
    if n < 6:
        return "insufficient"
    window = max(3, n // 5)
    head = float(np.mean(values[:window]))
    tail = float(np.mean(values[-window:]))
    if not np.isfinite(head) or not np.isfinite(tail):
        return "insufficient"
    scale = max(abs(head), abs(tail), 1e-9)
    rel = (tail - head) / scale
    if rel >= 0.08:
        return "increasing"
    if rel <= -0.08:
        return "decreasing"
    return "stable"


def _curve_interpretation(curve_name: str, stats: dict) -> str:
    tag = _curve_tag(curve_name)
    mean_val = _to_float(stats.get("mean"))
    p90 = _to_float(stats.get("p90"))
    trend = str(stats.get("trend") or "stable")

    if tag.startswith("GR") or tag.startswith("GAMMA"):
        if np.isfinite(mean_val) and mean_val >= 100:
            return "Gamma-ray response is high and may indicate shale-prone lithology."
        if np.isfinite(mean_val) and mean_val <= 50:
            return "Gamma-ray response is low and may indicate cleaner sand/carbonate intervals."
        return "Gamma-ray response is moderate, suggesting mixed lithology."

    if tag.startswith("RHOB") or tag.startswith("DEN"):
        if np.isfinite(mean_val) and mean_val < 2.0:
            return "Density is low and may indicate elevated porosity or gas effect."
        if np.isfinite(mean_val) and mean_val > 2.6:
            return "Density is high and may indicate tight or mineral-dense rock."
        return "Density stays within a typical reservoir-range envelope."

    if tag.startswith("NPHI") or tag.startswith("PHIT") or tag.startswith("PHI"):
        if np.isfinite(mean_val) and mean_val > 0.25:
            return "Porosity index is elevated and may support reservoir quality."
        if np.isfinite(mean_val) and mean_val < 0.08:
            return "Porosity index is low, consistent with tighter intervals."
        return "Porosity index is moderate in the selected depth window."

    if (
        tag.startswith("RES")
        or tag.startswith("RT")
        or tag.startswith("ILD")
        or tag.startswith("LLD")
        or tag.startswith("MSFL")
    ):
        if np.isfinite(p90) and p90 >= 20:
            return "Higher-end resistivity values may indicate hydrocarbon charge or tighter zones."
        if np.isfinite(mean_val) and mean_val <= 2:
            return "Lower resistivity suggests more conductive intervals and possible water influence."
        return "Resistivity behavior is intermediate and should be checked with companion curves."

    return (
        f"Trend is {trend}; curve-specific domain interpretation requires metadata "
        "or companion curves for higher confidence."
    )


def _finite_curve_pairs(depths: np.ndarray, values: np.ndarray) -> Tuple[np.ndarray, np.ndarray, int]:
    if depths.size == 0 or values.size == 0:
        return np.array([], dtype=float), np.array([], dtype=float), 0
    n = min(int(depths.size), int(values.size))
    d = depths[:n]
    v = values[:n]
    mask = np.isfinite(d) & np.isfinite(v)
    return d[mask], v[mask], n


def _outlier_count(values: np.ndarray, mean_val: float, std_val: float) -> int:
    if values.size < 3:
        return 0
    if not np.isfinite(std_val) or std_val < EPS:
        return 0
    hi = mean_val + 2.0 * std_val
    lo = mean_val - 2.0 * std_val
    return int(np.sum((values > hi) | (values < lo)))


def compute_curve_statistics(
    depths: np.ndarray,
    data: Dict[str, np.ndarray],
    curves: Iterable[str],
) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    depth_arr = np.asarray(depths, dtype=float)

    for curve in list(curves or []):
        raw = data.get(curve, np.array([], dtype=float))
        val_arr = np.asarray(raw, dtype=float)
        d, v, base_count = _finite_curve_pairs(depth_arr, val_arr)
        count = int(v.size)

        if count == 0:
            out[curve] = {
                "min": None,
                "max": None,
                "mean": None,
                "std": None,
                "count": 0,
                "p10": None,
                "p90": None,
                "trend": "insufficient",
                "outlierCount": 0,
                "outlierPct": 0.0,
                "usableRatio": 0.0,
            }
            continue

        min_val = float(np.min(v))
        max_val = float(np.max(v))
        mean_val = float(np.mean(v))
        std_val = float(np.std(v, ddof=1)) if count > 1 else 0.0
        p10 = float(np.percentile(v, 10))
        p90 = float(np.percentile(v, 90))
        trend = _trend_label(v)
        outlier_count = _outlier_count(v, mean_val, std_val)
        outlier_pct = (100.0 * outlier_count / count) if count else 0.0
        usable_ratio = float(count / max(1, base_count))

        out[curve] = {
            "min": round(min_val, 4),
            "max": round(max_val, 4),
            "mean": round(mean_val, 4),
            "std": round(std_val, 4),
            "count": count,
            "p10": round(p10, 4),
            "p90": round(p90, 4),
            "trend": trend,
            "outlierCount": outlier_count,
            "outlierPct": round(outlier_pct, 2),
            "usableRatio": round(usable_ratio, 4),
        }

    return out


def _top_curves(curve_stats: Dict[str, dict], max_items: int = 4) -> List[str]:
    scored = []
    for curve, stats in (curve_stats or {}).items():
        count = int(stats.get("count") or 0)
        p10 = _to_float(stats.get("p10"))
        p90 = _to_float(stats.get("p90"))
        spread = (p90 - p10) if np.isfinite(p10) and np.isfinite(p90) else -np.inf
        scored.append((curve, count, spread))

    ranked = sorted(scored, key=lambda x: (x[1], x[2]), reverse=True)
    return [curve for curve, _, _ in ranked[: max(0, int(max_items))]]


def build_summary_bullets(
    *,
    from_depth: float,
    to_depth: float,
    row_count: int,
    curves: Iterable[str],
    curve_stats: Dict[str, dict],
    findings: List[dict],
    anomaly_score: float,
    detection_conf: float,
    severity_conf: float,
    severity_band: str,
    data_quality: dict,
    event_density_per_1000ft: float,
    max_curve_bullets: int = 4,
) -> List[str]:
    lo = float(min(from_depth, to_depth))
    hi = float(max(from_depth, to_depth))
    width = max(hi - lo, 0.0)
    curves_list = list(curves or [])
    findings_list = list(findings or [])
    event_count = len(findings_list)

    reasons = {}
    for f in findings_list:
        r = str(f.get("reason") or "anomaly")
        reasons[r] = reasons.get(r, 0) + 1
    reason_text = ", ".join(f"{k}:{v}" for k, v in sorted(reasons.items())) if reasons else "none"

    if findings_list:
        top = findings_list[0]
        top_txt = (
            f"Top interval is {float(top.get('fromDepth', lo)):.1f}-{float(top.get('toDepth', hi)):.1f} ft "
            f"({top.get('curve', '-')}) with score={_fmt(top.get('score'), 2)} and "
            f"confidence={_fmt(top.get('confidence'), 2)}."
        )
    else:
        top_txt = "No localized anomaly interval survived consolidation in the selected range."

    core = [
        (
            f"Analyzed {int(row_count)} rows over {lo:.1f}-{hi:.1f} ft "
            f"({width:.1f} ft) across {len(curves_list)} curve(s)."
        ),
        (
            f"Detected {event_count} consolidated anomalous interval(s) "
            f"(density={_fmt(event_density_per_1000ft, 3)} per 1000 ft; types={reason_text})."
        ),
        (
            f"Global risk is {str(severity_band).upper()} with anomalyScore={_fmt(anomaly_score, 3)}, "
            f"detectionConfidence={_fmt(detection_conf, 3)}, severityConfidence={_fmt(severity_conf, 3)}."
        ),
        top_txt,
    ]

    # Keep room for data-quality + caution lines while targeting 7-8 total bullets.
    capacity = max(0, 8 - (len(core) + 2))
    selected_curves = _top_curves(curve_stats, max_items=min(max_curve_bullets, capacity))
    curve_lines = []
    for curve in selected_curves:
        s = curve_stats.get(curve, {})
        if int(s.get("count") or 0) <= 0:
            continue
        line = (
            f"{curve}: min={_fmt(s.get('min'), 2)}, max={_fmt(s.get('max'), 2)}, "
            f"mean={_fmt(s.get('mean'), 2)}, std={_fmt(s.get('std'), 2)}, "
            f"p10={_fmt(s.get('p10'), 2)}, p90={_fmt(s.get('p90'), 2)}, trend={s.get('trend', 'stable')}, "
            f"outliers={int(s.get('outlierCount') or 0)} ({_fmt(s.get('outlierPct'), 1)}%). "
            f"{_curve_interpretation(curve, s)}"
        )
        curve_lines.append(line)

    dq = data_quality or {}
    dq_line = (
        f"Data quality is {dq.get('qualityBand', '-')}: null={_fmt(dq.get('nullPercent'), 1)}%, "
        f"clipped={_fmt(dq.get('clippedPercent'), 1)}%, effectiveRows={int(dq.get('effectiveRows') or 0)}."
    )
    caution_line = (
        "Interpretation is screening-level and should be validated with offset wells, "
        "additional logs, and domain review before operational decisions."
    )

    out = core + curve_lines + [dq_line, caution_line]
    min_lines = 7
    max_lines = 8
    fallback_fill = [
        "Cross-validate flagged zones with adjacent intervals and companion logs.",
        "Use these results as screening evidence and confirm with domain review before action.",
    ]
    i = 0
    while len(out) < min_lines:
        if i < len(fallback_fill):
            out.append(fallback_fill[i])
            i += 1
        else:
            out.append("Evidence is limited; expand interval or add curves to improve confidence.")
    return out[:max_lines]


def build_summary_paragraph(
    *,
    from_depth: float,
    to_depth: float,
    row_count: int,
    curves: Iterable[str],
    findings: List[dict],
    anomaly_score: float,
    detection_conf: float,
    severity_band: str,
    data_quality: dict,
    curve_stats: Dict[str, dict],
) -> str:
    lo = float(min(from_depth, to_depth))
    hi = float(max(from_depth, to_depth))
    curves_list = list(curves or [])
    findings_list = list(findings or [])

    top_interval = None
    if findings_list:
        top_interval = findings_list[0]

    dominant_curve = None
    for curve in _top_curves(curve_stats, max_items=1):
        st = curve_stats.get(curve, {})
        if int(st.get("count") or 0) > 0:
            dominant_curve = (curve, st)
            break

    s1 = (
        f"Interpretation covered {lo:.1f}-{hi:.1f} ft using {int(row_count)} rows "
        f"across {len(curves_list)} selected curve(s)."
    )
    s2 = (
        f"Global risk is {str(severity_band).upper()} with anomaly score {_fmt(anomaly_score, 3)} "
        f"and detection confidence {_fmt(detection_conf, 3)}."
    )

    if top_interval:
        s3 = (
            f"The strongest localized interval is {float(top_interval.get('fromDepth', lo)):.1f}-"
            f"{float(top_interval.get('toDepth', hi)):.1f} ft on {top_interval.get('curve', '-')}, "
            f"scored {_fmt(top_interval.get('score'), 2)}."
        )
    else:
        s3 = "No consolidated localized interval was retained, so the result is driven by global behavior."

    dq = data_quality or {}
    if dominant_curve:
        c_name, c_stats = dominant_curve
        s4 = (
            f"Dominant curve {c_name} has mean {_fmt(c_stats.get('mean'), 2)} and trend "
            f"{c_stats.get('trend', 'stable')}; data quality is {dq.get('qualityBand', '-')}"
            f" (null {_fmt(dq.get('nullPercent'), 1)}%)."
        )
    else:
        s4 = (
            f"Data quality is {dq.get('qualityBand', '-')}"
            f" (null {_fmt(dq.get('nullPercent'), 1)}%, clipped {_fmt(dq.get('clippedPercent'), 1)}%)."
        )

    return " ".join([s1, s2, s3, s4]).strip()

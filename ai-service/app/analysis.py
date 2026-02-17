from typing import Dict, List

import numpy as np

from app.analysis_summary import (
    build_summary_bullets,
    build_summary_paragraph,
    compute_curve_statistics,
)
from app.analysis_insight import build_insight
from app.analysis_utils import (
    _band,
    annotate_interval_stability,
    classify_interval,
    clip_percentile,
    compute_data_quality,
    contiguous_runs,
    enforce_zone_separation,
    merge_intervals,
    nms_intervals,
    probability_bucket,
    robust_z,
    rolling_mean,
    safe_float,
)
from app.schemas import Row


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
        curve_stats = compute_curve_statistics(depths=depths, data=data, curves=curves)
        summary = build_summary_bullets(
            from_depth=from_depth,
            to_depth=to_depth,
            row_count=n,
            curves=curves,
            curve_stats=curve_stats,
            findings=findings,
            anomaly_score=anomaly_score,
            detection_conf=detection_conf,
            severity_conf=severity_conf,
            severity_band=severity_band,
            data_quality=dq,
            event_density_per_1000ft=event_density,
            max_curve_bullets=4,
        )
        summary_paragraph = build_summary_paragraph(
            from_depth=from_depth,
            to_depth=to_depth,
            row_count=n,
            curves=curves,
            findings=findings,
            anomaly_score=anomaly_score,
            detection_conf=detection_conf,
            severity_band=severity_band,
            data_quality=dq,
            curve_stats=curve_stats,
        )
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
            "curveStatistics": curve_stats,
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
            "summaryParagraph": summary_paragraph,
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
    curve_stats = compute_curve_statistics(depths=depths, data=data, curves=curves)
    summary = build_summary_bullets(
        from_depth=from_depth,
        to_depth=to_depth,
        row_count=n,
        curves=curves,
        curve_stats=curve_stats,
        findings=findings,
        anomaly_score=anomaly_score,
        detection_conf=detection_conf,
        severity_conf=severity_conf,
        severity_band=severity_band,
        data_quality=dq,
        event_density_per_1000ft=event_density,
        max_curve_bullets=4,
    )
    summary_paragraph = build_summary_paragraph(
        from_depth=from_depth,
        to_depth=to_depth,
        row_count=n,
        curves=curves,
        findings=findings,
        anomaly_score=anomaly_score,
        detection_conf=detection_conf,
        severity_band=severity_band,
        data_quality=dq,
        curve_stats=curve_stats,
    )

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
        "curveStatistics": curve_stats,
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
        "summaryParagraph": summary_paragraph,
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



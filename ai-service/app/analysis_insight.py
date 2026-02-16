from typing import Dict, List

import numpy as np

from app.analysis_utils import EPS, _safe_corr, _slope, probability_bucket


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

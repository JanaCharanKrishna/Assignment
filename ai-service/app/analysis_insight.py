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

    def wh_text(v, corr, sev):
        sev_txt = str(sev or "UNKNOWN").upper()
        corr_txt = f"corr={corr:.2f}" if np.isfinite(corr) else "corr=n/a"
        if v >= 0.75:
            return f"high hydrocarbon indication ({corr_txt}, severity={sev_txt})"
        if v >= 0.50:
            return f"moderate hydrocarbon indication ({corr_txt}, severity={sev_txt})"
        return f"low-to-moderate hydrocarbon indication ({corr_txt}, severity={sev_txt})"

    def _curve_domain_hint(curve1, curve2):
        pair = f"{str(curve1 or '').upper()}|{str(curve2 or '').upper()}"
        if "N_ATM" in pair or "O_ATM" in pair or "ATM" in pair:
            return "Likely atmospheric/background influence; check QC."
        if "CO2" in pair:
            return "May reflect gas-composition change; cross-check nearby curves."
        return "Cross-check with nearby curves and depth trend."

    def bh_text(v, curve1, curve2, m1, m2):
        if v is None or not np.isfinite(v):
            return "insufficient curve pair for balance ratio"
        c1_name = curve1 or "curve-1"
        c2_name = curve2 or "curve-2"
        left = f"{c1_name} mean={m1:.3f}" if np.isfinite(m1) else f"{c1_name} mean=n/a"
        right = f"{c2_name} mean={m2:.3f}" if np.isfinite(m2) else f"{c2_name} mean=n/a"
        hint = _curve_domain_hint(c1_name, c2_name)
        if 0.8 <= v <= 1.25:
            return f"Balanced response ({left}, {right}); no clear dominance. {hint}"
        if v > 1.25:
            return f"{c1_name} dominates ({left} vs {right}); possible compositional skew. {hint}"
        return f"{c2_name} dominates ({right} vs {left}); possible compositional skew. {hint}"

    def _trend_dir(s):
        if not np.isfinite(s):
            return "insufficient trend"
        if s > 0:
            return "increasing"
        if s < 0:
            return "decreasing"
        return "stable"

    def _corr_label(c):
        if not np.isfinite(c):
            return "correlation unavailable"
        a = abs(c)
        if a >= 0.7:
            return "strong correlation"
        if a >= 0.4:
            return "moderate correlation"
        return "weak correlation"

    def ch_text(v, s1, s2, corr, curve1, curve2):
        if v is None or not np.isfinite(v):
            return "insufficient data for character ratio"

        c1_name = curve1 or "curve-1"
        c2_name = curve2 or "curve-2"
        d1 = _trend_dir(s1)
        d2 = _trend_dir(s2)
        corr_text = _corr_label(corr)
        hint = _curve_domain_hint(c1_name, c2_name)

        if v >= 1.6:
            return (
                f"{c2_name} trend dominates ({d2}) versus {c1_name} ({d1}); "
                f"{corr_text}; {c2_name}-driven character with depth. {hint}"
            )
        if v >= 1.15:
            return (
                f"{c2_name} shows moderately stronger trend behavior than {c1_name}; "
                f"{corr_text}; moderate shift toward {c2_name}. {hint}"
            )
        if v >= 0.85:
            return (
                f"{c1_name} and {c2_name} show comparable trend strength "
                f"({d1}/{d2}) with {corr_text}; mixed character response."
            )
        if v >= 0.55:
            return (
                f"{c1_name} trend is moderately stronger than {c2_name} "
                f"({d1} vs {d2}); {corr_text}; moderate shift toward {c1_name}. {hint}"
            )
        return (
            f"{c1_name} trend dominates ({d1}) while {c2_name} is {d2}; "
            f"{corr_text}; {c1_name}-controlled character. {hint}"
        )

    fluid = "Uncertain"
    fluid_conf = float(np.clip(0.45 * severity_conf + 0.30 * max(corr12, 0.0) + 0.25 * anomaly_score, 0.0, 1.0))
    if fluid_conf >= 0.72 and corr12 >= 0.5:
        fluid = "Oil or gas (inferred)"
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

    def _friendly_reason(reason: str, curve: str) -> str:
        r = str(reason or "").strip().lower()
        c = str(curve or "").strip()
        if r == "noisy_zone":
            return f"Rapid local variation in {c or 'selected curves'} suggests a potentially active hydrocarbon interval."
        if r == "step_change":
            return f"Step-like shift in {c or 'selected curves'} indicates a possible fluid transition zone."
        if r == "spike":
            return f"Sharp excursion in {c or 'selected curves'} suggests a localized hydrocarbon show."
        return f"Anomalous behavior in {c or 'selected curves'} suggests interval-level hydrocarbon response."

    shows = []
    for f in findings[:6]:
        p = f.get("probability", probability_bucket(f.get("score", 0.0), f.get("confidence", 0.0)))
        curve_name = str(f.get("curve", "")).strip()
        reason = _friendly_reason(str(f.get("reason", "anomaly")), curve_name)
        shows.append(
            {
                "fromDepth": f["fromDepth"],
                "toDepth": f["toDepth"],
                "probability": p,
                "reason": reason,
                "stability": f.get("stability", "unknown"),
                "score": f.get("score"),
                "priority": f.get("priority"),
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
            label = "High hydrocarbon potential"
        elif local_anom >= 0.3:
            label = "Moderate hydrocarbon potential"
        else:
            label = "Low hydrocarbon potential"

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

    strongest = findings[0] if findings else None
    if strongest:
        strongest_txt = (
            f"Strongest interval is {float(strongest['fromDepth']):.0f}-{float(strongest['toDepth']):.0f} ft"
        )
    else:
        strongest_txt = "No strong localized interval was detected"

    summary_para = (
        f"Interval {from_depth:.3f}-{to_depth:.3f} was analyzed across {len(curves)} selected curve(s). "
        f"{strongest_txt}. Global risk is {severity_band} with detection confidence {detection_conf:.3f}. "
        f"Overall fluid tendency suggests {fluid.lower()}."
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
            "wetnessText": wh_text(wh, corr12, severity_band),
            "balanceText": bh_text(bh, c1, c2, mean1, mean2),
            "characterText": ch_text(ch, slope1, slope2, corr12, c1, c2),
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

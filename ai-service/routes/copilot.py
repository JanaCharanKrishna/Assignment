# app/routes/copilot.py
import json
import logging
import re
from math import sqrt
from fastapi import APIRouter
from pydantic import BaseModel, Field
from typing import Any, Dict, List

from app.ai_client import chat_with_data_verbose
from app.ai_provider import get_ai_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/copilot", tags=["copilot"])


class CopilotReq(BaseModel):
    mode: str = "data_qa"
    question: str
    wellId: str
    fromDepth: float
    toDepth: float
    curves: List[str] = Field(default_factory=list)

    # Optional precomputed context from Node layer
    statistics: Dict[str, Any] = Field(default_factory=dict)
    rows: List[Dict[str, Any]] = Field(default_factory=list)
    evidence: Dict[str, Any] = Field(default_factory=dict)

    detail_level: int = 3
    history: List[Dict[str, str]] = Field(default_factory=list)


def _safe_float(value) -> float | None:
    try:
        num = float(value)
        return num if num == num else None
    except (TypeError, ValueError):
        return None


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _trend_label(values: list[float]) -> str:
    if len(values) < 12:
        return "insufficient points for trend"

    window = max(3, len(values) // 5)
    first_mean = _mean(values[:window])
    last_mean = _mean(values[-window:])
    if first_mean is None or last_mean is None:
        return "insufficient points for trend"

    delta = last_mean - first_mean
    scale = max(abs(first_mean), abs(last_mean), 1e-9)
    relative_change = delta / scale

    if relative_change >= 0.08:
        return "increasing with depth"
    if relative_change <= -0.08:
        return "decreasing with depth"
    return "mostly stable"


def _pearson_correlation(values_a: list[float], values_b: list[float]) -> float | None:
    n = min(len(values_a), len(values_b))
    if n < 3:
        return None

    a = values_a[:n]
    b = values_b[:n]
    mean_a = _mean(a)
    mean_b = _mean(b)
    if mean_a is None or mean_b is None:
        return None

    num = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
    den_a = sum((x - mean_a) ** 2 for x in a)
    den_b = sum((y - mean_b) ** 2 for y in b)
    den = sqrt(den_a * den_b)
    if den == 0:
        return None
    return num / den


def _normalize_token(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def _extract_mentioned_curves(message: str, available_curve_names: list[str]) -> list[str]:
    if not message:
        return []

    raw_message = message.upper()
    normalized_message = _normalize_token(message)
    matches: list[str] = []

    for curve in sorted(available_curve_names, key=len, reverse=True):
        curve_upper = curve.upper()
        curve_normalized = _normalize_token(curve)
        if curve_upper in raw_message or (curve_normalized and curve_normalized in normalized_message):
            if curve not in matches:
                matches.append(curve)
    return matches


def _pick_focus_curves(
    mentioned_curves: list[str],
    curves_in_scope: list[str],
    stats: dict,
    max_curves: int = 4,
) -> list[str]:
    focus: list[str] = []

    for curve in mentioned_curves:
        if curve in curves_in_scope and curve not in focus:
            focus.append(curve)
        if len(focus) >= max_curves:
            return focus

    scored: list[tuple[float, str]] = []
    for curve in curves_in_scope:
        s = stats.get(curve, {})
        if s.get("non_null_count", 0) <= 0:
            continue
        cmin = s.get("min")
        cmax = s.get("max")
        if cmin is None or cmax is None:
            continue
        scored.append((float(cmax) - float(cmin), curve))

    for _, curve in sorted(scored, key=lambda x: x[0], reverse=True):
        if curve not in focus:
            focus.append(curve)
        if len(focus) >= max_curves:
            return focus

    for curve in curves_in_scope:
        if curve not in focus:
            focus.append(curve)
        if len(focus) >= max_curves:
            break

    return focus


def _compute_statistics(rows: list[dict], curves: list[str]) -> dict:
    stats: dict[str, dict] = {}
    for curve in curves:
        vals = []
        for row in rows:
            v = _safe_float(row.get(curve))
            if v is not None:
                vals.append(v)
        if vals:
            stats[curve] = {
                "min": min(vals),
                "max": max(vals),
                "mean": _mean(vals),
                "non_null_count": len(vals),
            }
        else:
            stats[curve] = {"min": None, "max": None, "mean": None, "non_null_count": 0}
    return stats


def _format_stats_text(stats: dict) -> str:
    if not stats:
        return "- No statistics available."

    lines = []
    for curve, curve_stats in stats.items():
        valid_points = curve_stats.get("non_null_count", 0)
        if valid_points > 0:
            lines.append(
                f"- {curve}: min={curve_stats['min']}, max={curve_stats['max']}, "
                f"mean={curve_stats['mean']} ({valid_points} valid points)"
            )
        else:
            lines.append(f"- {curve}: no valid points in this interval")
    return "\n".join(lines)


def _format_query_analytics(rows: list[dict], focus_curves: list[str]) -> str:
    if not rows or not focus_curves:
        return "- No row-level analytics available for this question."

    max_rows = 3500
    stride = max(1, len(rows) // max_rows)
    sampled_rows = rows[::stride]
    lines: list[str] = []
    values_by_curve: dict[str, list[float]] = {}

    for curve in focus_curves:
        pairs: list[tuple[float, float]] = []
        for row in sampled_rows:
            depth = _safe_float(row.get("depth"))
            value = _safe_float(row.get(curve))
            if depth is None or value is None:
                continue
            pairs.append((depth, value))

        if len(pairs) < 3:
            lines.append(f"- {curve}: not enough valid points for trend/zone analysis.")
            continue

        depths = [d for d, _ in pairs]
        values = [v for _, v in pairs]
        values_by_curve[curve] = values

        cmin = min(values)
        cmax = max(values)
        cmean = _mean(values)
        max_idx = values.index(cmax)
        min_idx = values.index(cmin)
        trend = _trend_label(values)

        sorted_values = sorted(values)
        n_sv = len(sorted_values)
        p90_pos = 0.9 * (n_sv - 1)
        p90_lo = int(p90_pos)
        p90_hi = min(p90_lo + 1, n_sv - 1)
        p90_frac = p90_pos - p90_lo
        p90 = sorted_values[p90_lo] + p90_frac * (sorted_values[p90_hi] - sorted_values[p90_lo])
        high_zone_depths = [d for d, v in pairs if v >= p90]
        high_zone_text = (
            f"{min(high_zone_depths):.1f}-{max(high_zone_depths):.1f} ft"
            if high_zone_depths else "n/a"
        )

        lines.append(
            f"- {curve}: trend={trend}; mean={cmean:.3f}; "
            f"max={cmax:.3f} at {depths[max_idx]:.1f} ft; "
            f"min={cmin:.3f} at {depths[min_idx]:.1f} ft; "
            f"high-response zone(p90+)={high_zone_text}"
        )

    if len(focus_curves) >= 2:
        c1, c2 = focus_curves[0], focus_curves[1]
        if c1 in values_by_curve and c2 in values_by_curve:
            corr = _pearson_correlation(values_by_curve[c1], values_by_curve[c2])
            if corr is None:
                lines.append(f"- {c1} vs {c2}: correlation unavailable (insufficient variation).")
            else:
                strength = (
                    "strong" if abs(corr) >= 0.7
                    else "moderate" if abs(corr) >= 0.4
                    else "weak"
                )
                direction = "positive" if corr >= 0 else "negative"
                lines.append(
                    f"- {c1} vs {c2}: {strength} {direction} correlation (r={corr:.3f}) in current scope."
                )

    return "\n".join(lines) if lines else "- No row-level analytics available for this question."


def _build_well_summary(req: CopilotReq, rows: list[dict], curves: list[str]) -> str:
    return (
        f"Well: {req.wellId}\n"
        f"Depth window: {req.fromDepth} - {req.toDepth} ft\n"
        f"Rows in scope: {len(rows)}\n"
        f"Curves in scope ({len(curves)}): {', '.join(curves) if curves else 'none'}\n"
        f"Mode: {req.mode}"
    )


def _build_data_context(req: CopilotReq, rows: list[dict], curves: list[str], stats: dict) -> str:
    curve_names = curves[:]
    mentioned_curves = _extract_mentioned_curves(req.question, curve_names)
    focus_curves = _pick_focus_curves(mentioned_curves, curve_names, stats, max_curves=4)
    query_analytics = _format_query_analytics(rows, focus_curves)

    det = req.evidence.get("deterministic", {}) if isinstance(req.evidence, dict) else {}
    nar = req.evidence.get("narrative", {}) if isinstance(req.evidence, dict) else {}

    return (
        "Current analysis scope:\n"
        f"- Depth window: {req.fromDepth} - {req.toDepth} ft\n"
        f"- Curves in scope ({len(curves)}): {', '.join(curves) if curves else 'none'}\n"
        f"- Requested response detail level (1-5): {req.detail_level}\n"
        f"- Curve statistics in current scope:\n{_format_stats_text(stats)}\n\n"
        "Question-specific context:\n"
        f"- User question: {req.question}\n"
        f"- Curves mentioned by user: {', '.join(mentioned_curves) if mentioned_curves else 'none explicitly'}\n"
        f"- Focus curves for this reply: {', '.join(focus_curves) if focus_curves else 'none'}\n"
        f"- Focus analytics:\n{query_analytics}\n\n"
        "Deterministic evidence summary:\n"
        f"- Severity band: {det.get('severityBand', 'unknown')}\n"
        f"- Detection confidence: {det.get('detectionConfidence', 'n/a')}\n"
        f"- Event count: {det.get('eventCount', 'n/a')}\n"
        f"- Narrative intervals available: {len(nar.get('interval_explanations', []) if isinstance(nar, dict) else [])}\n"
        "Important scope rule: prioritize this selected depth window and curve set. "
        "Only reference out-of-scope behavior when explicitly asked."
    )


def _extract_json_object(text: str) -> dict | None:
    if not text:
        return None

    candidate = text.strip()
    if candidate.startswith("```"):
        parts = candidate.split("\n", 1)
        candidate = parts[1] if len(parts) > 1 else candidate[3:]
    if candidate.endswith("```"):
        candidate = candidate[:-3]
    candidate = candidate.strip()
    if candidate.startswith("json"):
        candidate = candidate[4:].strip()

    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass

    start = candidate.find("{")
    while start != -1:
        try:
            parsed, _ = json.JSONDecoder().raw_decode(candidate[start:])
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
        start = candidate.find("{", start + 1)
    return None


def _looks_like_copilot_schema(x: dict) -> bool:
    return (
        isinstance(x, dict)
        and isinstance(x.get("answer_title"), str)
        and isinstance(x.get("direct_answer"), str)
        and isinstance(x.get("key_points"), list)
        and isinstance(x.get("actions"), list)
        and isinstance(x.get("comparison"), dict)
        and isinstance(x.get("risks"), list)
        and isinstance(x.get("uncertainties"), list)
        and isinstance(x.get("confidence"), dict)
        and isinstance(x.get("evidence_used"), list)
    )


def _build_min_schema_from_answer(answer: str, req: CopilotReq) -> dict:
    return {
        "answer_title": "Copilot Answer",
        "direct_answer": str(answer or "No response was generated."),
        "key_points": [
            f"Well: {req.wellId}",
            f"Analyzed range: {req.fromDepth:.1f}-{req.toDepth:.1f} ft",
            f"Mode: {req.mode}",
        ],
        "actions": [
            {
                "priority": "medium",
                "action": "Validate highlighted intervals against nearby depth windows",
                "rationale": "Improves confidence and reduces localized false positives.",
            }
        ],
        "comparison": {"summary": "", "delta_metrics": []},
        "risks": ["Interpretation is model-assisted and must be domain-validated."],
        "uncertainties": ["Response is limited to selected curves and depth window."],
        "confidence": {
            "overall": 0.62,
            "rubric": "medium",
            "reason": "Derived from scoped statistics, row-level analytics, and deterministic context.",
        },
        "evidence_used": [
            {
                "source": "scoped_context",
                "confidence": "medium",
                "snippet": f"curves={len(req.curves)}, interval={req.fromDepth:.1f}-{req.toDepth:.1f} ft",
            }
        ],
        "safety_note": "Decision support only, not autonomous control.",
    }


def _generate_structured_copilot_json(
    req: CopilotReq,
    well_summary: str,
    data_context: str,
) -> tuple[dict | None, str | None]:
    client, provider, model_name = get_ai_client()
    if not client:
        return None, "client_not_configured"

    normalized_detail = max(1, min(5, int(req.detail_level or 3)))
    target_len = {
        1: "very concise",
        2: "concise",
        3: "moderate detail",
        4: "detailed",
        5: "high detail",
    }[normalized_detail]

    system_prompt = f"""You are a senior well-log copilot.
Return STRICT JSON only.
Do not add markdown fences.

Required schema:
{{
  "answer_title": "string",
  "direct_answer": "string",
  "key_points": ["string"],
  "actions": [{{"priority":"high|medium|low","action":"string","rationale":"string"}}],
  "comparison": {{"summary":"string","delta_metrics":[{{"metric":"string","current":"any","baseline":"any","delta":"any"}}]}},
  "risks": ["string"],
  "uncertainties": ["string"],
  "confidence": {{"overall": 0.0, "rubric":"low|medium|high", "reason":"string"}},
  "evidence_used": [{{"source":"string","confidence":"low|medium|high","snippet":"string"}}],
  "safety_note": "Decision support only, not autonomous control."
}}

Rules:
- Ground every claim in provided context only.
- Prefer depth-specific and curve-specific statements.
- Keep output at {target_len} level.
- If evidence is weak, say so explicitly in uncertainties/confidence.
"""

    user_prompt = (
        f"Mode: {req.mode}\n"
        f"Question: {req.question}\n\n"
        f"Well summary:\n{well_summary}\n\n"
        f"Data context:\n{data_context}\n\n"
        "Return JSON only."
    )

    try:
        resp = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.35 + (normalized_detail * 0.03),
            max_tokens=1200 + (normalized_detail * 250),
        )
        content = (resp.choices[0].message.content or "").strip()
        parsed = _extract_json_object(content)
        if parsed is None or not _looks_like_copilot_schema(parsed):
            return None, "schema_parse_or_shape_failed"
        return parsed, None
    except Exception as e:
        logger.warning("copilot.structured_json_failed provider=%s err=%s", provider, str(e))
        return None, str(e)


@router.post("/query")
async def copilot_query(req: CopilotReq):
    curves = [str(c).strip() for c in req.curves if str(c).strip()]
    rows = req.rows if isinstance(req.rows, list) else []
    stats = req.statistics if isinstance(req.statistics, dict) and req.statistics else _compute_statistics(rows, curves)

    well_summary = _build_well_summary(req, rows, curves)
    data_context = _build_data_context(req, rows, curves, stats)
    msg = f"[mode={req.mode}] {req.question or 'Give a concise technical summary.'}".strip()

    structured_json, structured_error = _generate_structured_copilot_json(
        req=req,
        well_summary=well_summary,
        data_context=data_context,
    )

    result = chat_with_data_verbose(
        well_name=req.wellId,
        message=msg,
        history=req.history[-12:],
        well_summary=well_summary,
        data_context=data_context,
        detail_level=req.detail_level,
    )
    source = str(result.get("source", "fallback"))
    llm_used = bool(result.get("llm_used", False))
    provider = result.get("provider")
    model = result.get("model")
    llm_error = result.get("llm_error")
    answer = str(result.get("answer", "No response was generated."))
    schema_candidate = structured_json or _build_min_schema_from_answer(answer, req)
    if structured_error:
        llm_error = f"{llm_error}; structured={structured_error}" if llm_error else f"structured={structured_error}"

    logger.info(
        "copilot.query source=%s llm_used=%s provider=%s model=%s wellId=%s mode=%s",
        source,
        llm_used,
        provider,
        model,
        req.wellId,
        req.mode,
    )
    if llm_error:
        logger.warning("copilot.query llm_error=%s", llm_error)

    return {
        "ok": True,
        "source": source,
        "llm_used": llm_used,
        "provider": provider,
        "model": model,
        "llm_error": llm_error,
        "wellId": req.wellId,
        "range": {"fromDepth": req.fromDepth, "toDepth": req.toDepth},
        "curves": curves,
        "answer": answer,
        "json": schema_candidate,
    }


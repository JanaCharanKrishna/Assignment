import json
import logging
import re
from math import sqrt
from openai import OpenAI
from app.config import settings

logger = logging.getLogger(__name__)

# Initialize client lazily
_client = None
_provider = "NONE"
_model_name = ""

def get_ai_client():
    global _client, _provider, _model_name
    
    # Re-check settings if client is not yet initialized
    groq_key = settings.GROQ_API_KEY.strip() if settings.GROQ_API_KEY else ""
    openai_key = settings.OPENAI_API_KEY.strip() if settings.OPENAI_API_KEY else ""

    def is_placeholder(key):
        return not key or "your_key" in key or "sk-proj-XXX" in key or len(key) < 20

    if not _client:
        if not is_placeholder(groq_key):
            _client = OpenAI(
                api_key=groq_key,
                base_url="https://api.groq.com/openai/v1"
            )
            _provider = "GROQ"
            _model_name = "llama-3.3-70b-versatile"
            logger.info(f"AI subsystem online via {_provider}")
        elif not is_placeholder(openai_key):
            _client = OpenAI(api_key=openai_key)
            _provider = "OPENAI"
            _model_name = "gpt-4o"
            logger.info(f"AI subsystem online via {_provider}")
    
    return _client, _provider, _model_name


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


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    # Linear interpolation for accurate percentile
    pos = q * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return sorted_vals[lo] + frac * (sorted_vals[hi] - sorted_vals[lo])


def _trend_label(values: list[float]) -> str:
    if len(values) < 12:
        return "insufficient points"
    window = max(3, len(values) // 5)
    head = _mean(values[:window])
    tail = _mean(values[-window:])
    if head is None or tail is None:
        return "insufficient points"

    delta = tail - head
    scale = max(abs(head), abs(tail), 1e-9)
    rel = delta / scale
    if rel >= 0.08:
        return "increasing with depth"
    if rel <= -0.08:
        return "decreasing with depth"
    return "mostly stable"


def _pearson(values_a: list[float], values_b: list[float]) -> float | None:
    n = min(len(values_a), len(values_b))
    if n < 3:
        return None
    a = values_a[:n]
    b = values_b[:n]
    mean_a = _mean(a)
    mean_b = _mean(b)
    if mean_a is None or mean_b is None:
        return None

    numerator = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
    den_a = sum((x - mean_a) ** 2 for x in a)
    den_b = sum((y - mean_b) ** 2 for y in b)
    denom = sqrt(den_a * den_b)
    if denom == 0:
        return None
    return numerator / denom


def _curve_pairs(sample_data: list[dict], curve: str, max_rows: int = 4000) -> list[tuple[float, float]]:
    if not sample_data:
        return []
    stride = max(1, len(sample_data) // max_rows)
    pairs: list[tuple[float, float]] = []
    for row in sample_data[::stride]:
        depth = _safe_float(row.get("depth"))
        value = _safe_float(row.get(curve))
        if depth is None or value is None:
            continue
        pairs.append((depth, value))
    return pairs


def _build_interpretation_diagnostics(
    statistics: dict,
    sample_data: list[dict],
    curves: list[str],
    depth_min: float,
    depth_max: float,
) -> str:
    lines: list[str] = [
        f"Interval length: {round(depth_max - depth_min, 2)}",
        f"Curves analyzed: {', '.join(curves)}",
    ]

    scored_ranges: list[tuple[float, str]] = []
    for curve in curves:
        s = statistics.get(curve, {})
        if s.get("non_null_count", 0) <= 0:
            continue
        cmin = _safe_float(s.get("min"))
        cmax = _safe_float(s.get("max"))
        cmean = _safe_float(s.get("mean"))
        if cmin is None or cmax is None or cmean is None:
            continue
        scored_ranges.append((cmax - cmin, curve))

    dominant_curves = [curve for _, curve in sorted(scored_ranges, key=lambda x: x[0], reverse=True)[:4]]
    lines.append(f"Dominant-variance curves: {', '.join(dominant_curves) if dominant_curves else 'none'}")

    curve_values: dict[str, list[float]] = {}
    for curve in (dominant_curves or curves[:4]):
        pairs = _curve_pairs(sample_data, curve)
        if len(pairs) < 3:
            continue
        values = [v for _, v in pairs]
        depths = [d for d, _ in pairs]
        curve_values[curve] = values

        p90 = _percentile(values, 0.9)
        high_depths = [d for d, v in pairs if p90 is not None and v >= p90]
        high_zone = (
            f"{round(min(high_depths), 1)}-{round(max(high_depths), 1)}"
            if high_depths else "n/a"
        )

        lines.append(
            f"{curve}: trend={_trend_label(values)}, mean={round(_mean(values), 4)}, "
            f"max={round(max(values), 4)} at {round(depths[values.index(max(values))], 1)}, "
            f"high-zone(p90+)={high_zone}"
        )

    pair_candidates = list(curve_values.keys())[:3]
    if len(pair_candidates) >= 2:
        for i in range(len(pair_candidates)):
            for j in range(i + 1, len(pair_candidates)):
                a, b = pair_candidates[i], pair_candidates[j]
                corr = _pearson(curve_values[a], curve_values[b])
                if corr is None:
                    continue
                lines.append(f"Correlation {a} vs {b}: r={round(corr, 4)}")

    return "\n".join(f"- {line}" for line in lines)


def _extract_json_object(text: str) -> dict | None:
    if not text:
        return None

    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = candidate.split("\n", 1)[1] if "\n" in candidate else candidate[3:]
    if candidate.endswith("```"):
        candidate = candidate[:-3]
    candidate = candidate.strip()
    if candidate.startswith("json"):
        candidate = candidate[4:].strip()

    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    start = candidate.find("{")
    while start != -1:
        try:
            parsed, _ = decoder.raw_decode(candidate[start:])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
        start = candidate.find("{", start + 1)

    return None


def interpret_well_data(
    well_name: str,
    curves: list[str],
    depth_min: float,
    depth_max: float,
    statistics: dict,
    sample_data: list[dict],
) -> dict:
    """
    Use AI (OpenAI or Groq) to interpret well-log gas chromatography data.
    """
    client, provider, model_name = get_ai_client()
    
    if not client:
        return _fallback_interpretation(
            well_name, curves, depth_min, depth_max, statistics, sample_data
        )

    stats_text = _format_statistics(statistics)
    sample_text = _format_sample_data(sample_data, curves, max_rows=30)
    diagnostics_text = _build_interpretation_diagnostics(
        statistics, sample_data, curves, depth_min, depth_max
    )

    prompt = f"""You are a senior well-log geochemistry analyst producing high-confidence technical interpretation.

Well: {well_name}
Depth interval: {depth_min} to {depth_max}

Use the curve statistics, sampled rows, and derived diagnostics below.
Do not produce generic statements; every section must anchor to numbers, curve mnemonics, and depth intervals.

Interpretation requirements:
1. Identify strongest hydrocarbon-response intervals with exact depth ranges.
2. Distinguish primary fluid tendency and explain with evidence from multiple curves.
3. Provide risk profile with explicit technical rationale.
4. Segment 2 to 4 non-overlapping zones with clear characterization.
5. Recommendations must be concrete, not generic.
6. Avoid vague phrasing like "varying strength" without quantified evidence.
7. Ensure output differs when input curves/depth interval differ.

Curve statistics:
{stats_text}

Sampled data:
{sample_text}

Derived diagnostics:
{diagnostics_text}

Return strict JSON with this schema:
{{
  "summary": "strong technical summary with explicit interval and curve evidence",
  "geochemical_metrics": {{
    "wetness_index": "value and interpretation",
    "balance_ratio": "value and interpretation",
    "character_ratio": "value and interpretation"
  }},
  "gas_shows": [
    {{
      "depth_top": float,
      "depth_bottom": float,
      "analysis": "what the data suggests",
      "fluid_probability": "High/Med/Low",
      "geological_context": "brief context"
    }}
  ],
  "fluid_type": "primary fluid interpretation",
  "fluid_evidence": "key evidence from curves and ratios",
  "risk_profile": {{
    "seal_risk": "Low/Med/High",
    "saturation_risk": "Low/Med/High",
    "technical_summary": "single-sentence risk summary"
  }},
  "zones": [
    {{
      "depth_top": float,
      "depth_bottom": float,
      "characterization": "zone label",
      "key_markers": "key markers"
    }}
  ],
  "recommendations": ["clear recommendation"]
}}

Return raw JSON only. Do not include markdown or prose outside JSON.
"""

    try:
        client, provider, model_name = get_ai_client()
        if not client:
             return _fallback_interpretation(
                 well_name, curves, depth_min, depth_max, statistics, sample_data
             )

        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a precise geochemical analyst. "
                        "Always return valid JSON with evidence-driven, non-generic conclusions."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.45,
            max_tokens=3000,
        )
        content = response.choices[0].message.content.strip()
        parsed = _extract_json_object(content)
        if parsed is not None:
            return parsed
        logger.error(f"Failed to parse {provider} response as JSON.")
        return _fallback_interpretation(
            well_name, curves, depth_min, depth_max, statistics, sample_data
        )
    except Exception as e:
        logger.error(f"{provider} API error: {e}")
        return _fallback_interpretation(
            well_name, curves, depth_min, depth_max, statistics, sample_data
        )


def chat_with_data(
    well_name: str,
    message: str,
    history: list[dict],
    well_summary: str,
    data_context: str,
    detail_level: int = 3,
) -> str:
    """
    Chatbot: answer questions about the well data.
    """
    client, provider, model_name = get_ai_client()
    
    if not client:
        return (
            "AI chatbot is not available. Please configure GROQ_API_KEY or OPENAI_API_KEY in backend/.env."
        )

    normalized_detail = max(1, min(5, int(detail_level or 3)))
    detail_profiles = {
        1: {"length": "80-120 words", "bullets": "2 to 3"},
        2: {"length": "100-160 words", "bullets": "3 to 4"},
        3: {"length": "120-220 words", "bullets": "3 to 5"},
        4: {"length": "180-300 words", "bullets": "4 to 6"},
        5: {"length": "240-420 words", "bullets": "5 to 8"},
    }
    profile = detail_profiles[normalized_detail]

    system_prompt = f"""You are a senior well-log analysis assistant for engineering users.

Use well_summary and data_context as the only trusted evidence source.

Behavior rules:
1. Prioritize question-specific context and focus analytics over generic summary.
2. Do not repeat the same template language across turns.
3. Do not restate full curve inventory unless user explicitly asks for it.
4. Provide the strongest data-backed finding first, then supporting evidence.
5. If user asks a broad question, still provide concrete ranked findings (top 2-3) rather than generic overview.
6. If evidence is weak, say exactly what is missing.

Answer style:
- First line: "Key finding: <direct conclusion>"
- Then {profile['bullets']} concise bullets with concrete numbers (depth, min/max, mean, trend, correlation).
- End with one line: "Action: <specific next analysis/check>".
- Keep answers sharp and technical; avoid filler.
- Target response length: {profile['length']} unless user explicitly asks otherwise.
- Respect requested detail level = {normalized_detail} out of 5.

Well summary:
{well_summary}

Data context:
{data_context}
"""

    messages = [{"role": "system", "content": system_prompt}]
    for msg in history:
        messages.append(msg)
    messages.append({"role": "user", "content": message})

    try:
        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=0.55 + (normalized_detail * 0.03),
            max_tokens=900 + (normalized_detail * 350),
        )
        return _clean_chat_text(response.choices[0].message.content)
    except Exception as e:
        logger.error(f"{provider} Chat API error: {e}")
        if "insufficient_quota" in str(e).lower():
            return "AI chat is unavailable because API quota is exhausted. Please check your API key and quota."
        return f"AI chat is unavailable due to a {provider} API error."


def _clean_chat_text(text: str) -> str:
    if not text:
        return "No response was generated."

    cleaned = text.replace("\r\n", "\n").strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned


def _format_statistics(stats: dict) -> str:
    lines = []
    for curve, s in stats.items():
        if s["non_null_count"] > 0:
            lines.append(
                f"  {curve}: min={s['min']}, max={s['max']}, "
                f"mean={s['mean']}, points={s['non_null_count']}"
            )
        else:
            lines.append(f"  {curve}: no valid data")
    return "\n".join(lines)


def _format_sample_data(data: list[dict], curves: list[str], max_rows: int = 30) -> str:
    if not data:
        return "No data available."
    step = max(1, len(data) // max_rows)
    sampled = data[::step][:max_rows]

    header = "Depth | " + " | ".join(curves)
    lines = [header, "-" * len(header)]
    for row in sampled:
        vals = [str(row.get(c, "null")) for c in curves]
        lines.append(f"{row['depth']} | " + " | ".join(vals))
    return "\n".join(lines)


def _fallback_interpretation(
    well_name,
    curves,
    depth_min,
    depth_max,
    statistics,
    sample_data=None,
):
    """
    Deterministic interpretation fallback when AI is unavailable.
    Produces structured, evidence-based output to avoid generic reports.
    """
    sample_data = sample_data or []
    valid_curves = [
        curve for curve in curves
        if statistics.get(curve, {}).get("non_null_count", 0) > 0
    ]

    if not valid_curves:
        return {
            "summary": (
                f"No valid numeric samples were found in {depth_min}-{depth_max} for well '{well_name}'."
            ),
            "geochemical_metrics": {
                "wetness_index": "n/a, insufficient data",
                "balance_ratio": "n/a, insufficient data",
                "character_ratio": "n/a, insufficient data",
            },
            "gas_shows": [],
            "fluid_type": "insufficient data",
            "fluid_evidence": "No curves with valid points were available in the selected interval.",
            "risk_profile": {
                "seal_risk": "High",
                "saturation_risk": "High",
                "technical_summary": "Interpretation confidence is low due to missing valid curve values.",
            },
            "zones": [],
            "recommendations": [
                "Verify data quality and null-value handling for the selected interval.",
                "Expand depth interval or include additional valid curves before interpretation.",
            ],
        }

    def stat_mean(curve_name: str) -> float:
        return _safe_float(statistics.get(curve_name, {}).get("mean")) or 0.0

    hydro_candidates = [
        c for c in valid_curves
        if ("HC" in c.upper() or "GAS" in c.upper() or c.upper().startswith("C"))
    ]
    if not hydro_candidates:
        hydro_candidates = sorted(valid_curves, key=stat_mean, reverse=True)[:4]

    ranked_hydro = sorted(hydro_candidates, key=stat_mean, reverse=True)
    primary_curve = ranked_hydro[0]
    secondary_curve = ranked_hydro[1] if len(ranked_hydro) > 1 else ranked_hydro[0]

    # Basic derived indices from mean values (heuristic fallback).
    light_means = [stat_mean(c) for c in ranked_hydro if any(x in c.upper() for x in ["HC1", "HC2", "HC3"])]
    heavy_means = [stat_mean(c) for c in ranked_hydro if any(x in c.upper() for x in ["HC4", "HC5", "HC6", "HC7"])]
    total_light = sum(light_means)
    total_heavy = sum(heavy_means)

    # Wetness Index: high wetness = liquid-rich (oil-prone), low wetness = dry gas.
    # Wh = (C2+C3+C4+C5) / (C1+C2+C3+C4+C5) — standard geochemical definition.
    wetness = (total_heavy / (total_light + total_heavy)) if (total_light + total_heavy) > 0 else 0.0
    balance = (stat_mean("TOTAL_GAS") / max(stat_mean(primary_curve), 1e-9)) if "TOTAL_GAS" in statistics else stat_mean(primary_curve)
    character = (total_heavy / max(total_light, 1e-9)) if total_light > 0 else total_heavy

    if wetness <= 0.17:
        fluid_type = "dry gas system"
    elif wetness <= 0.40:
        fluid_type = "gas-prone hydrocarbon system"
    elif wetness <= 0.65:
        fluid_type = "mixed gas and oil system"
    else:
        fluid_type = "oil-prone or condensate-rich system"

    def high_interval(curve_name: str):
        pairs = _curve_pairs(sample_data, curve_name)
        if len(pairs) < 8:
            return None
        values = [v for _, v in pairs]
        threshold = _percentile(values, 0.9)
        if threshold is None:
            return None
        depths = [d for d, v in pairs if v >= threshold]
        if not depths:
            return None
        return round(min(depths), 1), round(max(depths), 1), threshold

    gas_shows = []
    for curve_name, confidence in [(primary_curve, "High"), (secondary_curve, "Med")]:
        interval = high_interval(curve_name)
        if not interval:
            continue
        top_d, bot_d, threshold = interval
        gas_shows.append({
            "depth_top": top_d,
            "depth_bottom": bot_d,
            "analysis": (
                f"{curve_name} exceeds its high-response threshold ({round(threshold, 3)}) "
                f"indicating concentrated hydrocarbon response."
            ),
            "fluid_probability": confidence,
            "geological_context": f"High-response band driven by {curve_name} in this interval.",
        })

    # Build 3 depth zones with relative hydrocarbon intensity.
    zone_bounds = [
        (depth_min, depth_min + (depth_max - depth_min) / 3),
        (depth_min + (depth_max - depth_min) / 3, depth_min + 2 * (depth_max - depth_min) / 3),
        (depth_min + 2 * (depth_max - depth_min) / 3, depth_max),
    ]

    def zone_intensity(start_d: float, end_d: float) -> float:
        if not sample_data:
            return 0.0
        values = []
        for row in sample_data:
            depth = _safe_float(row.get("depth"))
            if depth is None or depth < start_d or depth > end_d:
                continue
            curve_vals = []
            for c in ranked_hydro[:3]:
                val = _safe_float(row.get(c))
                if val is not None:
                    curve_vals.append(val)
            if curve_vals:
                values.append(sum(curve_vals) / len(curve_vals))
        return _mean(values) or 0.0

    overall_intensity = _mean([zone_intensity(a, b) for a, b in zone_bounds]) or 0.0
    zones = []
    for idx, (start_d, end_d) in enumerate(zone_bounds, start=1):
        intensity = zone_intensity(start_d, end_d)
        relative = intensity / max(overall_intensity, 1e-9) if overall_intensity > 0 else 0
        if relative >= 1.2:
            label = "gas-enriched zone"
        elif relative >= 0.85:
            label = "mixed fluid zone"
        else:
            label = "lower-intensity hydrocarbon zone"
        zones.append({
            "depth_top": round(start_d, 1),
            "depth_bottom": round(end_d, 1),
            "characterization": label,
            "key_markers": (
                f"Relative hydrocarbon intensity={round(relative, 2)} "
                f"using {', '.join(ranked_hydro[:3])}"
            ),
        })

    # Risk profile from variability and deep-zone weakening.
    primary_stats = statistics.get(primary_curve, {})
    p_min = _safe_float(primary_stats.get("min")) or 0.0
    p_max = _safe_float(primary_stats.get("max")) or 0.0
    p_mean = max(_safe_float(primary_stats.get("mean")) or 0.0, 1e-9)
    variability = (p_max - p_min) / p_mean
    deep_intensity = zone_intensity(zone_bounds[-1][0], zone_bounds[-1][1])
    shallow_intensity = zone_intensity(zone_bounds[0][0], zone_bounds[0][1])

    seal_risk = "High" if variability > 2.2 else "Med" if variability > 1.2 else "Low"
    saturation_risk = "High" if deep_intensity < (0.55 * max(shallow_intensity, 1e-9)) else "Med" if deep_intensity < (0.8 * max(shallow_intensity, 1e-9)) else "Low"

    summary = (
        f"In {round(depth_min, 1)}-{round(depth_max, 1)}, strongest responses are driven by "
        f"{primary_curve} (mean {round(stat_mean(primary_curve), 3)}) and {secondary_curve} "
        f"(mean {round(stat_mean(secondary_curve), 3)}), with inferred {fluid_type}."
    )

    fluid_evidence = (
        f"Primary evidence: {primary_curve} and {secondary_curve} high-response intervals, "
        f"wetness index {round(wetness, 3)}, and variability ratio {round(variability, 3)}."
    )

    return {
        "summary": summary,
        "geochemical_metrics": {
            "wetness_index": f"{round(wetness, 4)} (derived)",
            "balance_ratio": f"{round(balance, 4)} (derived)",
            "character_ratio": f"{round(character, 4)} (derived)",
        },
        "gas_shows": gas_shows,
        "fluid_type": fluid_type,
        "fluid_evidence": fluid_evidence,
        "risk_profile": {
            "seal_risk": seal_risk,
            "saturation_risk": saturation_risk,
            "technical_summary": (
                f"Seal risk {seal_risk} and saturation risk {saturation_risk} derived from "
                f"{primary_curve} variability and deep-to-shallow intensity contrast."
            ),
        },
        "zones": zones,
        "recommendations": [
            f"Validate {primary_curve} and {secondary_curve} with complementary petrophysical logs.",
            "Run focused sampling/coring across highest-response intervals to confirm fluid typing.",
            "Cross-check drilling parameters versus hydrocarbon intensity transitions between zones.",
        ],
    }
import json
import re
from math import sqrt


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



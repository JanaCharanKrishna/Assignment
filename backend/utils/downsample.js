function pickMinMax(points, metrics) {
  if (!points.length) return [];

  let minP = points[0];
  let maxP = points[0];
  let minSum = 0;
  let maxSum = 0;

  for (const p of points) {
    let s = 0;
    for (const m of metrics) {
      const v = p.values?.[m];
      if (typeof v === "number" && Number.isFinite(v)) s += v;
    }
    if (s < minSum) {
      minSum = s;
      minP = p;
    }
    if (s > maxSum) {
      maxSum = s;
      maxP = p;
    }
  }

  // Ensure stable order by depth
  return minP.depth <= maxP.depth ? [minP, maxP] : [maxP, minP];
}

/**
 * Downsample by buckets to ~targetPoints.
 * Input rows: [{ depth, values: {metric: number|null}}]
 * Output rows: same shape but fewer points.
 */
export function downsampleMinMax(rows, metrics, targetPoints = 1200) {
  if (!Array.isArray(rows) || rows.length <= targetPoints) return rows;
  if (!metrics?.length) return rows.slice(0, targetPoints);

  const n = rows.length;
  const buckets = Math.max(1, Math.floor(targetPoints / 2)); // 2 points per bucket (min+max)
  const size = Math.ceil(n / buckets);

  const out = [];
  for (let i = 0; i < n; i += size) {
    const chunk = rows.slice(i, i + size);
    if (!chunk.length) continue;

    // Always include first and last for continuity (optional but good)
    if (out.length === 0) out.push(chunk[0]);

    const mm = pickMinMax(chunk, metrics);
    for (const p of mm) {
      if (out[out.length - 1]?.depth !== p.depth) out.push(p);
    }

    const last = chunk[chunk.length - 1];
    if (out[out.length - 1]?.depth !== last.depth) out.push(last);
  }

  // If still too big, hard-trim with stride
  if (out.length > targetPoints) {
    const stride = Math.ceil(out.length / targetPoints);
    const trimmed = [];
    for (let i = 0; i < out.length; i += stride) trimmed.push(out[i]);
    if (trimmed[trimmed.length - 1]?.depth !== out[out.length - 1]?.depth) {
      trimmed.push(out[out.length - 1]);
    }
    return trimmed;
  }

  return out;
}

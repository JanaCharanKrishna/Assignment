function downsampleMinmax(rows, targetPoints) {
  const n = Array.isArray(rows) ? rows.length : 0;
  if (!n || n <= Number(targetPoints) || Number(targetPoints) <= 0) {
    return Array.isArray(rows) ? rows : [];
  }

  const buckets = Math.max(1, Math.floor(Number(targetPoints) / 2));
  const bucketSize = n / buckets;
  const out = [];

  for (let i = 0; i < buckets; i += 1) {
    const lo = Math.floor(i * bucketSize);
    const hi = Math.min(n, Math.floor((i + 1) * bucketSize));
    if (lo >= hi) continue;
    const chunk = rows.slice(lo, hi);
    if (!chunk.length) continue;

    let mn = chunk[0];
    let mx = chunk[0];
    for (const r of chunk) {
      if (Number(r.value) < Number(mn.value)) mn = r;
      if (Number(r.value) > Number(mx.value)) mx = r;
    }

    if (Number(mn.depth) <= Number(mx.depth)) out.push(mn, mx);
    else out.push(mx, mn);
  }

  const dedup = [];
  const seen = new Set();
  for (const r of out) {
    const k = `${r.depth}|${r.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(r);
  }
  return dedup;
}

export { downsampleMinmax };


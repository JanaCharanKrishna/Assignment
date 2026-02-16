const API_BASE = "http://localhost:5000";

const COLORS = [
  "#2563eb", "#16a34a", "#dc2626", "#7c3aed", "#ea580c", "#0891b2",
  "#ca8a04", "#db2777", "#0d9488", "#475569", "#4f46e5", "#65a30d",
];

function metricsQuery(metrics) {
  return metrics.map(encodeURIComponent).join(",");
}

function metricLabel(curve) {
  if (!curve) return "";
  const unit = curve.unit ? ` (${curve.unit})` : "";
  const track = curve.track ? ` [Track ${curve.track}]` : "";
  return `${curve.name}${unit}${track}`;
}

async function safeJson(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return API_BASE;
      }
    })();
    throw new Error(
      `Cannot reach backend (${origin}). Start backend and retry.`
    );
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(json?.error || "Request failed");
  return json;
}

export { API_BASE, COLORS, metricsQuery, metricLabel, safeJson };

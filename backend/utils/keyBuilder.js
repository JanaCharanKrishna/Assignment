import crypto from "crypto";

export function metricsHash(metrics = []) {
  const normalized = [...metrics].map(String).sort();
  return crypto.createHash("md5").update(normalized.join(",")).digest("hex").slice(0, 10);
}

export function overviewKey({ wellId, version, metrics, target }) {
  return `well:ov:${wellId}:v${version}:m${metricsHash(metrics)}:t${target}`;
}

export function windowKey({ wellId, version, metrics, from, to, px }) {
  const f = Number(from).toFixed(2);
  const t = Number(to).toFixed(2);
  const p = Math.max(200, Math.round(Number(px) || 1200));
  return `well:win:${wellId}:v${version}:m${metricsHash(metrics)}:${f}:${t}:px${p}`;
}

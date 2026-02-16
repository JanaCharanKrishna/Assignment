const API_BASE = import.meta.env.VITE_API_BASE?.trim() || "http://localhost:5000";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON for ${path}`);
  }
  if (!res.ok) {
    throw new Error(json?.error || `Request failed (${res.status})`);
  }
  return json;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function categoryFromMetric(metricName) {
  const metric = String(metricName || "").toLowerCase();
  if (/(h2s|co2|ch4|gas|hc)/.test(metric)) return "gas";
  if (/(pump|rpm|vib|motor|torque)/.test(metric)) return "pump";
  if (/(latency|packet|rssi|comm|network)/.test(metric)) return "comms";
  if (/(quality|null|missing|qc)/.test(metric)) return "qc";
  if (/(pressure|temp|flow|casing|process)/.test(metric)) return "pressure";
  return "process";
}

function computeMetricAnomaly(rows, metric) {
  const values = rows
    .map((row) => row?.values?.[metric])
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number);

  if (values.length < 12) {
    return {
      metric,
      score: 0,
      zScore: 0,
      nullPercent: 100,
      latest: null,
      category: categoryFromMetric(metric),
      reason: "Insufficient data",
    };
  }

  const m = average(values);
  const sd = stdDev(values, m);
  const latest = values[values.length - 1];
  const tail = values[Math.max(0, values.length - 15)] ?? latest;
  const zScore = sd > 1e-9 ? Math.abs((latest - m) / sd) : 0;
  const drift = sd > 1e-9 ? Math.abs(latest - tail) / sd : 0;

  const totalRows = rows.length || values.length;
  const nullPercent = clamp(((totalRows - values.length) / totalRows) * 100, 0, 100);

  const rawScore = zScore * 28 + drift * 12 + (nullPercent / 100) * 35;
  const score = Math.round(clamp(rawScore, 0, 100));

  return {
    metric,
    score,
    zScore: Number(zScore.toFixed(2)),
    nullPercent: Number(nullPercent.toFixed(1)),
    latest: Number(latest.toFixed(3)),
    category: categoryFromMetric(metric),
    reason: `${metric} is ${zScore.toFixed(2)} sigma from mean`,
  };
}

export function buildReportFromSnapshot(snapshot, {
  outputMode = "management",
  topRiskOnly = false,
  maxWells = 10,
} = {}) {
  const ranked = [...snapshot].sort((a, b) => b.riskScore - a.riskScore);
  const selected = topRiskOnly ? ranked.slice(0, Math.min(5, ranked.length)) : ranked.slice(0, maxWells);

  const avgHealth = selected.length
    ? average(selected.map((well) => well.healthScore))
    : 0;

  const critical = selected.filter((well) => well.riskScore >= 75).length;
  const warnings = selected.filter((well) => well.riskScore >= 50 && well.riskScore < 75).length;

  const reportId = `RPT-${Date.now().toString(36).toUpperCase()}`;

  return {
    meta: {
      reportId,
      createdAt: new Date().toISOString(),
      outputMode,
    },
    kpis: {
      totalWellsOnline: selected.length,
      avgHealth: Number(avgHealth.toFixed(1)),
      wellsWithCritical: critical,
      wellsWithWarnings: warnings,
    },
    rankedWells: selected,
    highlights: [
      selected[0]
        ? `Highest risk: ${selected[0].name} (${selected[0].riskScore}/100)`
        : "No wells available",
      `Critical wells: ${critical}`,
      `Average fleet health: ${avgHealth.toFixed(1)}`,
    ],
    recommendations: [
      "Investigate top two risk wells and validate sensor quality.",
      "Review interval trend drift for pump/pressure metrics.",
      "Run AI interpretation on highest-risk depth windows.",
    ],
  };
}

export function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = columns.map(escape).join(",");
  const body = rows
    .map((row) => columns.map((column) => escape(row[column])).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

export async function getFleetRiskSnapshot({ target = 800, maxMetrics = 6 } = {}) {
  const wellsJson = await fetchJson("/api/wells");
  const wells = Array.isArray(wellsJson?.wells) ? wellsJson.wells : [];

  const snapshots = await Promise.all(
    wells.map(async (well) => {
      const metrics = Array.isArray(well.metrics) ? well.metrics.slice(0, maxMetrics) : [];
      if (!metrics.length) {
        return {
          wellId: well.wellId,
          name: well.name || well.wellId,
          pointCount: Number(well.pointCount || 0),
          riskScore: 0,
          healthScore: 100,
          dominantMetric: "-",
          dominantCategory: "process",
          dominantReason: "No metrics",
          alertsCount: 0,
          anomalies: [],
        };
      }

      const queryMetrics = metrics.map(encodeURIComponent).join(",");
      const overview = await fetchJson(`/api/well/${encodeURIComponent(well.wellId)}/overview?metrics=${queryMetrics}&target=${target}`);
      const rows = Array.isArray(overview?.rows) ? overview.rows : [];

      const anomalies = metrics
        .map((metric) => computeMetricAnomaly(rows, metric))
        .sort((a, b) => b.score - a.score);

      const dominant = anomalies[0] || {
        metric: "-",
        category: "process",
        score: 0,
        reason: "No anomaly",
      };

      const riskScore = Math.round(
        clamp(
          average(anomalies.slice(0, 3).map((item) => item.score)) + (rows.length < 60 ? 8 : 0),
          0,
          100
        )
      );

      const alertsCount = anomalies.filter((item) => item.score >= 65).length;

      return {
        wellId: well.wellId,
        name: well.name || well.wellId,
        pointCount: Number(well.pointCount || rows.length || 0),
        riskScore,
        healthScore: Math.round(clamp(100 - riskScore, 0, 100)),
        dominantMetric: dominant.metric,
        dominantCategory: dominant.category,
        dominantReason: dominant.reason,
        alertsCount,
        anomalies,
      };
    })
  );

  return snapshots.sort((a, b) => b.riskScore - a.riskScore);
}
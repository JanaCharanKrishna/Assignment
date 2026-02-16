// frontend/src/services/api.js

const API_BASE =
  import.meta.env.VITE_API_BASE?.trim() || "http://localhost:5000";

/* =========================
   Generic helpers
========================= */

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toQueryString(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 60000,
  externalSignal
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }
}

function sanitizeFilePart(s) {
  return String(s || "report")
    .trim()
    .replace(/[^\w\-]+/g, "_")
    .slice(0, 80);
}

function triggerBrowserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* =========================
   Interpretation normalize
========================= */

function normalizeInterpretPayload({ wellId, fromDepth, toDepth, curves }) {
  const wid = String(wellId ?? "").trim();
  const lo = Number(fromDepth);
  const hi = Number(toDepth);
  const cv = Array.isArray(curves)
    ? curves.map((c) => String(c).trim()).filter(Boolean)
    : [];

  if (!wid) throw new Error("wellId is required");
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error("fromDepth and toDepth must be valid numbers");
  }
  if (cv.length === 0) throw new Error("At least one curve is required");

  return {
    wellId: wid,
    fromDepth: Math.min(lo, hi),
    toDepth: Math.max(lo, hi),
    curves: cv,
  };
}

function normalizeRun(raw = {}) {
  const runId = raw.runId ?? raw.run_id ?? raw.id ?? null;
  const wellId = raw.wellId ?? raw.well_id ?? raw.well?.wellId ?? null;

  const fromDepthRaw =
    raw.fromDepth ?? raw.from_depth ?? raw.range?.fromDepth ?? null;
  const toDepthRaw =
    raw.toDepth ?? raw.to_depth ?? raw.range?.toDepth ?? null;

  const fromDepth = Number(fromDepthRaw);
  const toDepth = Number(toDepthRaw);

  return {
    runId: runId ? String(runId) : null,
    wellId: wellId ? String(wellId) : null,
    fromDepth: Number.isFinite(fromDepth) ? fromDepth : null,
    toDepth: Number.isFinite(toDepth) ? toDepth : null,
    curves: Array.isArray(raw.curves) ? raw.curves : [],
    deterministic: raw.deterministic ?? null,
    insight: raw.insight ?? null,
    narrative: raw.narrative ?? null,
    modelUsed: raw.modelUsed ?? raw.model_used ?? null,
    narrativeStatus: raw.narrativeStatus ?? raw.narrative_status ?? null,
    createdAt: raw.createdAt ?? raw.created_at ?? null,
    source: raw.source ?? null,
  };
}

function normalizeInterpretResponse(json, reqPayload) {
  const out = { ...(json || {}) };

  if (
    !out.range ||
    !Number.isFinite(Number(out.range?.fromDepth)) ||
    !Number.isFinite(Number(out.range?.toDepth))
  ) {
    out.range = {
      fromDepth: reqPayload.fromDepth,
      toDepth: reqPayload.toDepth,
    };
  } else {
    out.range = {
      fromDepth: Number(out.range.fromDepth),
      toDepth: Number(out.range.toDepth),
    };
  }

  if (!out.deterministic || typeof out.deterministic !== "object") out.deterministic = {};
  if (!out.insight || typeof out.insight !== "object") out.insight = null;
  if (!out.narrative || typeof out.narrative !== "object") {
    out.narrative = {
      summary_bullets: [],
      interval_explanations: [],
      recommendations: [],
      limitations: [],
    };
  }

  out.narrative.summary_bullets = Array.isArray(out.narrative.summary_bullets)
    ? out.narrative.summary_bullets
    : [];
  out.narrative.interval_explanations = Array.isArray(out.narrative.interval_explanations)
    ? out.narrative.interval_explanations
    : [];
  out.narrative.recommendations = Array.isArray(out.narrative.recommendations)
    ? out.narrative.recommendations
    : [];
  out.narrative.limitations = Array.isArray(out.narrative.limitations)
    ? out.narrative.limitations
    : [];

  return out;
}

/* =========================
   Interpretation APIs
========================= */

export async function runAiInterpretation(
  { wellId, fromDepth, toDepth, curves },
  signal
) {
  const payload = normalizeInterpretPayload({ wellId, fromDepth, toDepth, curves });

  let res;
  try {
    res = await fetchWithTimeout(
      `${API_BASE}/api/ai/interpret`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      60000,
      signal
    );
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Interpretation request was cancelled or timed out");
    }
    throw new Error(err?.message || "Network error while calling interpretation API");
  }

  const text = await res.text();
  const json = tryParseJson(text);

  if (!res.ok) {
    throw new Error(
      json?.error ||
        json?.message ||
        (text && text.trim()) ||
        `Interpretation failed (${res.status})`
    );
  }

  if (!json || typeof json !== "object") {
    throw new Error("Server returned non-JSON response");
  }

  return normalizeInterpretResponse(json, payload);
}

export async function checkApiHealth(signal) {
  const res = await fetchWithTimeout(
    `${API_BASE}/api/health`,
    { method: "GET" },
    10000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);

  if (!res.ok) {
    throw new Error(json?.error || text || `Health check failed (${res.status})`);
  }
  return json ?? { ok: true };
}

export async function getInterpretationHistory(
  {
    wellId,
    limit = 20,
    offset = 0,
    fromDate,
    toDate,
    narrativeStatus,
  } = {},
  signal
) {
  const query = toQueryString({
    wellId,
    limit: Math.max(1, Math.min(100, Number(limit) || 20)),
    offset: Math.max(0, Number(offset) || 0),
    fromDate,
    toDate,
    narrativeStatus,
  });

  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/interpret/history${query}`,
    { method: "GET" },
    20000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);

  if (!res.ok) {
    throw new Error(json?.error || text || `History failed (${res.status})`);
  }

  const items = Array.isArray(json?.items) ? json.items.map(normalizeRun) : [];
  return { ...(json || {}), items };
}

export async function listInterpretationRuns(
  { wellId, limit = 20 } = {},
  signal
) {
  const query = toQueryString({
    wellId,
    limit: Math.max(1, Math.min(100, Number(limit) || 20)),
  });

  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/runs${query}`,
    { method: "GET" },
    20000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);

  if (!res.ok) {
    throw new Error(json?.error || text || `Failed to list runs (${res.status})`);
  }

  const rawRuns = Array.isArray(json?.runs) ? json.runs : [];
  const runs = rawRuns.map(normalizeRun).filter((r) => r.runId);
  return { ...(json || {}), runs };
}

export async function getInterpretationRun(runId, signal) {
  const rid = String(runId ?? "").trim();
  if (!rid) throw new Error("runId is required");

  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/runs/${encodeURIComponent(rid)}`,
    { method: "GET" },
    20000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);

  if (!res.ok) {
    throw new Error(json?.error || text || `Failed to fetch run (${res.status})`);
  }

  const rawRun = json?.run ?? json;
  const run = rawRun && typeof rawRun === "object" ? normalizeRun(rawRun) : null;

  return { ...(json || {}), run };
}

export async function deleteInterpretationRun(runId, signal) {
  const rid = String(runId ?? "").trim();
  if (!rid) throw new Error("runId is required");

  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/runs/${encodeURIComponent(rid)}`,
    { method: "DELETE" },
    20000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok) {
    throw new Error(json?.error || text || `Failed to delete run (${res.status})`);
  }

  return json ?? { ok: true, runId: rid };
}

export async function getInterpretationHistoryList(params = {}, signal) {
  return listInterpretationRuns(params, signal);
}

/* =========================
   Export APIs
========================= */

export function exportInterpretationJson(
  payload,
  filename = "interpretation_report.json"
) {
  const pretty = JSON.stringify(payload ?? {}, null, 2);
  const blob = new Blob([pretty], { type: "application/json;charset=utf-8" });
  triggerBrowserDownload(blob, filename);
}

export async function downloadInterpretationPdf(payload, signal) {
  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/interpret/export/pdf`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    },
    45000,
    signal
  );

  if (!res.ok) {
    const txt = await res.text();
    const json = tryParseJson(txt);
    throw new Error(json?.error || txt || `PDF export failed (${res.status})`);
  }

  const blob = await res.blob();
  const wellId = sanitizeFilePart(payload?.well?.wellId || payload?.wellId || "well");
  const filename = `interpretation_report_${wellId}.pdf`;
  triggerBrowserDownload(blob, filename);

  return { ok: true };
}

/* =========================
   Copilot API
========================= */

export async function askCopilot(payload, signal) {
  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/copilot/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
    40000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);

  if (!res.ok) {
    throw new Error(json?.error || json?.message || text || `Copilot failed (${res.status})`);
  }

  // Normalize response shape for CopilotPanel
  if (json && typeof json === "object") {
    return {
      ...json,
      json: json.json ?? json.result ?? json.answer ?? null,
      evidence: json.evidence ?? null,
      source: json.source ?? "unknown",
    };
  }

  return { ok: true, source: "unknown", json: null, evidence: null };
}

/* =========================
   Reports APIs
========================= */

export async function saveReportRecord(report, signal) {
  const res = await fetchWithTimeout(
    `${API_BASE}/api/reports`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report }),
    },
    20000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok) {
    throw new Error(json?.error || text || `Failed to save report (${res.status})`);
  }
  return json ?? { ok: true };
}

export async function listReportRecords({ limit = 50 } = {}, signal) {
  const query = toQueryString({
    limit: Math.max(1, Math.min(200, Number(limit) || 50)),
  });

  const res = await fetchWithTimeout(
    `${API_BASE}/api/reports${query}`,
    { method: "GET" },
    20000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok) {
    const raw = String(text || "");
    if (raw.includes("Cannot GET /api/reports")) {
      throw new Error("Reports API route is not available. Restart backend to load new /api/reports routes.");
    }
    throw new Error(json?.error || raw || `Failed to list reports (${res.status})`);
  }
  return json ?? { ok: true, reports: [] };
}

export async function getReportRecord(reportId, signal) {
  const rid = String(reportId ?? "").trim();
  if (!rid) throw new Error("reportId is required");

  const res = await fetchWithTimeout(
    `${API_BASE}/api/reports/${encodeURIComponent(rid)}`,
    { method: "GET" },
    20000,
    signal
  );

  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok) {
    const raw = String(text || "");
    if (raw.includes("Cannot GET /api/reports")) {
      throw new Error("Reports API route is not available. Restart backend to load new /api/reports routes.");
    }
    throw new Error(json?.error || raw || `Failed to load report (${res.status})`);
  }
  return json ?? { ok: true, report: null };
}

/* =========================
   Advanced analytics APIs
========================= */

export async function getIntervalDiff(payload, signal) {
  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/interval-diff`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
    60000,
    signal
  );
  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok || json?.ok === false) {
    const errorText = Array.isArray(json?.errors) ? json.errors.join(", ") : json?.error || text;
    throw new Error(errorText || `Interval diff failed (${res.status})`);
  }
  return json || { ok: true };
}

export async function getEventTimeline(
  { wellId, fromDepth, toDepth, bucketSize = 10, curves = [] },
  signal
) {
  const wid = String(wellId || "").trim();
  if (!wid) throw new Error("wellId is required");
  const query = toQueryString({
    fromDepth,
    toDepth,
    bucketSize,
    curves: Array.isArray(curves) ? curves.join(",") : "",
  });
  const res = await fetchWithTimeout(
    `${API_BASE}/api/well/${encodeURIComponent(wid)}/event-timeline${query}`,
    { method: "GET" },
    45000,
    signal
  );
  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok || json?.ok === false) {
    const errorText = Array.isArray(json?.errors) ? json.errors.join(", ") : json?.error || text;
    throw new Error(errorText || `Event timeline failed (${res.status})`);
  }
  return json || { ok: true, timeline: [] };
}

export async function getCrossplotMatrix(wellId, payload = {}, signal) {
  const wid = String(wellId || "").trim();
  if (!wid) throw new Error("wellId is required");
  const res = await fetchWithTimeout(
    `${API_BASE}/api/well/${encodeURIComponent(wid)}/crossplot-matrix`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
    60000,
    signal
  );
  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok || json?.ok === false) {
    const errorText = Array.isArray(json?.errors) ? json.errors.join(", ") : json?.error || text;
    throw new Error(errorText || `Crossplot failed (${res.status})`);
  }
  return json || { ok: true, plots: [] };
}

export async function submitIntervalFeedback(payload = {}, signal) {
  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/feedback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    20000,
    signal
  );
  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok || json?.ok === false) {
    const errorText = Array.isArray(json?.errors) ? json.errors.join(", ") : json?.error || text;
    throw new Error(errorText || `Feedback submit failed (${res.status})`);
  }
  return json || { ok: true };
}

export async function getIntervalFeedback({ wellId, from, to, limit = 100 } = {}, signal) {
  const query = toQueryString({ wellId, from, to, limit });
  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/feedback${query}`,
    { method: "GET" },
    20000,
    signal
  );
  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok || json?.ok === false) {
    const errorText = Array.isArray(json?.errors) ? json.errors.join(", ") : json?.error || text;
    throw new Error(errorText || `Feedback list failed (${res.status})`);
  }
  return json || { ok: true, items: [] };
}

export async function getIntervalFeedbackSummary({ wellId } = {}, signal) {
  const query = toQueryString({ wellId });
  const res = await fetchWithTimeout(
    `${API_BASE}/api/ai/feedback/summary${query}`,
    { method: "GET" },
    20000,
    signal
  );
  const text = await res.text();
  const json = tryParseJson(text);
  if (!res.ok || json?.ok === false) {
    const errorText = Array.isArray(json?.errors) ? json.errors.join(", ") : json?.error || text;
    throw new Error(errorText || `Feedback summary failed (${res.status})`);
  }
  return json || { ok: true, summary: { byLabel: {} } };
}

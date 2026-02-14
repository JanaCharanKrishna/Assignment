import express from "express";
import { callAiInterpret } from "../services/aiClient.js";
import {
  insertInterpretationRun,
  getInterpretationRunById,
  listInterpretationRuns,
} from "../repositories/interpretationRunsRepo.js";
// import { pgPool } from "../db/postgres.js"; // optional: only if you want /_db-check
import { jsonrepair } from "jsonrepair";
import PDFDocument from "pdfkit";



const router = express.Router();

const API_BASE = process.env.API_BASE || "http://localhost:5000";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

/** ---------- helpers ---------- **/

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmt(v, d = 3) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : "-";
}
function fmtInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : "-";
}
function safeArray(x) {
  return Array.isArray(x) ? x : [];
}
function riskMeta(risk) {
  const x = String(risk || "").toLowerCase();
  if (x.includes("critical")) return { label: "CRITICAL", color: "#991b1b", bg: "#fef2f2", border: "#fecaca" };
  if (x.includes("high")) return { label: "HIGH", color: "#9a3412", bg: "#fff7ed", border: "#fed7aa" };
  if (x.includes("moderate") || x.includes("med")) return { label: "MODERATE", color: "#92400e", bg: "#fffbeb", border: "#fde68a" };
  if (x.includes("low")) return { label: "LOW", color: "#065f46", bg: "#ecfdf5", border: "#a7f3d0" };
  return { label: String(risk || "UNKNOWN").toUpperCase(), color: "#1f2937", bg: "#f9fafb", border: "#e5e7eb" };
}
function drawRoundedRect(doc, x, y, w, h, r = 6, fill = null, stroke = null) {
  doc.save();
  if (fill) doc.fillColor(fill);
  if (stroke) doc.strokeColor(stroke);
  doc.roundedRect(x, y, w, h, r);
  if (fill && stroke) doc.fillAndStroke();
  else if (fill) doc.fill();
  else if (stroke) doc.stroke();
  doc.restore();
}
function drawSectionTitle(doc, title) {
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(title);
  doc.moveDown(0.25);
}
function ensureSpace(doc, needed = 80, top = 40, bottom = 45) {
  const pageBottom = doc.page.height - bottom;
  if (doc.y + needed > pageBottom) {
    doc.addPage();
    doc.y = top;
  }
}
function drawPageFooter(doc) {
  const oldBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const y = doc.page.height - 24;
  doc.fontSize(8).fillColor("#6b7280").text(`Page ${doc.page.number}`, 0, y, { align: "center" });
  doc.page.margins.bottom = oldBottom;
}

function normalizeIntervals(narrativeIntervals, deterministicIntervals) {
  const arr = safeArray(narrativeIntervals).length
    ? safeArray(narrativeIntervals)
    : safeArray(deterministicIntervals);

  return arr.map((it, idx) => ({
    idx: idx + 1,
    curve: String(it?.curve || "-"),
    fromDepth: toNum(it?.fromDepth),
    toDepth: toNum(it?.toDepth),
    priority: String(it?.priority || "-"),
    probability: String(it?.probability || "-"),
    stability: String(it?.stability || "-"),
    stabilityScore: toNum(it?.stabilityScore),
    confidence: toNum(it?.confidence),
    reason: String(it?.reason || ""),
    explanation: String(it?.explanation || ""),
    agreement: toNum(it?.agreement),
    width: toNum(it?.width),
  }));
}

function consolidateIntervals(intervals, gapTolerance = 8) {
  const valid = intervals
    .filter((x) => Number.isFinite(x.fromDepth) && Number.isFinite(x.toDepth))
    .map((x) => ({
      ...x,
      fromDepth: Math.min(x.fromDepth, x.toDepth),
      toDepth: Math.max(x.fromDepth, x.toDepth),
    }))
    .sort((a, b) => a.fromDepth - b.fromDepth);

  if (!valid.length) return [];

  const groups = [];
  let current = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = current[current.length - 1];
    const next = valid[i];
    if (next.fromDepth <= prev.toDepth + gapTolerance) current.push(next);
    else {
      groups.push(current);
      current = [next];
    }
  }
  groups.push(current);

  return groups.map((g, idx) => {
    const fromDepth = Math.min(...g.map((x) => x.fromDepth));
    const toDepth = Math.max(...g.map((x) => x.toDepth));
    const curves = [...new Set(g.map((x) => x.curve).filter(Boolean))];
    const priorities = [...new Set(g.map((x) => x.priority).filter(Boolean))];
    const probs = [...new Set(g.map((x) => x.probability).filter(Boolean))];
    const stabilities = [...new Set(g.map((x) => x.stability).filter(Boolean))];
    const confs = g.map((x) => x.confidence).filter(Number.isFinite);
    const avgConfidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

    return {
      compositeId: idx + 1,
      fromDepth,
      toDepth,
      width: toDepth - fromDepth,
      intervalCount: g.length,
      curves: curves.join(", "),
      dominantPriority: priorities[0] || "-",
      probabilityMix: probs.join(", ") || "-",
      stabilityMix: stabilities.join(", ") || "-",
      avgConfidence,
    };
  });
}


async function safeJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();

  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON from ${url}: ${text.slice(0, 220)}`);
  }

  if (!res.ok) {
    throw new Error(json?.error || `Request failed (${res.status})`);
  }
  return json;
}

function pickLimitations(det) {
  if (Array.isArray(det?.limitations)) return det.limitations;
  return ["Deterministic analysis only."];
}

/** deterministic interval -> narrative interval shape with enriched fields */
function detFindingToNarrativeInterval(f) {
  const reason = f?.reason || "anomaly";
  const score = f?.score;
  const conf = f?.confidence;

  return {
    curve: f?.curve ?? "",
    fromDepth: f?.fromDepth ?? null,
    toDepth: f?.toDepth ?? null,
    explanation:
      f?.explanation ??
      `${reason}, score: ${score ?? "-"}, confidence: ${conf ?? "-"}`,
    confidence: conf ?? null,
    priority: f?.priority || "watch",

    probability: f?.probability ?? null,
    stability: f?.stability ?? null,
    stabilityScore: f?.stabilityScore ?? null,
    agreement: f?.agreement ?? null,
    width: f?.width ?? null,
    curvesSupporting: f?.curvesSupporting ?? null,
    reason,
    score: score ?? null,
  };
}

function fallbackNarrativeFromDeterministic(deterministic) {
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];

  return {
    summary_bullets: deterministic?.summary || [],
    interval_explanations: detIntervals.map(detFindingToNarrativeInterval),
    recommendations: deterministic?.recommendations || [],
    limitations: pickLimitations(deterministic),
  };
}

/** Extract JSON object safely from LLM content */
function parseJsonFromModelContent(content) {
  const candidates = [];

  // A) raw content
  if (typeof content === "string" && content.trim()) {
    candidates.push(content.trim());
  }

  // B) fenced block
  const fenceMatch = content?.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  // C) largest {...} slice
  const start = content?.indexOf("{");
  const end = content?.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(content.slice(start, end + 1).trim());
  }

  for (const raw of candidates) {
    // 1) strict parse
    try {
      return JSON.parse(raw);
    } catch {
      // continue
    }

    // 2) repair then parse
    try {
      const repaired = jsonrepair(raw);
      return JSON.parse(repaired);
    } catch {
      // continue
    }
  }

  throw new Error("Model content is not valid/repairable JSON");
}


function num(x, def = NaN) {
  const v = Number(x);
  return Number.isFinite(v) ? v : def;
}

/** Similarity score for interval matching (LLM interval -> deterministic interval) */
function intervalSimilarity(a, b) {
  const a0 = num(a?.fromDepth);
  const a1 = num(a?.toDepth);
  const b0 = num(b?.fromDepth);
  const b1 = num(b?.toDepth);
  if (![a0, a1, b0, b1].every(Number.isFinite)) return -Infinity;

  const aCurve = String(a?.curve ?? "");
  const bCurve = String(b?.curve ?? "");

  const midA = (a0 + a1) / 2;
  const midB = (b0 + b1) / 2;
  const widthA = Math.abs(a1 - a0);
  const widthB = Math.abs(b1 - b0);

  const midDist = Math.abs(midA - midB);
  const widthDist = Math.abs(widthA - widthB);

  // smaller distance is better; add curve-match bonus
  let score = -midDist - 0.35 * widthDist;
  if (aCurve && bCurve && aCurve === bCurve) score += 12;
  if (aCurve && bCurve && (aCurve.includes(bCurve) || bCurve.includes(aCurve)))
    score += 6;

  return score;
}

/**
 * Merge LLM intervals with deterministic intervals so required fields are always present.
 * Also appends deterministic intervals that LLM might have dropped.
 */
function mergeNarrativeIntervals(llmIntervals, deterministic) {
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];

  const detNormalized = detIntervals.map(detFindingToNarrativeInterval);

  if (!Array.isArray(llmIntervals) || llmIntervals.length === 0) {
    return detNormalized;
  }

  const merged = llmIntervals.map((it) => {
    let best = null;
    let bestScore = -Infinity;

    for (const d of detNormalized) {
      const s = intervalSimilarity(it, d);
      if (s > bestScore) {
        bestScore = s;
        best = d;
      }
    }

    const d = best;

    return {
      curve: it?.curve ?? d?.curve ?? "",
      fromDepth: it?.fromDepth ?? d?.fromDepth ?? null,
      toDepth: it?.toDepth ?? d?.toDepth ?? null,
      explanation:
        it?.explanation ??
        d?.explanation ??
        "Anomalous behavior observed; validate with adjacent data.",
      confidence: it?.confidence ?? d?.confidence ?? null,
      priority: it?.priority ?? d?.priority ?? "watch",

      probability: it?.probability ?? d?.probability ?? null,
      stability: it?.stability ?? d?.stability ?? null,
      stabilityScore: it?.stabilityScore ?? d?.stabilityScore ?? null,
      agreement: it?.agreement ?? d?.agreement ?? null,
      width: it?.width ?? d?.width ?? null,
      curvesSupporting: it?.curvesSupporting ?? d?.curvesSupporting ?? null,
      reason: it?.reason ?? d?.reason ?? null,
      score: it?.score ?? d?.score ?? null,
    };
  });

  // append deterministic intervals not represented by merged LLM intervals
  const usedKeys = new Set(
    merged.map(
      (m) =>
        `${Math.round(num(m.fromDepth, -1))}::${Math.round(
          num(m.toDepth, -1)
        )}::${String(m.curve || "")}`
    )
  );

  for (const d of detNormalized) {
    const k = `${Math.round(num(d.fromDepth, -1))}::${Math.round(
      num(d.toDepth, -1)
    )}::${String(d.curve || "")}`;
    if (!usedKeys.has(k)) merged.push(d);
  }

  return merged.slice(0, 12);
}

/** Optional LLM polish for narrative */
async function maybeGroqNarrative({
  deterministic,
  insight,
  curves,
  fromDepth,
  toDepth,
  wellId,
}) {
  const detIntervals = Array.isArray(deterministic?.intervalFindings)
    ? deterministic.intervalFindings
    : [];

  if (!GROQ_API_KEY) {
    return {
      modelUsed: null,
      narrativeStatus:
        detIntervals.length === 0
          ? "fallback_no_api_key_no_events"
          : "fallback_no_api_key",
      narrative: fallbackNarrativeFromDeterministic(deterministic),
    };
  }

  const topIntervals = detIntervals.slice(0, 6).map((f) => ({
    curve: f.curve,
    fromDepth: f.fromDepth,
    toDepth: f.toDepth,
    reason: f.reason,
    score: f.score,
    confidence: f.confidence,
    priority: f.priority,
    probability: f.probability ?? null,
    stability: f.stability ?? null,
    stabilityScore: f.stabilityScore ?? null,
    agreement: f.agreement ?? null,
    width: f.width ?? null,
    curvesSupporting: f.curvesSupporting ?? null,
  }));

  const prompt = `
You are a petroleum/well-log interpretation assistant.

Return STRICT JSON with keys:
- summary_bullets: string[]
- interval_explanations: [{curve,fromDepth,toDepth,explanation,confidence,priority,probability,stability,stabilityScore,agreement,width,curvesSupporting,reason,score}]
- recommendations: string[]
- limitations: string[]

Context:
Well: ${wellId}
Range: ${fromDepth} to ${toDepth}
Curves: ${curves.join(", ")}

Deterministic:
anomalyScore=${deterministic?.anomalyScore}
detectionConfidence=${deterministic?.detectionConfidence}
severityConfidence=${deterministic?.severityConfidence}
severityBand=${deterministic?.severityBand}
eventCount=${deterministic?.eventCount}
eventDensityPer1000ft=${deterministic?.eventDensityPer1000ft}

Insight summary:
${insight?.summaryParagraph || ""}

Top intervals:
${JSON.stringify(topIntervals)}

Rules:
- Use cautious language: "suggests", "likely", "requires validation"
- Do NOT claim lab-confirmed fluid type
- Keep recommendations concise and operational
- IMPORTANT: If eventCount is 0, interval_explanations MUST be []
`.trim();

  const body = {
    model: GROQ_MODEL,
    temperature: 0.2,
    top_p: 1,
    max_completion_tokens: 900,
    stream: false,
    messages: [
      { role: "system", content: "Return valid JSON only." },
      { role: "user", content: prompt },
    ],
  };

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const txt = await res.text();

    let envelope;
    try {
      envelope = JSON.parse(txt);
    } catch {
      throw new Error("groq_envelope_non_json");
    }

    if (!res.ok) {
      const msg =
        envelope?.error?.message ||
        envelope?.error ||
        `Groq failed (${res.status})`;
      throw new Error(`groq_http_error:${msg}`);
    }

    const content = envelope?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonFromModelContent(content);

    // hard guard
    const mergedIntervals =
      detIntervals.length === 0
        ? []
        : mergeNarrativeIntervals(parsed?.interval_explanations, deterministic);

    return {
      modelUsed: GROQ_MODEL,
      narrativeStatus: detIntervals.length === 0 ? "deterministic_no_events" : "ok",
      narrative: {
        summary_bullets: parsed?.summary_bullets || deterministic?.summary || [],
        interval_explanations: mergedIntervals,
        recommendations:
          parsed?.recommendations || deterministic?.recommendations || [],
        limitations: parsed?.limitations || pickLimitations(deterministic),
      },
    };
  } catch (e) {
    console.warn("Groq narrative fallback:", e?.message || e);

    return {
      modelUsed: GROQ_MODEL,
      narrativeStatus:
        detIntervals.length === 0 ? "llm_unavailable_no_events" : "llm_unavailable",
      narrative: fallbackNarrativeFromDeterministic(deterministic),
    };
  }
}

/** ---------- routes ---------- **/

// Optional DB ping route (enable only if needed)
// router.get("/_db-check", async (_req, res) => {
//   try {
//     const r = await pgPool.query("SELECT NOW() as now");
//     res.json({ ok: true, now: r.rows[0].now });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

/**
 * POST /api/ai/interpret
 * Runs deterministic + optional LLM narrative, persists run, returns live result.
 */
router.post("/interpret", async (req, res) => {
  try {
    const { wellId, fromDepth, toDepth, curves } = req.body || {};

    if (!wellId) {
      return res.status(400).json({ error: "wellId is required" });
    }

    if (!Array.isArray(curves) || curves.length === 0) {
      return res.status(400).json({ error: "curves must be a non-empty array" });
    }

    if (!Number.isFinite(Number(fromDepth)) || !Number.isFinite(Number(toDepth))) {
      return res
        .status(400)
        .json({ error: "fromDepth/toDepth must be valid numbers" });
    }

    const lo = Math.min(Number(fromDepth), Number(toDepth));
    const hi = Math.max(Number(fromDepth), Number(toDepth));
    const metrics = curves.map(encodeURIComponent).join(",");

    // 1) try fast window endpoint
    let rowsPayload;
    try {
      rowsPayload = await safeJson(
        `${API_BASE}/api/well/${encodeURIComponent(
          wellId
        )}/window?metrics=${metrics}&from=${lo}&to=${hi}&px=4000`
      );
    } catch {
      // 2) fallback: full data then filter
      const dataPayload = await safeJson(
        `${API_BASE}/api/well/${encodeURIComponent(wellId)}/data`
      );
      const allRows = Array.isArray(dataPayload?.rows) ? dataPayload.rows : [];
      rowsPayload = {
        rows: allRows.filter((r) => {
          const d = Number(r?.depth);
          return Number.isFinite(d) && d >= lo && d <= hi;
        }),
      };
    }

    const rows = Array.isArray(rowsPayload?.rows) ? rowsPayload.rows : [];
    if (rows.length < 20) {
      return res
        .status(400)
        .json({ error: `Not enough rows in selected range. Got ${rows.length}` });
    }

    // deterministic (python service)
    const ai = await callAiInterpret({
      wellId,
      fromDepth: lo,
      toDepth: hi,
      curves,
      rows,
    });

    // supports both response shapes
    const deterministic = ai?.deterministic || ai || {};
    const insight = ai?.insight || null;

    // optional narrative via Groq
    const nar = await maybeGroqNarrative({
      deterministic,
      insight,
      curves,
      fromDepth: lo,
      toDepth: hi,
      wellId,
    });

    // SINGLE INSERT (no duplicates)
    const runRecord = await insertInterpretationRun({
      wellId,
      fromDepth: lo,
      toDepth: hi,
      curves,
      deterministic,
      insight,
      narrative: nar.narrative,
      modelUsed: nar.modelUsed,
      narrativeStatus: nar.narrativeStatus,
      source: "fresh",
      appVersion: process.env.APP_VERSION || null,
    });

    return res.json({
      ok: true,
      source: "fresh",
      runId: runRecord?.runId ?? runRecord?.run_id ?? null,
      createdAt: runRecord?.createdAt ?? runRecord?.created_at ?? new Date().toISOString(),
      well: { wellId, name: wellId },
      range: { fromDepth: lo, toDepth: hi },
      curves,
      deterministic,
      insight,
      narrative: nar.narrative,
      modelUsed: nar.modelUsed,
      narrativeStatus: nar.narrativeStatus,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("POST /api/ai/interpret failed:", err);
    return res.status(500).json({ error: err?.message || "Interpretation failed" });
  }
});

/**
 * GET /api/ai/runs
 * History list (optional well filter)
 */
router.get("/runs", async (req, res) => {
  try {
    const wellId = req.query.wellId ? String(req.query.wellId) : undefined;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, limitRaw))
      : 20;

    const runs = await listInterpretationRuns({ wellId, limit });
    return res.json({ ok: true, runs });
  } catch (err) {
    console.error("GET /api/ai/runs failed:", err);
    return res.status(500).json({ error: err?.message || "Failed to list runs" });
  }
});


/**
 * GET /api/ai/runs/:runId
 * Replay one historical run
 */
router.get("/runs/:runId", async (req, res) => {
  try {
    const { runId } = req.params;
    const row = await getInterpretationRunById(runId);

    if (!row) return res.status(404).json({ error: "Run not found" });

    // normalize snake_case or camelCase
    const run = {
      runId: row.runId ?? row.run_id,
      wellId: row.wellId ?? row.well_id,
      fromDepth: row.fromDepth ?? row.from_depth,
      toDepth: row.toDepth ?? row.to_depth,
      curves: row.curves ?? [],
      deterministic: row.deterministic ?? null,
      insight: row.insight ?? null,
      narrative: row.narrative ?? null,
      modelUsed: row.modelUsed ?? row.model_used ?? null,
      narrativeStatus: row.narrativeStatus ?? row.narrative_status ?? null,
      source: row.source ?? null,
      createdAt: row.createdAt ?? row.created_at ?? null,
    };

    return res.json({ ok: true, run });
  } catch (err) {
    console.error("GET /api/ai/runs/:runId failed:", err);
    return res.status(500).json({ error: err?.message || "Failed to fetch run" });
  }
});


router.post("/interpret/export/pdf", async (req, res) => {
  let doc = null;

  try {
    // Compute/validate first (before pipe)
    const payload = req.body || {};
    const wellId = String(payload?.well?.wellId || payload?.wellId || "-");
    const range = payload?.range || {};
    const fromDepth = toNum(range?.fromDepth ?? payload?.fromDepth);
    const toDepth = toNum(range?.toDepth ?? payload?.toDepth);

    const modelUsed = String(payload?.modelUsed || "-");
    const narrativeStatus = String(payload?.narrativeStatus || "-");
    const createdAtIso = payload?.createdAt || new Date().toISOString();
    const exportedAtIso = new Date().toISOString();

    const deterministic = payload?.deterministic || {};
    const narrative = payload?.narrative || {};
    const insight = payload?.insight || {};

    const severityBand = deterministic?.severityBand || "UNKNOWN";
    const rMeta = riskMeta(severityBand);

    const intervals = normalizeIntervals(
      narrative?.interval_explanations,
      deterministic?.intervalFindings
    );
    const topIntervals = intervals.slice(0, 10);
    const consolidated = consolidateIntervals(topIntervals, 8);

    const recommendations = safeArray(narrative?.recommendations);
    const limitations = safeArray(narrative?.limitations);

    const filename = `interpretation_report_${wellId}_${Date.now()}.pdf`;

    // Start streaming only after all above variables are ready
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, left: 40, right: 40, bottom: 45 },
      bufferPages: true,
      info: {
        Title: `Interpretation Report - ${wellId}`,
        Author: "AI Interpretation Service",
        Subject: "Well Log Interpretation",
      },
    });

    // stream safety
    doc.on("error", (e) => {
      console.error("PDFKit error:", e);
      if (!res.headersSent) {
        res.status(500).json({ error: "PDF generation failed" });
      } else {
        try { res.end(); } catch {}
      }
    });

    // if client disconnects early
    res.on("close", () => {
      if (doc && !doc.destroyed) {
        try { doc.end(); } catch {}
      }
    });

    doc.pipe(res);

    // ===== Header =====
    drawRoundedRect(doc, 40, 38, 515, 92, 8, "#f8fafc", "#e5e7eb");
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111827")
      .text("AI Interpretation Report", 54, 50);
    doc.font("Helvetica").fontSize(10).fillColor("#374151")
      .text("Automated well-log interpretation with deterministic + narrative analysis", 54, 74);

    drawRoundedRect(doc, 425, 50, 112, 26, 12, rMeta.bg, rMeta.border);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(rMeta.color)
      .text(`RISK: ${rMeta.label}`, 432, 58, { width: 98, align: "center" });

    doc.y = 140;

    // ===== Meta =====
    drawRoundedRect(doc, 40, doc.y, 515, 78, 6, "#ffffff", "#e5e7eb");
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Well", 52, doc.y + 12);
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(wellId, 160, doc.y + 11);

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Depth Range", 52, doc.y + 28);
    doc.font("Helvetica").fontSize(10).fillColor("#111827")
      .text(`${fmtInt(fromDepth)} → ${fmtInt(toDepth)} ft`, 160, doc.y + 27);

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Model", 52, doc.y + 44);
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(modelUsed, 160, doc.y + 43);

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Narrative Status", 52, doc.y + 60);
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(narrativeStatus, 160, doc.y + 59);

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Run Time", 322, doc.y + 12);
    doc.font("Helvetica").fontSize(10).fillColor("#111827")
      .text(new Date(createdAtIso).toLocaleString(), 395, doc.y + 11, { width: 150 });

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Export Time", 322, doc.y + 28);
    doc.font("Helvetica").fontSize(10).fillColor("#111827")
      .text(new Date(exportedAtIso).toLocaleString(), 395, doc.y + 27, { width: 150 });

    doc.y += 88;

    // ===== Executive Summary =====
    drawSectionTitle(doc, "Executive Summary");
    ensureSpace(doc, 90);

    const cardsY = doc.y;
    const gap = 10;
    const cardW = (515 - gap * 4) / 5;
    const cardH = 58;
    const cards = [
      { title: "Global Risk", value: rMeta.label, color: rMeta.color, bg: rMeta.bg, border: rMeta.border },
      { title: "Events", value: String(deterministic?.eventCount ?? "-"), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
      { title: "Detect Conf", value: fmt(deterministic?.detectionConfidence ?? deterministic?.confidence, 3), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
      { title: "Severity Conf", value: fmt(deterministic?.severityConfidence, 3), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
      { title: "Data Quality", value: String(deterministic?.dataQuality?.qualityBand || "-").toUpperCase(), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
    ];

    cards.forEach((c, i) => {
      const x = 40 + i * (cardW + gap);
      drawRoundedRect(doc, x, cardsY, cardW, cardH, 6, c.bg, c.border);
      doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(c.title, x + 8, cardsY + 8, { width: cardW - 16 });
      doc.font("Helvetica-Bold").fontSize(12).fillColor(c.color).text(c.value, x + 8, cardsY + 24, { width: cardW - 16, ellipsis: true });
    });

    doc.y = cardsY + cardH + 8;

    if (insight?.summaryParagraph) {
      ensureSpace(doc, 65);
      drawRoundedRect(doc, 40, doc.y, 515, 54, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text("Interpretation Summary", 50, doc.y + 8);
      doc.font("Helvetica").fontSize(9.5).fillColor("#374151")
        .text(String(insight.summaryParagraph), 50, doc.y + 24, { width: 495, height: 24, ellipsis: true });
      doc.y += 62;
    }

    // ===== Top Intervals (simple list/table-like) =====
    drawSectionTitle(doc, "Top Intervals");
    ensureSpace(doc, 70);

    if (!topIntervals.length) {
      drawRoundedRect(doc, 40, doc.y, 515, 34, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("No key intervals detected for this run.", 52, doc.y + 11);
      doc.y += 44;
    } else {
      topIntervals.forEach((it, i) => {
        ensureSpace(doc, 26);
        drawRoundedRect(doc, 40, doc.y, 515, 22, 4, i % 2 === 0 ? "#ffffff" : "#fafafa", "#eef2f7");
        doc.font("Helvetica").fontSize(8.7).fillColor("#111827")
          .text(
            `${i + 1}. ${it.curve || "-"} | ${fmtInt(it.fromDepth)} → ${fmtInt(it.toDepth)} ft | Priority: ${it.priority || "-"} | Prob: ${it.probability || "-"} | Conf: ${fmt(it.confidence, 2)}`,
            48,
            doc.y + 7,
            { width: 500, ellipsis: true }
          );
        doc.y += 24;
      });
      doc.y += 4;
    }

    // ===== Consolidated =====
    drawSectionTitle(doc, "Consolidated Intervals (Composite)");
    ensureSpace(doc, 60);

    if (!consolidated.length) {
      drawRoundedRect(doc, 40, doc.y, 515, 34, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("No composite intervals available.", 52, doc.y + 11);
      doc.y += 44;
    } else {
      consolidated.forEach((c, i) => {
        ensureSpace(doc, 26);
        drawRoundedRect(doc, 40, doc.y, 515, 22, 4, i % 2 === 0 ? "#ffffff" : "#f8fafc", "#e5e7eb");
        doc.font("Helvetica").fontSize(8.7).fillColor("#111827")
          .text(
            `C${c.compositeId} | ${fmtInt(c.fromDepth)} → ${fmtInt(c.toDepth)} ft | N=${c.intervalCount} | Width=${fmt(c.width, 1)} | Priority=${c.dominantPriority} | AvgConf=${fmt(c.avgConfidence, 2)} | Curves=${c.curves || "-"}`,
            48,
            doc.y + 7,
            { width: 500, ellipsis: true }
          );
        doc.y += 24;
      });
      doc.y += 4;
    }

    // ===== Recommendations =====
    drawSectionTitle(doc, "Recommendations");
    ensureSpace(doc, 45);
    if (!recommendations.length) {
      drawRoundedRect(doc, 40, doc.y, 515, 34, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("No recommendations provided.", 52, doc.y + 11);
      doc.y += 44;
    } else {
      const h = Math.max(38, recommendations.length * 16 + 16);
      drawRoundedRect(doc, 40, doc.y, 515, h, 6, "#ffffff", "#e5e7eb");
      let y = doc.y + 10;
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      recommendations.forEach((r, i) => {
        doc.text(`${i + 1}. ${String(r)}`, 52, y, { width: 490 });
        y += 16;
      });
      doc.y = y + 2;
    }

    // ===== Limitations =====
    drawSectionTitle(doc, "Limitations");
    ensureSpace(doc, 45);
    if (!limitations.length) {
      drawRoundedRect(doc, 40, doc.y, 515, 34, 6, "#ffffff", "#e5e7eb");
      doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("No limitations provided.", 52, doc.y + 11);
      doc.y += 44;
    } else {
      const h = Math.max(38, limitations.length * 16 + 16);
      drawRoundedRect(doc, 40, doc.y, 515, h, 6, "#ffffff", "#e5e7eb");
      let y = doc.y + 10;
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      limitations.forEach((l, i) => {
        doc.text(`${i + 1}. ${String(l)}`, 52, y, { width: 490 });
        y += 16;
      });
      doc.y = y + 2;
    }

    // Footers all pages
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      drawPageFooter(doc);
    }

    doc.end();
  } catch (err) {
    console.error("POST /api/ai/interpret/export/pdf failed:", err);

    // DO NOT write JSON if stream already started
    if (!res.headersSent) {
      return res.status(500).json({ error: err?.message || "PDF export failed" });
    }

    // If already streaming, just end safely
    try { res.end(); } catch {}
  }
});



export default router;

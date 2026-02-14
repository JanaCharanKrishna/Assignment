import express from "express";
import { callAiInterpret } from "../services/aiClient.js";
import {
  insertInterpretationRun,
  getInterpretationRunById,
  listInterpretationRuns,
} from "../repositories/interpretationRunsRepo.js";
// import { pgPool } from "../db/postgres.js"; // optional: only if you want /_db-check
import { jsonrepair } from "jsonrepair";


const router = express.Router();

const API_BASE = process.env.API_BASE || "http://localhost:5000";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

/** ---------- helpers ---------- **/

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

export default router;

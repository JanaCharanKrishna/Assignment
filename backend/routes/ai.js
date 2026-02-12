// backend/routes/ai.js
import express from "express";
import crypto from "crypto";
import { z } from "zod";
import { callAiInterpret } from "../services/aiClient.js";
import { buildNarrativeWithFallback } from "../services/llmClient.js";
import { getDb } from "../db/mongo.js";
import { getRedis } from "../db/redis.js";

const router = express.Router();

const BodySchema = z.object({
  wellId: z.string().min(1),
  fromDepth: z.number(),
  toDepth: z.number(),
  curves: z.array(z.string()).min(1).max(12),
});

function hashCurves(curves) {
  return crypto
    .createHash("sha1")
    .update([...curves].sort().join("|"))
    .digest("hex")
    .slice(0, 12);
}

router.post("/interpret", async (req, res) => {
  try {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
    }

    const { wellId, fromDepth, toDepth, curves } = parsed.data;
    const lo = Math.min(fromDepth, toDepth);
    const hi = Math.max(fromDepth, toDepth);

    const db = getDb();
    const redis = getRedis();

    // Get well metadata
    const well = await db.collection("wells").findOne(
      { wellId },
      { projection: { _id: 0, wellId: 1, name: 1, version: 1 } }
    );
    if (!well) return res.status(404).json({ error: "Well not found" });

    const cacheKey = `ai:v1:${wellId}:ver:${well.version ?? 1}:d:${lo}-${hi}:c:${hashCurves(curves)}`;

    // Cache hit
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ ok: true, source: "redis", ...JSON.parse(cached) });
    }

    // Pull rows for selected window
    const docs = await db
      .collection("well_points")
      .find(
        { wellId, depth: { $gte: lo, $lte: hi } },
        { projection: { _id: 0, depth: 1, values: 1 } }
      )
      .sort({ depth: 1 })
      .toArray();

    if (!docs.length) {
      return res.status(400).json({ error: "No rows found in selected depth range" });
    }

    // Keep only selected curves
    const rows = docs.map((d) => {
      const values = {};
      for (const c of curves) values[c] = d?.values?.[c] ?? null;
      return { depth: d.depth, values };
    });

    // 1) Deterministic analysis from Python
    const deterministic = await callAiInterpret({
      wellId,
      fromDepth: lo,
      toDepth: hi,
      curves,
      rows,
    });

    // 2) Narrative from LLM (fallback chain)
    let narrative;
    let modelUsed = null;
    let narrativeStatus = "ok";

    try {
      const out = await buildNarrativeWithFallback({
        wellId,
        fromDepth: lo,
        toDepth: hi,
        curves,
        deterministic,
      });
      narrative = out.narrative;
      modelUsed = out.modelUsed;
    } catch {
      narrativeStatus = "llm_unavailable";
      narrative = {
        summary_bullets: deterministic?.summary || [
          "Deterministic interpretation generated; narrative model unavailable."
        ],
        interval_explanations: (deterministic?.intervalFindings || []).slice(0, 8).map((x) => ({
          curve: x.curve,
          fromDepth: x.fromDepth,
          toDepth: x.toDepth,
          explanation: x.reason || "Anomalous interval detected.",
          confidence: x.confidence ?? deterministic?.confidence ?? 0.6,
        })),
        recommendations: deterministic?.recommendations || ["Review flagged intervals manually."],
        limitations: ["Narrative fallback due to LLM unavailability."],
      };
    }

    const payload = {
      well: { wellId: well.wellId, name: well.name },
      range: { fromDepth: lo, toDepth: hi },
      curves,
      deterministic,
      narrative,
      modelUsed,
      narrativeStatus,
      generatedAt: new Date().toISOString(),
    };

    // Write cache + history
    await redis.set(cacheKey, JSON.stringify(payload), { EX: 6 * 60 * 60 }); // 6h
    await db.collection("interpretations").insertOne({
      ...payload,
      cacheKey,
      createdAt: new Date(),
    });

    return res.json({ ok: true, source: "fresh", ...payload });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Interpretation failed" });
  }
});

export default router;

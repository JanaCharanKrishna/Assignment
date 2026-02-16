import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { getDb } from "../db/mongo.js";
import { parseLasText } from "../parsers/ParseLas.js";
import { cacheGetJson, cacheSetJson } from "../cache/redisCache.js";
import { overviewKey, windowKey } from "../utils/keyBuilder.js";
import { downsampleMinMax } from "../utils/downsample.js";
import { getRedis } from "../db/redis.js";
import { buildWindowPlan } from "../services/windowPlanService.js";
import { fetchWindowData } from "../services/windowFetchService.js";


const router = express.Router();
const upload = multer({ dest: "uploads/" });

function sanitizeValues(valuesObj) {
  const out = {};
  for (const [k, v] of Object.entries(valuesObj || {})) {
    const num = Number(v);
    if (!Number.isFinite(num) || num <= -999) out[k] = null;
    else out[k] = num;
  }
  return out;
}

/**
 * POST /api/las/upload
 * form-data key: file
 */
router.post("/las/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. form-data key must be 'file'" });
    }

    const db = getDb();
    const wellsCol = db.collection("wells");
    const pointsCol = db.collection("well_points");

    const text = await fs.readFile(req.file.path, "utf8");
    await fs.unlink(req.file.path).catch(() => {});

    const parsed = parseLasText(text);

    const wellId = `WELL_${Date.now()}`;
    const name = path.parse(req.file.originalname).name || wellId;

    // metrics: all curves except depth curve (assume first is depth)
    const metricIds = parsed.curves.slice(1).map((c) => c.id);

    // version for this new well
    const version = 1;

    // store metadata
    await wellsCol.insertOne({
      wellId,
      name,
      metrics: metricIds,
      curves: parsed.curves,
      minDepth: parsed.minDepth,
      maxDepth: parsed.maxDepth,
      nullValue: parsed.nullValue,
      depthCurveId: parsed.depthCurveId,
      pointCount: parsed.rows.length,
      version,
      createdAt: new Date(),
    });

    // store points in bulk
    // NOTE: one doc per row (range-query friendly)
    const bulk = pointsCol.initializeUnorderedBulkOp();

    for (const r of parsed.rows) {
      bulk.insert({
        wellId,
        depth: Number(r.depth),
        values: sanitizeValues(r.curves),
      });
    }

    if (parsed.rows.length) await bulk.execute();

    return res.json({
      ok: true,
      well: { wellId, name, version },
      metrics: metricIds,
      points: parsed.rows.length,
      meta: { minDepth: parsed.minDepth, maxDepth: parsed.maxDepth, nullValue: parsed.nullValue },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Upload/parse/store failed" });
  }
});



/**
 * GET /api/well/:wellId/overview?metrics=HC1,HC2&target=1200
 */
router.get("/well/:wellId/overview", async (req, res) => {
  try {
    const { wellId } = req.params;
    const db = getDb();

    const well = await db.collection("wells").findOne({ wellId }, { projection: { _id: 0 } });
    if (!well) return res.status(404).json({ error: "Well not found" });

    const metrics =
      String(req.query.metrics || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((m) => well.metrics.includes(m));

    const chosen = metrics.length ? metrics : well.metrics.slice(0, 1);
    const target = Math.max(200, Math.min(5000, Number(req.query.target) || 1200));

    const key = overviewKey({ wellId, version: well.version, metrics: chosen, target });

    const cached = await cacheGetJson(key);
    if (cached) {
      return res.json({ ...cached, source: "redis" });
    }

    // Fetch all depths but only keep chosen metrics
    const docs = await db
      .collection("well_points")
      .find({ wellId }, { projection: { _id: 0, depth: 1, values: 1 } })
      .sort({ depth: 1 })
      .toArray();

    const rows = docs.map((d) => {
      const values = {};
      for (const m of chosen) values[m] = d.values?.[m] ?? null;
      return { depth: d.depth, values };
    });

    const sampled = downsampleMinMax(rows, chosen, target);

    const payload = {
      well: { wellId: well.wellId, name: well.name, version: well.version },
      metrics: chosen,
      meta: { minDepth: well.minDepth, maxDepth: well.maxDepth, pointCount: well.pointCount },
      rows: sampled,
    };

    // overview can live longer
    await cacheSetJson(key, payload, 60 * 60); // 1 hour
    return res.json({ ...payload, source: "mongo" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "overview failed" });
  }
});

/**
 * GET /api/well/:wellId/window?metrics=HC1,HC2&from=1000&to=1200&px=1200
 */
router.get("/well/:wellId/window", async (req, res) => {
  try {
    const { wellId } = req.params;
    const db = getDb();

    const well = await db.collection("wells").findOne({ wellId }, { projection: { _id: 0 } });
    if (!well) return res.status(404).json({ error: "Well not found" });

    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return res.status(400).json({ error: "from and to are required numbers" });
    }

    const left = Math.min(from, to);
    const right = Math.max(from, to);

    const metrics =
      String(req.query.metrics || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((m) => well.metrics.includes(m));

    const chosen = metrics.length ? metrics : well.metrics.slice(0, 1);

    // px determines desired point count (roughly 1-2 pts per px is too much; keep cap)
    const px = Math.max(200, Math.min(5000, Number(req.query.px) || 1200));
    const target = Math.max(200, Math.min(3000, Math.round(px))); // clamp to 3k

    const key = windowKey({
      wellId,
      version: well.version,
      metrics: chosen,
      from: left,
      to: right,
      px,
    });

    const cached = await cacheGetJson(key);
    if (cached) return res.json({ ...cached, source: "redis" });

    const docs = await db
      .collection("well_points")
      .find(
        { wellId, depth: { $gte: left, $lte: right } },
        { projection: { _id: 0, depth: 1, values: 1 } }
      )
      .sort({ depth: 1 })
      .toArray();

    const rows = docs.map((d) => {
      const values = {};
      for (const m of chosen) values[m] = d.values?.[m] ?? null;
      return { depth: d.depth, values };
    });

    const sampled = downsampleMinMax(rows, chosen, target);

    const payload = {
      well: { wellId: well.wellId, name: well.name, version: well.version },
      metrics: chosen,
      meta: { from: left, to: right, minDepth: well.minDepth, maxDepth: well.maxDepth },
      rows: sampled,
    };

    // window can be shorter TTL
    await cacheSetJson(key, payload, 60 * 15); // 15 min
    return res.json({ ...payload, source: "mongo" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "window failed" });
  }
});

/**
 * GET /api/well/:wellId/window-plan?metric=HC1__2&from=1000&to=1200&pixelWidth=1200
 */
router.get("/well/:wellId/window-plan", async (req, res) => {
  try {
    const { wellId } = req.params;
    const metric = String(req.query.metric || "").trim();
    const fromDepth = Number(req.query.from ?? req.query.fromDepth);
    const toDepth = Number(req.query.to ?? req.query.toDepth);
    const pixelWidth = Number(req.query.pixelWidth || req.query.px || 1200);

    if (!metric) return res.status(400).json({ error: "metric is required" });
    if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) {
      return res.status(400).json({ error: "from and to are required numbers" });
    }

    const db = getDb();
    const well = await db.collection("wells").findOne({ wellId }, { projection: { _id: 0, metrics: 1 } });
    if (!well) return res.status(404).json({ error: "Well not found" });
    if (!Array.isArray(well.metrics) || !well.metrics.includes(metric)) {
      return res.status(400).json({ error: `metric not found in well: ${metric}` });
    }

    const redis = getRedis();
    const payload = await buildWindowPlan({
      redisClient: redis,
      db,
      wellId,
      metric,
      fromDepth,
      toDepth,
      pixelWidth,
    });
    return res.json({
      ok: true,
      ...payload,
      // compatibility fields for smoke tests
      source: payload?.plan?.source,
      level: payload?.plan?.levelChosen,
      estimatedPoints: payload?.plan?.estimatedPoints,
      tilesRequested: payload?.plan?.tilesTotal,
      tilesHit: payload?.plan?.tilesHit,
      tilesMiss: payload?.plan?.tilesMiss,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "window-plan failed" });
  }
});

/**
 * GET /api/well/:wellId/window-data?metric=HC1__2&from=1000&to=1200&pixelWidth=1200
 */
router.get("/well/:wellId/window-data", async (req, res) => {
  try {
    const { wellId } = req.params;
    const metric = String(req.query.metric || "").trim();
    const fromDepth = Number(req.query.from ?? req.query.fromDepth);
    const toDepth = Number(req.query.to ?? req.query.toDepth);
    const pixelWidth = Number(req.query.pixelWidth || req.query.px || 1200);

    if (!metric) return res.status(400).json({ error: "metric is required" });
    if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) {
      return res.status(400).json({ error: "from and to are required numbers" });
    }

    const db = getDb();
    const well = await db.collection("wells").findOne({ wellId }, { projection: { _id: 0, metrics: 1 } });
    if (!well) return res.status(404).json({ error: "Well not found" });
    if (!Array.isArray(well.metrics) || !well.metrics.includes(metric)) {
      return res.status(400).json({ error: `metric not found in well: ${metric}` });
    }

    const redis = getRedis();
    const payload = await fetchWindowData({
      redisClient: redis,
      db,
      wellId,
      metric,
      fromDepth,
      toDepth,
      pixelWidth,
    });
    return res.json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "window-data failed" });
  }
});




/**
 * GET /api/wells
 */
router.get("/wells", async (req, res) => {
  try {
    const db = getDb();
    const wells = await db
      .collection("wells")
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ wells });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to fetch wells" });
  }
});

/**
 * GET /api/well/:wellId/data
 * (TEMP full data fetch — later we’ll replace with /overview and /window)
 */
router.get("/well/:wellId/data", async (req, res) => {
  try {
    const { wellId } = req.params;
    const db = getDb();

    const well = await db.collection("wells").findOne({ wellId }, { projection: { _id: 0 } });
    if (!well) return res.status(404).json({ error: "Well not found" });

    const rows = await db
      .collection("well_points")
      .find({ wellId }, { projection: { _id: 0, wellId: 0 } })
      .sort({ depth: 1 })
      .toArray();

    return res.json({
      well: { wellId: well.wellId, name: well.name, version: well.version },
      metrics: well.metrics,
      curves: well.curves,
      meta: { minDepth: well.minDepth, maxDepth: well.maxDepth, nullValue: well.nullValue },
      rows: rows.map((r) => ({ depth: r.depth, values: r.values })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to fetch well data" });
  }
});

export default router;

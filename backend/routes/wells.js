import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { getDb } from "../db/mongo.js";
import { parseLasText } from "../parsers/ParseLas.js";
import { cacheGetJson, cacheSetJson } from "../cache/redisCache.js";
import { overviewKey, windowKey, metricsHash } from "../utils/keyBuilder.js";
import { downsampleMinMax } from "../utils/downsample.js";
import { getRedis } from "../db/redis.js";
import { buildWindowPlan } from "../services/windowPlanService.js";
import { fetchWindowData } from "../services/windowFetchService.js";
import { buildEventTimeline, TIMELINE_FEATURE_VERSION } from "../services/timelineService.js";
import { computeCrossplotMatrix, CROSSPLOT_FEATURE_VERSION } from "../services/crossplotService.js";
import { isLasS3Enabled, uploadLasTextToS3 } from "../services/s3UploadService.js";
import { logger } from "../observability/logger.js";
import {
  eventTimelineDuration,
  crossplotDuration,
  featureErrorTotal,
} from "../observability/metrics.js";


const router = express.Router();
const upload = multer({ dest: "uploads/" });

function isTimeCurveIdOrName(v = "") {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return false;
  return s === "TIME" || s.startsWith("TIME__") || s.startsWith("TIME(");
}

function isTimeCurveObj(curve) {
  const id = String(curve?.id || "");
  const name = String(curve?.name || "");
  const unit = String(curve?.unit || "").trim().toUpperCase();
  if (isTimeCurveIdOrName(id) || isTimeCurveIdOrName(name)) return true;
  // Defensive: TIME + SEC combinations like TIME(SEC)
  if (String(name || "").trim().toUpperCase() === "TIME" && unit === "SEC") return true;
  return false;
}

function sanitizeWellMetaForResponse(well) {
  const src = well && typeof well === "object" ? well : {};
  const filteredCurves = Array.isArray(src.curves)
    ? src.curves.filter((c) => !isTimeCurveObj(c))
    : [];
  const depthCurveId = String(src.depthCurveId || "");
  let nextMetricTrack = 1;
  const curves = filteredCurves.map((c) => {
    const id = String(c?.id || "");
    if (id && id === depthCurveId) {
      return { ...c, track: "0" };
    }
    const track = String(nextMetricTrack);
    nextMetricTrack += 1;
    return { ...c, track };
  });
  const metrics = Array.isArray(src.metrics)
    ? src.metrics.filter((m) => !isTimeCurveIdOrName(m))
    : curves.map((c) => c.id).filter(Boolean);
  return { ...src, curves, metrics };
}

function sanitizeValues(valuesObj) {
  const out = {};
  for (const [k, v] of Object.entries(valuesObj || {})) {
    const num = Number(v);
    if (!Number.isFinite(num) || num <= -999) out[k] = null;
    else out[k] = num;
  }
  return out;
}

function responseMeta(req) {
  return {
    requestId: req.requestId || null,
    generatedAt: new Date().toISOString(),
  };
}

function featureVersionEnvelope({
  featureName,
  featureVersion,
  detModelVersion,
  thresholdVersion,
  algoHash,
}) {
  return {
    feature: featureName,
    featureVersion: featureVersion || null,
    detModelVersion: detModelVersion || null,
    thresholdVersion: thresholdVersion || null,
    algoHash: algoHash || null,
  };
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
    if (!isLasS3Enabled()) {
      return res.status(500).json({
        error: "S3 upload is required but not configured. Set S3_LAS_BUCKET and AWS_REGION.",
      });
    }

    const db = getDb();
    const wellsCol = db.collection("wells");
    const pointsCol = db.collection("well_points");

    const text = await fs.readFile(req.file.path, "utf8");
    await fs.unlink(req.file.path).catch(() => {});

    const parsed = parseLasText(text);

    const wellId = `WELL_${Date.now()}`;
    const name = path.parse(req.file.originalname).name || wellId;
    const s3Object = await uploadLasTextToS3({
      wellId,
      originalName: req.file.originalname,
      text,
    });

    // metrics: all curves except depth curve (assume first is depth)
    const metricIds = parsed.curves.slice(1).map((c) => c.id).filter((id) => !isTimeCurveIdOrName(id));

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
      lasObject: s3Object,
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
      storage: { provider: "s3", bucket: s3Object.bucket, key: s3Object.key, region: s3Object.region },
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

    if (!metric) return res.status(400).json({ ok: false, error: "metric is required" });
    if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) {
      return res.status(400).json({ ok: false, error: "from and to are required numbers" });
    }

    const db = getDb();
    const well = await db.collection("wells").findOne({ wellId }, { projection: { _id: 0, metrics: 1 } });
    if (!well) return res.status(404).json({ ok: false, error: "Well not found" });
    if (!Array.isArray(well.metrics) || !well.metrics.includes(metric)) {
      return res.status(400).json({ ok: false, error: `metric not found in well: ${metric}` });
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
    return res.status(500).json({ ok: false, error: err.message || "window-plan failed" });
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

    if (!metric) return res.status(400).json({ ok: false, error: "metric is required" });
    if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) {
      return res.status(400).json({ ok: false, error: "from and to are required numbers" });
    }

    const db = getDb();
    const well = await db.collection("wells").findOne({ wellId }, { projection: { _id: 0, metrics: 1 } });
    if (!well) return res.status(404).json({ ok: false, error: "Well not found" });
    if (!Array.isArray(well.metrics) || !well.metrics.includes(metric)) {
      return res.status(400).json({ ok: false, error: `metric not found in well: ${metric}` });
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
    return res.status(500).json({ ok: false, error: err.message || "window-data failed" });
  }
});

router.get("/well/:wellId/event-timeline", async (req, res) => {
  const meta = responseMeta(req);
  const startedAt = Date.now();
  const warnings = [];
  const version = featureVersionEnvelope({
    featureName: "event-timeline",
    featureVersion: TIMELINE_FEATURE_VERSION,
  });
  try {
    const { wellId } = req.params;
    const fromDepth = Number(req.query.fromDepth ?? req.query.from);
    const toDepth = Number(req.query.toDepth ?? req.query.to);
    const bucketSize = Math.max(0.1, Number(req.query.bucketSize) || 10);
    const curves = String(req.query.curves || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) {
      eventTimelineDuration.labels("error").observe(Date.now() - startedAt);
      featureErrorTotal.labels("event-timeline", "bad_request").inc();
      return res.status(400).json({
        ok: false,
        ...meta,
        version,
        payload: null,
        warnings,
        errors: ["fromDepth and toDepth are required numbers"],
      });
    }
    if (!curves.length) {
      eventTimelineDuration.labels("error").observe(Date.now() - startedAt);
      featureErrorTotal.labels("event-timeline", "bad_request").inc();
      return res.status(400).json({
        ok: false,
        ...meta,
        version,
        payload: null,
        warnings,
        errors: ["curves query is required"],
      });
    }

    const algoVersion = `timeline:${TIMELINE_FEATURE_VERSION}`;
    const cacheKey = `well:event-timeline:${wellId}:${Math.min(fromDepth, toDepth)}:${Math.max(fromDepth, toDepth)}:b${bucketSize}:m${metricsHash(curves)}:v${algoVersion}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) {
      eventTimelineDuration.labels("ok").observe(Date.now() - startedAt);
      logger.info({
        msg: "feature.complete",
        feature: "event-timeline",
        requestId: req.requestId || null,
        wellId,
        fromDepth: Math.min(fromDepth, toDepth),
        toDepth: Math.max(fromDepth, toDepth),
        durationMs: Date.now() - startedAt,
        status: 200,
        source: "redis",
      });
      return res.json({
        ok: true,
        ...meta,
        ...cached,
        version: featureVersionEnvelope({
          featureName: "event-timeline",
          featureVersion: cached?.featureVersion || TIMELINE_FEATURE_VERSION,
          detModelVersion: cached?.detModelVersion,
          thresholdVersion: cached?.thresholdVersion,
          algoHash: cached?.algoHash,
        }),
        payload: cached,
        warnings: cached?.warnings || [],
        errors: [],
        source: "redis",
      });
    }

    const timeline = await buildEventTimeline({
      wellId,
      fromDepth,
      toDepth,
      bucketSize,
      curves,
    });

    const payload = {
      wellId: timeline.wellId,
      fromDepth: timeline.fromDepth,
      toDepth: timeline.toDepth,
      bucketSize: timeline.bucketSize,
      timeline: timeline.timeline,
      detModelVersion: timeline?.versions?.detModelVersion,
      thresholdVersion: timeline?.versions?.thresholdVersion,
      featureVersion: timeline?.versions?.featureVersion,
      algoHash: timeline?.versions?.algoHash,
      warnings: Array.isArray(timeline?.warnings) ? timeline.warnings : [],
    };
    version.detModelVersion = payload.detModelVersion;
    version.thresholdVersion = payload.thresholdVersion;
    version.algoHash = payload.algoHash;

    await cacheSetJson(cacheKey, payload, 60 * 10);
    eventTimelineDuration.labels("ok").observe(Date.now() - startedAt);
    logger.info({
      msg: "feature.complete",
      feature: "event-timeline",
      requestId: req.requestId || null,
      wellId,
      fromDepth: Math.min(fromDepth, toDepth),
      toDepth: Math.max(fromDepth, toDepth),
      durationMs: Date.now() - startedAt,
      status: 200,
      source: "fresh",
    });
    return res.json({
      ok: true,
      ...meta,
      ...payload,
      version,
      payload,
      warnings: [...warnings, ...(payload.warnings || [])],
      errors: [],
      source: "fresh",
    });
  } catch (err) {
    eventTimelineDuration.labels("error").observe(Date.now() - startedAt);
    featureErrorTotal.labels("event-timeline", "runtime").inc();
    return res.status(400).json({
      ok: false,
      ...meta,
      version,
      payload: null,
      warnings,
      errors: [err?.message || "event timeline failed"],
    });
  }
});

router.post("/well/:wellId/crossplot-matrix", async (req, res) => {
  const meta = responseMeta(req);
  const startedAt = Date.now();
  const warnings = [];
  const version = featureVersionEnvelope({
    featureName: "crossplot-matrix",
    featureVersion: CROSSPLOT_FEATURE_VERSION,
  });
  try {
    const { wellId } = req.params;
    const { fromDepth, toDepth, pairs, sampleLimit, cluster } = req.body || {};
    const curves = Array.isArray(pairs) ? pairs.flat().map((v) => String(v || "").trim()) : [];
    const method = String(cluster?.method || "robust_z");

    const algoVersion = `crossplot:${CROSSPLOT_FEATURE_VERSION}:${method}`;
    const cacheKey = `well:crossplot:${wellId}:${Math.min(Number(fromDepth), Number(toDepth))}:${Math.max(Number(fromDepth), Number(toDepth))}:m${metricsHash(curves)}:n${Math.max(100, Math.min(10000, Number(sampleLimit) || 5000))}:v${algoVersion}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) {
      crossplotDuration.labels("ok").observe(Date.now() - startedAt);
      logger.info({
        msg: "feature.complete",
        feature: "crossplot-matrix",
        requestId: req.requestId || null,
        wellId,
        fromDepth: Math.min(Number(fromDepth), Number(toDepth)),
        toDepth: Math.max(Number(fromDepth), Number(toDepth)),
        durationMs: Date.now() - startedAt,
        status: 200,
        source: "redis",
      });
      return res.json({
        ok: true,
        ...meta,
        ...cached,
        version: featureVersionEnvelope({
          featureName: "crossplot-matrix",
          featureVersion: cached?.featureVersion || CROSSPLOT_FEATURE_VERSION,
          detModelVersion: cached?.detModelVersion,
          thresholdVersion: cached?.thresholdVersion,
          algoHash: cached?.algoHash,
        }),
        payload: cached,
        warnings: cached?.warnings || [],
        errors: [],
        source: "redis",
      });
    }

    const matrix = await computeCrossplotMatrix({
      wellId,
      fromDepth,
      toDepth,
      pairs,
      sampleLimit,
      cluster,
    });

    const payload = {
      wellId,
      fromDepth: Math.min(Number(fromDepth), Number(toDepth)),
      toDepth: Math.max(Number(fromDepth), Number(toDepth)),
      plots: matrix.plots,
      detModelVersion: matrix?.versions?.detModelVersion,
      thresholdVersion: matrix?.versions?.thresholdVersion,
      featureVersion: matrix?.versions?.featureVersion,
      algoHash: matrix?.versions?.algoHash,
    };
    version.detModelVersion = payload.detModelVersion;
    version.thresholdVersion = payload.thresholdVersion;
    version.algoHash = payload.algoHash;

    await cacheSetJson(cacheKey, payload, 60 * 10);
    crossplotDuration.labels("ok").observe(Date.now() - startedAt);
    logger.info({
      msg: "feature.complete",
      feature: "crossplot-matrix",
      requestId: req.requestId || null,
      wellId,
      fromDepth: Math.min(Number(fromDepth), Number(toDepth)),
      toDepth: Math.max(Number(fromDepth), Number(toDepth)),
      durationMs: Date.now() - startedAt,
      status: 200,
      source: "fresh",
    });
    return res.json({
      ok: true,
      ...meta,
      ...payload,
      version,
      payload,
      warnings,
      errors: [],
      source: "fresh",
    });
  } catch (err) {
    crossplotDuration.labels("error").observe(Date.now() - startedAt);
    featureErrorTotal.labels("crossplot-matrix", "runtime").inc();
    return res.status(400).json({
      ok: false,
      ...meta,
      version,
      payload: null,
      warnings,
      errors: [err?.message || "crossplot failed"],
    });
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

    return res.json({ wells: wells.map(sanitizeWellMetaForResponse) });
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

    const cleanWell = sanitizeWellMetaForResponse(well);
    return res.json({
      well: { wellId: cleanWell.wellId, name: cleanWell.name, version: cleanWell.version },
      metrics: cleanWell.metrics,
      curves: cleanWell.curves,
      meta: { minDepth: well.minDepth, maxDepth: well.maxDepth, nullValue: well.nullValue },
      rows: rows.map((r) => ({ depth: r.depth, values: r.values })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to fetch well data" });
  }
});

export default router;

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { parseLasText } from "./parsers/ParseLas.js";
import compression from "compression";
import { connectMongo } from "./db/mongo.js";
import { connectRedis } from "./db/redis.js";
import wellsRouter from "./routes/wells.js";
import "dotenv/config";
import aiRoutes from "./routes/ai.js";
import "dotenv/config";
import aiRouter from "./routes/ai.js";


const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const upload = multer({ dest: "uploads/" });

// wellId -> { wellId, name, curves, metricIds, rows, meta }
const wellsData = new Map();

function sanitizeValues(valuesObj) {
  const out = {};
  for (const [k, v] of Object.entries(valuesObj || {})) {
    if (v == null || Number.isNaN(v) || v <= -999) out[k] = null;
    else out[k] = v;
  }
  return out;
}

app.use(cors());
app.use(compression());

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mode: "mongo+redis" });
});

app.use("/api", wellsRouter);

app.use("/api/ai", aiRouter);


const PORT = process.env.PORT || 5000;

async function start() {
  await connectMongo();
  await connectRedis();

  app.listen(PORT, () => {
    console.log(`🚀 Backend running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
app.post("/api/las/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No file uploaded. form-data key must be 'file'" });
    }

    const text = await fs.readFile(req.file.path, "utf8");
    await fs.unlink(req.file.path).catch(() => {});

    const parsed = parseLasText(text);

    const wellId = `WELL_${Date.now()}`;
    const name = path.parse(req.file.originalname).name || wellId;

    // exclude first curve (depth) from selectable metrics
    const metricIds = parsed.curves.slice(1).map((c) => c.id);

    // static rows
    const rows = parsed.rows.map((r) => ({
      depth: r.depth,
      values: sanitizeValues(r.curves),
    }));

    wellsData.set(wellId, {
      wellId,
      name,
      curves: parsed.curves,
      metricIds,
      rows,
      meta: {
        minDepth: parsed.minDepth,
        maxDepth: parsed.maxDepth,
        nullValue: parsed.nullValue,
        depthCurveId: parsed.depthCurveId,
      },
    });

    return res.json({
      ok: true,
      well: { wellId, name },
      metrics: metricIds,
      curves: parsed.curves,
      rows: rows.length,
      meta: {
        minDepth: parsed.minDepth,
        maxDepth: parsed.maxDepth,
        nullValue: parsed.nullValue,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Upload/parse failed" });
  }
});

app.use("/api/ai", aiRoutes);

app.get("/api/wells", (req, res) => {
  const wells = [...wellsData.values()].map((w) => ({
    wellId: w.wellId,
    name: w.name,
    metrics: w.metricIds,
    curves: w.curves,
    points: w.rows.length,
    meta: w.meta,
  }));
  res.json({ wells });
});

function getWellDataHandler(req, res) {
  const { wellId } = req.params;
  const well = wellsData.get(wellId);

  if (!well) {
    return res.status(404).json({ error: "Well not found" });
  }

  return res.json({
    well: { wellId: well.wellId, name: well.name },
    curves: well.curves,
    metrics: well.metricIds,
    meta: well.meta,
    rows: well.rows,
  });
}

// Support BOTH paths to avoid frontend mismatch issues
app.get("/api/well/:wellId/data", getWellDataHandler);
app.get("/api/wells/:wellId/data", getWellDataHandler);

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT} (static mode)`);
});

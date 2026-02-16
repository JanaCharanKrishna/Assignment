import express from "express";
import cors from "cors";
import compression from "compression";
import "dotenv/config";
import { pathToFileURL } from "node:url";

import { connectMongo } from "./db/mongo.js";
import { connectRedis } from "./db/redis.js";
import wellsRouter from "./routes/wells.js";
import aiRouter from "./routes/ai.js";
import reportsRouter from "./routes/reports.js";
import { requestContext } from "./observability/requestContext.js";
import { httpMetricsMiddleware } from "./observability/httpMetricsMiddleware.js";
import { register } from "./observability/metrics.js";
import { logger } from "./observability/logger.js";

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(cors());
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(requestContext);
app.use(httpMetricsMiddleware);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: "mongo+redis" });
});
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/api", wellsRouter);
app.use("/api/ai", aiRouter);
app.use("/api/reports", reportsRouter);

async function start() {
  await connectMongo();
  await connectRedis();

  app.listen(PORT, () => {
    logger.info({ msg: "server.start", port: PORT, url: `http://localhost:${PORT}` });
  });
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  start().catch((err) => {
    logger.error({ msg: "server.startup_failed", err: err?.message || String(err) });
    process.exit(1);
  });
}

export { app, start };
export default app;

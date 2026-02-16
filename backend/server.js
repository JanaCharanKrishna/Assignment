import express from "express";
import cors from "cors";
import compression from "compression";
import "dotenv/config";

import { connectMongo } from "./db/mongo.js";
import { connectRedis } from "./db/redis.js";
import wellsRouter from "./routes/wells.js";
import aiRouter from "./routes/ai.js";
import reportsRouter from "./routes/reports.js";

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(cors());
app.use(compression());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: "mongo+redis" });
});

app.use("/api", wellsRouter);
app.use("/api/ai", aiRouter);
app.use("/api/reports", reportsRouter);

async function start() {
  await connectMongo();
  await connectRedis();

  app.listen(PORT, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});

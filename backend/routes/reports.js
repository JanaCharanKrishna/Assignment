import express from "express";
import { pgPool } from "../db/postgres.js";

const router = express.Router();

let ensured = false;

async function ensureReportsTable() {
  if (ensured) return;

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS saved_reports (
      id BIGSERIAL PRIMARY KEY,
      report_id TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      output_mode TEXT,
      total_wells INTEGER,
      avg_health NUMERIC,
      report_json JSONB NOT NULL
    );
  `);

  ensured = true;
}

router.post("/", async (req, res) => {
  try {
    await ensureReportsTable();

    const report = req.body?.report;
    if (!report || typeof report !== "object") {
      return res.status(400).json({ error: "report object is required" });
    }

    const reportId = String(report?.meta?.reportId || "").trim();
    if (!reportId) {
      return res.status(400).json({ error: "report.meta.reportId is required" });
    }

    const outputMode = report?.meta?.outputMode ? String(report.meta.outputMode) : null;
    const totalWells = Number.isFinite(Number(report?.kpis?.totalWellsOnline))
      ? Number(report.kpis.totalWellsOnline)
      : null;
    const avgHealth = Number.isFinite(Number(report?.kpis?.avgHealth))
      ? Number(report.kpis.avgHealth)
      : null;

    const q = `
      INSERT INTO saved_reports (
        report_id,
        output_mode,
        total_wells,
        avg_health,
        report_json
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (report_id)
      DO UPDATE SET
        output_mode = EXCLUDED.output_mode,
        total_wells = EXCLUDED.total_wells,
        avg_health = EXCLUDED.avg_health,
        report_json = EXCLUDED.report_json,
        created_at = NOW()
      RETURNING report_id, created_at, output_mode, total_wells, avg_health;
    `;

    const out = await pgPool.query(q, [
      reportId,
      outputMode,
      totalWells,
      avgHealth,
      JSON.stringify(report),
    ]);

    return res.json({ ok: true, report: out.rows[0] || null });
  } catch (err) {
    console.error("[reports] save failed", err);
    return res.status(500).json({ error: err?.message || "Failed to save report" });
  }
});

router.get("/", async (req, res) => {
  try {
    await ensureReportsTable();

    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));

    const q = `
      SELECT report_id, created_at, output_mode, total_wells, avg_health
      FROM saved_reports
      ORDER BY created_at DESC
      LIMIT $1;
    `;

    const out = await pgPool.query(q, [limit]);
    return res.json({ ok: true, reports: out.rows || [] });
  } catch (err) {
    console.error("[reports] list failed", err);
    return res.status(500).json({ error: err?.message || "Failed to list reports" });
  }
});

router.get("/:reportId", async (req, res) => {
  try {
    await ensureReportsTable();

    const reportId = String(req.params.reportId || "").trim();
    if (!reportId) return res.status(400).json({ error: "reportId is required" });

    const q = `
      SELECT report_id, created_at, output_mode, total_wells, avg_health, report_json
      FROM saved_reports
      WHERE report_id = $1
      LIMIT 1;
    `;

    const out = await pgPool.query(q, [reportId]);
    const row = out.rows?.[0] || null;
    if (!row) return res.status(404).json({ error: "Report not found" });

    return res.json({
      ok: true,
      report: {
        reportId: row.report_id,
        createdAt: row.created_at,
        outputMode: row.output_mode,
        totalWells: row.total_wells,
        avgHealth: row.avg_health,
        reportJson: row.report_json,
      },
    });
  } catch (err) {
    console.error("[reports] get failed", err);
    return res.status(500).json({ error: err?.message || "Failed to get report" });
  }
});

export default router;
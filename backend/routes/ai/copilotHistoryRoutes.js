export function registerCopilotHistoryRoutes(router, deps) {
  const { listCopilotRuns, getCopilotRunById, pgPool } = deps;

  router.get("/copilot/runs", async (req, res) => {
    try {
      const wellId = req.query.wellId ? String(req.query.wellId) : undefined;
      const limit = Number(req.query.limit) || 20;
      const runs = await listCopilotRuns({ wellId, limit });
      return res.json({ ok: true, runs });
    } catch (err) {
      console.error("GET /api/ai/copilot/runs failed:", err);
      return res.status(500).json({ error: err?.message || "Failed to list copilot runs" });
    }
  });

  router.get("/copilot/runs/:id", async (req, res) => {
    try {
      const row = await getCopilotRunById(req.params.id);
      if (!row) return res.status(404).json({ error: "Copilot run not found" });
      return res.json({ ok: true, run: row });
    } catch (err) {
      console.error("GET /api/ai/copilot/runs/:id failed:", err);
      return res.status(500).json({ error: err?.message || "Failed to fetch copilot run" });
    }
  });

  router.get("/copilot/history", async (req, res) => {
    try {
      const wellId = String(req.query.wellId || "").trim();
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));

      const sql = `
        SELECT run_id, created_at, well_id, mode, question, source, llm_used,
               schema_valid, evidence_strength, latency_ms, response_json
        FROM copilot_runs
        ${wellId ? "WHERE well_id = $1" : ""}
        ORDER BY created_at DESC
        LIMIT ${wellId ? "$2" : "$1"}
      `;
      const vals = wellId ? [wellId, limit] : [limit];
      const out = await pgPool.query(sql, vals);

      return res.json({ ok: true, count: out.rowCount, rows: out.rows });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

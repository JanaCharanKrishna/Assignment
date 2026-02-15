import { pgPool } from "../db/postgres.js";

export async function insertCopilotRun({
  wellId = null,
  mode,
  question,
  contextRange = {},
  selectedInterval = null,
  source = "fallback",
  schemaValid = true,
  schemaErrors = null,
  evidenceStrength = "medium",
  responseJson = {},
  evidenceJson = {},
  latencyMs = null,
}) {
  const q = `
    INSERT INTO copilot_runs (
      well_id, mode, question, context_range, selected_interval, source,
      schema_valid, schema_errors, evidence_strength, response_json, evidence_json, latency_ms
    ) VALUES (
      $1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12
    )
    RETURNING
      id, created_at, well_id, mode, question, context_range, selected_interval,
      source, schema_valid, schema_errors, evidence_strength, response_json, evidence_json, latency_ms
  `;

  const vals = [
    wellId,
    mode,
    question,
    JSON.stringify(contextRange || {}),
    selectedInterval ? JSON.stringify(selectedInterval) : null,
    source,
    Boolean(schemaValid),
    schemaErrors ? JSON.stringify(schemaErrors) : null,
    evidenceStrength,
    JSON.stringify(responseJson || {}),
    JSON.stringify(evidenceJson || {}),
    Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
  ];

  const r = await pgPool.query(q, vals);
  return r.rows[0] || null;
}

export async function listCopilotRuns({ wellId, limit = 20 }) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 20));
  const vals = [];
  let where = "";

  if (wellId) {
    vals.push(String(wellId));
    where = `WHERE well_id = $${vals.length}`;
  }

  vals.push(lim);
  const q = `
    SELECT
      id, created_at, well_id, mode, question, context_range, selected_interval,
      source, schema_valid, evidence_strength, latency_ms
    FROM copilot_runs
    ${where}
    ORDER BY created_at DESC
    LIMIT $${vals.length}
  `;

  const r = await pgPool.query(q, vals);
  return r.rows || [];
}

export async function getCopilotRunById(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;

  const q = `
    SELECT
      id, created_at, well_id, mode, question, context_range, selected_interval,
      source, schema_valid, schema_errors, evidence_strength, response_json, evidence_json, latency_ms
    FROM copilot_runs
    WHERE id = $1
    LIMIT 1
  `;
  const r = await pgPool.query(q, [n]);
  return r.rows[0] || null;
}

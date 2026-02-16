import { pgPool } from "../db/postgres.js";

export async function insertInterpretationRun({
  wellId,
  fromDepth,
  toDepth,
  curves,
  deterministic,
  narrative,
  insight,
  modelUsed,
  narrativeStatus,
  source = "fresh",
  appVersion = null,
}) {
  const q = `
    INSERT INTO interpretation_runs (
      well_id, from_depth, to_depth, curves,
      deterministic, narrative, insight,
      model_used, narrative_status, source,
      app_version, deterministic_model_version,
      event_count, anomaly_score
    )
    VALUES (
      $1, $2, $3, $4::jsonb,
      $5::jsonb, $6::jsonb, $7::jsonb,
      $8, $9, $10,
      $11, $12,
      $13, $14
    )
    RETURNING run_id, created_at;
  `;

  const values = [
    wellId,
    fromDepth,
    toDepth,
    JSON.stringify(curves || []),
    JSON.stringify(deterministic || {}),
    JSON.stringify(narrative || null),
    JSON.stringify(insight || null),
    modelUsed || null,
    narrativeStatus || "unknown",
    source || "fresh",
    appVersion,
    deterministic?.modelVersion || null,
    Number.isFinite(Number(deterministic?.eventCount))
      ? Number(deterministic.eventCount)
      : null,
    Number.isFinite(Number(deterministic?.anomalyScore))
      ? Number(deterministic.anomalyScore)
      : null,
  ];

  const r = await pgPool.query(q, values);
  return r.rows[0];
}

export async function getInterpretationRunById(runId) {
  const q = `
    SELECT *
    FROM interpretation_runs
    WHERE run_id = $1
    LIMIT 1;
  `;
  const r = await pgPool.query(q, [runId]);
  return r.rows[0] || null;
}

export async function listInterpretationRuns({
  wellId,
  limit = 20,
  offset = 0,
  fromDate,
  toDate,
  narrativeStatus,
}) {
  const where = [];
  const vals = [];
  let i = 1;

  if (wellId) {
    where.push(`well_id = $${i++}`);
    vals.push(wellId);
  }
  if (fromDate) {
    where.push(`created_at >= $${i++}`);
    vals.push(fromDate);
  }
  if (toDate) {
    where.push(`created_at <= $${i++}`);
    vals.push(toDate);
  }
  if (narrativeStatus) {
    where.push(`narrative_status = $${i++}`);
    vals.push(narrativeStatus);
  }

  const q = `
    SELECT
      run_id, well_id, from_depth, to_depth, curves,
      model_used, narrative_status, source,
      deterministic_model_version, event_count, anomaly_score, created_at
    FROM interpretation_runs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT $${i++} OFFSET $${i++};
  `;
  vals.push(Math.min(Number(limit) || 20, 200), Math.max(Number(offset) || 0, 0));

  const r = await pgPool.query(q, vals);
  return r.rows;
}

export async function deleteInterpretationRunById(runId) {
  const q = `
    DELETE FROM interpretation_runs
    WHERE run_id = $1
    RETURNING run_id;
  `;
  const r = await pgPool.query(q, [runId]);
  return r.rows[0] || null;
}

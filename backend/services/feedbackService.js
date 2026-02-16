import { pgPool } from "../db/postgres.js";

const FEEDBACK_TABLE = "interval_feedback";
let feedbackTableChecked = false;
let feedbackTableAvailable = false;
const FEEDBACK_DEDUPE_POLICY = "allow_multiple";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeLabel(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "true_positive" || s === "false_positive" || s === "uncertain") return s;
  return null;
}

export async function ensureFeedbackTableAvailable() {
  if (feedbackTableChecked) return feedbackTableAvailable;
  feedbackTableChecked = true;
  try {
    const out = await pgPool.query(`SELECT to_regclass('public.${FEEDBACK_TABLE}') AS reg`);
    feedbackTableAvailable = !!out?.rows?.[0]?.reg;
  } catch {
    feedbackTableAvailable = false;
  }
  return feedbackTableAvailable;
}

export function validateFeedbackPayload(payload = {}) {
  const runId = payload?.runId ? String(payload.runId).trim() : null;
  const wellId = String(payload?.wellId || "").trim();
  const fromDepth = toNum(payload?.fromDepth);
  const toDepth = toNum(payload?.toDepth);
  const userLabel = normalizeLabel(payload?.userLabel);

  if (!wellId) return { ok: false, error: "wellId is required" };
  if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) {
    return { ok: false, error: "fromDepth and toDepth are required numbers" };
  }
  if (!userLabel) {
    return { ok: false, error: "userLabel must be true_positive|false_positive|uncertain" };
  }

  return {
    ok: true,
    value: {
      runId,
      wellId,
      fromDepth: Math.min(fromDepth, toDepth),
      toDepth: Math.max(fromDepth, toDepth),
      curve: payload?.curve ? String(payload.curve).trim() : null,
      predictedLabel: payload?.predictedLabel ? String(payload.predictedLabel).trim() : null,
      userLabel,
      confidence: toNum(payload?.confidence),
      reason: payload?.reason ? String(payload.reason).trim() : null,
      createdBy: payload?.createdBy ? String(payload.createdBy).trim() : null,
    },
  };
}

export async function insertFeedback(payload) {
  const tableReady = await ensureFeedbackTableAvailable();
  if (!tableReady) throw new Error("interval_feedback table is not available");

  const sql = `
    INSERT INTO ${FEEDBACK_TABLE} (
      run_id,
      well_id,
      from_depth,
      to_depth,
      curve,
      predicted_label,
      user_label,
      confidence,
      reason,
      created_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING id, run_id, well_id, from_depth, to_depth, curve, predicted_label, user_label, confidence, reason, created_by, created_at
  `;
  const values = [
    payload.runId,
    payload.wellId,
    payload.fromDepth,
    payload.toDepth,
    payload.curve,
    payload.predictedLabel,
    payload.userLabel,
    payload.confidence,
    payload.reason,
    payload.createdBy,
  ];

  const out = await pgPool.query(sql, values);
  return out?.rows?.[0] || null;
}

export async function listFeedback({ wellId, fromDepth, toDepth, limit = 200 }) {
  const tableReady = await ensureFeedbackTableAvailable();
  if (!tableReady) return [];

  const values = [String(wellId || "").trim()];
  const clauses = ["well_id = $1"];
  let idx = values.length + 1;

  if (Number.isFinite(Number(fromDepth))) {
    clauses.push(`to_depth >= $${idx}`);
    values.push(Number(fromDepth));
    idx += 1;
  }
  if (Number.isFinite(Number(toDepth))) {
    clauses.push(`from_depth <= $${idx}`);
    values.push(Number(toDepth));
    idx += 1;
  }

  values.push(Math.max(1, Math.min(500, Number(limit) || 200)));
  const sql = `
    SELECT id, run_id, well_id, from_depth, to_depth, curve, predicted_label, user_label, confidence, reason, created_by, created_at
    FROM ${FEEDBACK_TABLE}
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${values.length}
  `;
  const out = await pgPool.query(sql, values);
  return Array.isArray(out?.rows) ? out.rows : [];
}

export async function getFeedbackSummary({ wellId }) {
  const tableReady = await ensureFeedbackTableAvailable();
  if (!tableReady) {
    return {
      dedupePolicy: FEEDBACK_DEDUPE_POLICY,
      byLabel: { true_positive: 0, false_positive: 0, uncertain: 0 },
      byCurve: {},
      total: 0,
    };
  }

  const sqlLabel = `
    SELECT user_label, COUNT(*)::int AS count
    FROM ${FEEDBACK_TABLE}
    WHERE well_id = $1
    GROUP BY user_label
  `;
  const sqlCurve = `
    SELECT
      COALESCE(NULLIF(TRIM(curve), ''), '__all__') AS curve_key,
      user_label,
      COUNT(*)::int AS count
    FROM ${FEEDBACK_TABLE}
    WHERE well_id = $1
    GROUP BY COALESCE(NULLIF(TRIM(curve), ''), '__all__'), user_label
  `;
  const well = String(wellId || "").trim();
  const [outLabel, outCurve] = await Promise.all([
    pgPool.query(sqlLabel, [well]),
    pgPool.query(sqlCurve, [well]),
  ]);
  const byLabel = { true_positive: 0, false_positive: 0, uncertain: 0 };
  for (const row of outLabel?.rows || []) {
    const key = normalizeLabel(row?.user_label);
    if (key) byLabel[key] = Number(row?.count) || 0;
  }

  const byCurve = {};
  for (const row of outCurve?.rows || []) {
    const curveKey = String(row?.curve_key || "__all__");
    const labelKey = normalizeLabel(row?.user_label);
    if (!labelKey) continue;
    if (!byCurve[curveKey]) {
      byCurve[curveKey] = { true_positive: 0, false_positive: 0, uncertain: 0, total: 0 };
    }
    const count = Number(row?.count) || 0;
    byCurve[curveKey][labelKey] += count;
    byCurve[curveKey].total += count;
  }

  return {
    dedupePolicy: FEEDBACK_DEDUPE_POLICY,
    byLabel,
    byCurve,
    total: byLabel.true_positive + byLabel.false_positive + byLabel.uncertain,
  };
}

export async function getFeedbackAdvisory({ wellId, fromDepth, toDepth }) {
  const rows = await listFeedback({
    wellId,
    fromDepth,
    toDepth,
    limit: 200,
  });
  if (!rows.length) return { boost: 0, matches: 0 };

  let tp = 0;
  let fp = 0;
  for (const r of rows) {
    if (r.user_label === "true_positive") tp += 1;
    else if (r.user_label === "false_positive") fp += 1;
  }
  const matches = tp + fp;
  if (!matches) return { boost: 0, matches };

  const ratio = (tp - fp) / matches;
  const boost = Math.max(-0.12, Math.min(0.12, ratio * 0.12));
  return { boost, matches };
}

export { FEEDBACK_DEDUPE_POLICY };

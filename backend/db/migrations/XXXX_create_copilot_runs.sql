CREATE TABLE IF NOT EXISTS copilot_runs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    well_id TEXT,
    mode TEXT NOT NULL,
    question TEXT NOT NULL,
    context_range JSONB NOT NULL DEFAULT '{}'::jsonb,
    selected_interval JSONB,
    source TEXT NOT NULL DEFAULT 'fallback',
    schema_valid BOOLEAN NOT NULL DEFAULT true,
    schema_errors JSONB,
    evidence_strength TEXT NOT NULL DEFAULT 'medium',
    response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_copilot_runs_well_created ON copilot_runs (well_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_runs_created ON copilot_runs (created_at DESC);
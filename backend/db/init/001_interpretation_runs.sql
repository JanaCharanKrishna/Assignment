CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TABLE IF NOT EXISTS interpretation_runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    well_id TEXT NOT NULL,
    from_depth DOUBLE PRECISION NOT NULL,
    to_depth DOUBLE PRECISION NOT NULL,
    curves JSONB NOT NULL,
    deterministic JSONB NOT NULL,
    narrative JSONB,
    insight JSONB,
    model_used TEXT,
    narrative_status TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL DEFAULT 'fresh',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    app_version TEXT,
    deterministic_model_version TEXT,
    event_count INTEGER,
    anomaly_score DOUBLE PRECISION,
    CONSTRAINT ck_depth_order CHECK (to_depth >= from_depth),
    CONSTRAINT ck_curves_array CHECK (jsonb_typeof(curves) = 'array'),
    CONSTRAINT ck_det_object CHECK (jsonb_typeof(deterministic) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_ir_well_created ON interpretation_runs (well_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ir_created ON interpretation_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ir_status_created ON interpretation_runs (narrative_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ir_depth_window ON interpretation_runs (well_id, from_depth, to_depth);
CREATE INDEX IF NOT EXISTS idx_ir_deterministic_gin ON interpretation_runs USING GIN (deterministic);
CREATE INDEX IF NOT EXISTS idx_ir_narrative_gin ON interpretation_runs USING GIN (narrative);
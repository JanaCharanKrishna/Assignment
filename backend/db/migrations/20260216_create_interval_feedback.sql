CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS interval_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID,
    well_id TEXT NOT NULL,
    from_depth DOUBLE PRECISION NOT NULL,
    to_depth DOUBLE PRECISION NOT NULL,
    curve TEXT,
    predicted_label TEXT,
    user_label TEXT NOT NULL CHECK (user_label IN ('true_positive','false_positive','uncertain')),
    confidence DOUBLE PRECISION,
    reason TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_feedback_depth_order CHECK (to_depth >= from_depth)
);

CREATE INDEX IF NOT EXISTS idx_feedback_well_depth
ON interval_feedback (well_id, from_depth, to_depth);

CREATE INDEX IF NOT EXISTS idx_feedback_well_created
ON interval_feedback (well_id, created_at DESC);

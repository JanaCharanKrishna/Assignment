# Phase 6 Hardening Results

Date: 2026-02-16

## Implemented Changes

### Observability
- Added/updated Prometheus metrics in `backend/observability/metrics.js`.
- Added HTTP metrics middleware increment for both latency and request counter in `backend/observability/httpMetricsMiddleware.js`.
- Added request-id propagation middleware in `backend/observability/requestContext.js`.
- Added structured logger helper `buildLogPayload` in `backend/observability/logger.js`.
- Exposed `/metrics` in `backend/server.js`.

### Interpret/Fallback Hardening
- Added forced fallback hook (`FORCE_NARRATIVE_FALLBACK=true`) in `backend/routes/ai.js` within `maybeGroqNarrative`.
- Added stricter `/api/ai/interpret` validations in `backend/routes/ai.js`:
  - explicit `fromDepth <= toDepth` check,
  - returns include `ok: false` for validation failures,
  - range-fetch failures mapped to non-200 response with structured body.

### API Error Contract Hardening
- Added structured `ok: false` error responses in `backend/routes/wells.js` for `window-plan` and `window-data` invalid-input/not-found paths.

### Server/Testability
- Updated `backend/server.js` to export `app`/`start` and only auto-start when run directly.

### New Tests Added
- Integration:
  - `backend/tests/integration/pipeline-negative.spec.js`
  - `backend/tests/integration/fallback.spec.js`
  - `backend/tests/integration/metrics-values.spec.js`
- Unit:
  - `backend/tests/unit/logger.spec.js`

### Golden + CI + UI Smoke
- Added golden runner and batch comparator:
  - `testing/golden/runGolden.js`
  - `testing/golden/compareIntervalsBatch.js`
  - `testing/golden/actual/.gitkeep`
- Added Playwright config and smoke wiring:
  - `frontend/playwright.config.ts`
  - updated `frontend/e2e/smoke.spec.ts`
  - updated `frontend/package.json` (`test:e2e`, `@playwright/test`)
- Added CI workflow:
  - `.github/workflows/ci.yml`

## Executed Test Results

### Backend Unit
Command:
- `cd backend && npm run test:unit`

Result:
- Pass: 6
- Fail: 0
- Skip: 0

### Backend Integration
Command:
- `cd backend && npm run test:integration`

Result:
- Pass: 4
- Fail: 0
- Skip: 3

Skipped reasons:
- Running backend instance did not expose/align with `window-data` and fallback test prerequisites for those specific checks.

### Backend Full Suite
Command:
- `cd backend && npm test`

Result:
- Pass: 10
- Fail: 0
- Skip: 3

### Frontend E2E Smoke
Commands:
- `cd frontend && npm install`
- `cd frontend && npx playwright install chromium`
- `cd frontend && npm run test:e2e`

Result:
- Pass: 1
- Fail: 0

### Golden Runner + Batch Compare
Commands:
- `node testing/golden/runGolden.js`
- `node testing/golden/compareIntervalsBatch.js`

Result:
- `runGolden`: **failed** (`Golden case golden_A failed: status=500, body={"error":"Well not found"}`)
- `compareIntervalsBatch`: **failed** (missing `testing/golden/actual/golden_*.intervals.json` due prior run failure)

Root cause:
- Required seeded well data (`WELL_1770968672517`) was not available in the active backend data store used during this run.

## Status Summary
- Observability hardening: DONE
- Structured logging hardening: DONE
- Negative/fallback/metrics tests added: DONE
- Frontend Playwright smoke setup + run: DONE
- Golden regression execution: BLOCKED by missing seeded data in active backend environment

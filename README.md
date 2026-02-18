# Wellsite Operations Analytics Copilot

An end-to-end well log analytics platform for LAS-driven interpretation, anomaly detection, and decision support.

This repository combines:
- fast windowed data retrieval (Redis + multi-resolution/tile caching)
- deterministic anomaly detection (baseline-aware scoring + interval consolidation)
- AI narrative generation with deterministic fallback
- observability and hardened QA (Prometheus metrics, structured logs, unit/integration/e2e tests)
- a frontend optimized for zoom-heavy technical workflows

---

## Why this project stands out

Most demo analytics apps stop at plotting curves. This system is engineered like a production service:

- Performance architecture: pyramid levels + tile cache + planner for predictable low-latency windows.
- Reliable interpretation pipeline: deterministic core + optional LLM narrative + robust fallback path.
- Quality-first detection: multi-curve evidence support, baseline-aware anomaly logic, quality penalties.
- Traceability: request IDs, run IDs, structured logs, and rich metrics.
- Hardening mindset: unit, integration, concurrency, regression, and smoke test coverage.

---

## Core capabilities

### 1) LAS ingestion and analytics
- Parse LAS data and persist structured curve samples.
- Compute interval statistics and derived indicators.
- Serve curve windows efficiently for interactive exploration.

### 2) Deterministic anomaly engine
- Detects interval events such as `spike`, `step_change`, and `drift`.
- Produces anomaly score, confidence/severity bands, and interval-level findings.
- Includes consolidation logic so output is not raw point clutter.

### 3) Multi-curve evidence consolidation
- Preserves score-based ranking while surfacing cross-curve agreement.
- Adds fields like `curvesSupporting` and `evidenceType` (`single-curve` / `multi-curve`).

### 4) Baseline-aware scoring
- Local windows are scored against wider baseline behavior.
- Uses local/global statistical descriptors to reduce false positives.

### 5) AI narrative with deterministic fallback
- LLM narrative generation for technical summaries and interval explanations.
- If model/API is unavailable, the system returns deterministic structured output instead of hard-failing.
- Fallback state is explicit in response metadata.

### 6) Phase-3 performance architecture
- Multi-resolution pyramid cache (L0 raw + downsampled levels).
- Tile cache keyed by well/metric/level/range/version.
- Planner endpoint selects level by pixel budget and reports cache/source insights.

### 7) Observability and ops readiness
- Prometheus metrics at `/metrics`.
- Structured logs with request/run correlation IDs.
- Easier debugging under load and stronger release confidence.

---

## High-level architecture

```text
Frontend (React + Vite, :5173)
    |
    |  /window-data /window-plan /interpret /reports
    v
Backend API (Node/Express, :5000)
    |-------------------------------|---------------------------|
    |                               |                           |
Redis (tile+pyramid cache)          MongoDB                    PostgreSQL
(window/timeline/crossplot)         (well metadata+samples)    (runs/reports/feedback)
                                    |
                                    v
                            AI service (FastAPI, :8000)
                                    |
                                    v
                           Groq/OpenAI (optional)
```

---

## Repository layout

```text
frontend/        React + Vite UI
backend/         Express API, routes, services, tests, DB scripts
ai-service/      FastAPI AI service
testing/         Golden tests, Postman collections, smoke scripts, docs
.github/         CI workflow
```

---

## Tech stack

### Frontend
- React + Vite
- Plotly (`react-plotly.js`) for crossplots and technical visualization

### Backend
- Node.js + Express
- Modular route/service architecture

### Data layer
- MongoDB for high-volume well sample retrieval
- PostgreSQL for interpretation runs, copilot runs, reports, feedback
- Redis for low-latency cache and window acceleration

### AI layer
- Python FastAPI service
- LLM-backed narrative/copilot paths (Groq/OpenAI)
- Deterministic fallback for availability and safety

### Observability/testing
- Prometheus metrics endpoint
- Structured logging and request context middleware
- Unit + integration + golden + e2e smoke scaffolding

---

## API behavior snapshot

### Wells and windows
- `POST /api/las/upload`
- `GET /api/wells`
- `GET /api/well/:wellId/overview`
- `GET /api/well/:wellId/window`
- `GET /api/well/:wellId/window-plan`
- `GET /api/well/:wellId/window-data`
- `GET /api/well/:wellId/event-timeline`
- `POST /api/well/:wellId/crossplot-matrix`

### AI and interpretation
- `POST /api/ai/interpret`
- `GET /api/ai/runs`
- `GET /api/ai/runs/:runId`
- `DELETE /api/ai/runs/:runId`
- `POST /api/ai/interpret/export/pdf`
- `POST /api/ai/copilot/query`
- `GET /api/ai/copilot/runs`
- `GET /api/ai/copilot/runs/:id`
- `GET /api/ai/copilot/history`
- `POST /api/ai/interval-diff`
- `POST /api/ai/feedback`
- `GET /api/ai/feedback`
- `GET /api/ai/feedback/summary`

### Reports
- `POST /api/reports`
- `GET /api/reports`
- `GET /api/reports/:reportId`

---

## Quality and reliability features

- Handles sparse/null curves via quality gates and confidence penalties.
- Structured error contracts for invalid inputs (`ok: false` patterns).
- Graceful fallback when AI is unavailable.
- Deterministic narrative path for predictable behavior.
- Request/run tracing for incident analysis.

---

## Testing strategy

1. Unit tests
- parser behavior
- detector math
- interval merge/consolidation logic
- metrics/logging helpers

2. Integration tests
- upload/ingest -> window fetch -> interpret path
- negative input validation
- fallback behavior

3. Performance/concurrency checks
- warm vs cold behavior
- concurrent request smoke
- cache/guardrail checks

4. Golden regression scaffold
- fixed input files + expected intervals
- comparator scripts for algorithm safety

5. UI smoke scaffold
- app shell load and baseline navigation checks

---

## What improved phase-by-phase

- Detection quality: multi-curve support, baseline-aware scoring, quality gates.
- Performance architecture: pyramid + tile cache + planner + capped point budgets.
- Observability: metrics, structured logs, request/run tracing.
- Hardening: stricter API contracts, fallback hooks, negative tests, CI scaffolding.
- UX analytics expansion: interval diff, cross-plot matrix, event timeline, feedback loop.

---

## Local setup

### 1) Prerequisites
- Node.js 20+
- npm 10+
- Python 3.11+
- Docker Desktop (or Docker Engine + Compose v2)

### 2) Clone and install dependencies

```bash
git clone <your-repo-url>
cd Assignment

cd backend && npm install
cd ../frontend && npm install
cd ../ai-service && python -m venv .venv
```

Activate venv and install Python dependencies.

Windows PowerShell:

```powershell
cd ai-service
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

macOS/Linux:

```bash
cd ai-service
source .venv/bin/activate
pip install -r requirements.txt
```

### 3) Configure environment variables

`backend/.env` example:

```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017
DB_NAME=las_app
REDIS_URL=redis://127.0.0.1:6379

PGHOST=localhost
PGPORT=5432
PGUSER=appuser
PGPASSWORD=apppass
PGDATABASE=appdb

AI_SERVICE_URL=http://127.0.0.1:8000
PY_AI_BASE=http://127.0.0.1:8000
PY_COPILOT_TIMEOUT_MS=45000

API_BASE=http://localhost:5000
APP_VERSION=phase-1.2

GROQ_API_KEY=
OPENAI_API_KEY=
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
LLM_PRIMARY=meta-llama/llama-4-scout-17b-16e-instruct

FORCE_NARRATIVE_FALLBACK=false

S3_LAS_BUCKET=
S3_LAS_PREFIX=las-files
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

`ai-service/.env` example:

```env
GROQ_API_KEY=
OPENAI_API_KEY=
LLM_PRIMARY=llama-3.3-70b-versatile
LOG_LEVEL=INFO
```

### 4) Start infrastructure

From repo root:

```bash
docker compose -f backend/docker-compose.yml up -d
```

This starts:
- MongoDB on `localhost:27017`
- Redis on `localhost:6379`
- PostgreSQL on `localhost:5432` (`appuser` / `apppass` / `appdb`)

### 5) Run services

Terminal 1 (AI service):

```bash
cd ai-service
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Terminal 2 (backend):

```bash
cd backend
npm run dev
```

Terminal 3 (frontend):

```bash
cd frontend
npm run dev
```

### 6) Verify health and metrics

- Frontend: `http://localhost:5173`
- Backend health: `http://localhost:5000/api/health`
- AI service health: `http://localhost:8000/health`
- Metrics: `http://localhost:5000/metrics`

---

## Data onboarding

Upload a LAS file:

```bash
curl -F "file=@/absolute/path/to/well.las" http://localhost:5000/api/las/upload
```

Use returned `wellId` in the UI or APIs.

---

## PostgreSQL migrations

`backend/db/init/001_interpretation_runs.sql` is mounted by Docker init.

Apply remaining migrations manually:

```bash
psql -h localhost -U appuser -d appdb -f backend/db/migrations/XXXX_create_copilot_runs.sql
psql -h localhost -U appuser -d appdb -f backend/db/migrations/20260216_create_interval_feedback.sql
```

Container alternative:

```bash
docker exec -i app_postgres psql -U appuser -d appdb < backend/db/migrations/XXXX_create_copilot_runs.sql
docker exec -i app_postgres psql -U appuser -d appdb < backend/db/migrations/20260216_create_interval_feedback.sql
```

---

## Typical dev commands

Backend tests:

```bash
cd backend
npm run test:unit
npm run test:integration
npm test
```

Frontend smoke tests:

```bash
cd frontend
npx playwright install chromium
npm run test:e2e
```

Golden regression scripts:

```bash
node testing/golden/runGolden.js
node testing/golden/compareIntervalsBatch.js
```

Postman/Newman smoke:

```bash
newman run testing/postman/Wellsite-Phase3.postman_collection.json \
  -e testing/postman/Wellsite-Phase3.local.postman_environment.json
```

---

## Known operational notes

- Golden tests require seeded reference well data (`TEST_WELL_ID`) in the active environment.
- If AI keys are missing or quota is exhausted, narrative/copilot paths should degrade to fallback behavior.
- For large windows, planner selection should cap points to rendering budget.
- Keep curve naming and depth units consistent across frontend/backend pipelines.

---

## CI

GitHub Actions workflow (`.github/workflows/ci.yml`) currently runs:
- backend unit + integration tests
- golden regression checks
- frontend Playwright smoke

---

## Roadmap

- stronger interval diff workflows (stats + narrative delta)
- richer cross-plot matrix interaction and clustering controls
- event timeline heat strip enhancements
- active-learning feedback loop integration into scoring
- CI-enforced golden regression with stable production fixtures

---

## Project impact

This project is built to be fast, explainable, and dependable for real engineering workflows:
- fast enough for interactive zoom behavior
- robust enough to survive model/API outages
- observable enough for confident operation
- structured enough for safe iterative delivery

---

## Security notes

- Do not commit real API keys or cloud credentials.
- Keep `.env` local and rotate keys that were previously exposed.
- Use least-privilege IAM permissions for S3 credentials.

---

## License

Add your license here (MIT, Apache-2.0, Proprietary, etc.).

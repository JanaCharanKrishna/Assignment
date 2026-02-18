# One-Geo Assignment Workspace

A multi-service well-log analytics platform for LAS ingestion, depth-window analytics, AI interpretation, interval comparison, and report generation.

## What You Get

- React dashboard for well exploration, interpretation, reports, and copilot Q&A
- Node.js API for ingestion, analytics, caching, persistence, and PDF export
- Python FastAPI AI service for deterministic + LLM-assisted interpretation/copilot responses
- MongoDB for well data, Redis for caching, PostgreSQL for run/report/feedback history
- Prometheus-style metrics at `/metrics`

## Architecture

```text
Frontend (Vite/React, :5173)
  -> Backend API (Express, :5000)
     -> MongoDB (well metadata + points)
     -> Redis (window/timeline/crossplot/interval-diff cache)
     -> PostgreSQL (interpret runs, reports, copilot runs, feedback)
     -> Python AI service (FastAPI, :8000)
        -> Groq/OpenAI (optional, for narrative/copilot LLM paths)
```

## Repository Layout

```text
frontend/        React + Vite UI
backend/         Express API, routes, services, tests, db scripts
ai-service/      FastAPI AI service
testing/         Golden tests, Postman collections, smoke scripts, docs
.github/         CI workflow
```

## Prerequisites

- Node.js 20+
- npm 10+
- Python 3.11+
- Docker Desktop (or Docker Engine + Compose v2)

## Quick Start

### 1) Start databases (from repo root)

```bash
docker compose -f backend/docker-compose.yml up -d
```

This starts:

- MongoDB: `localhost:27017`
- Redis: `localhost:6379`
- PostgreSQL: `localhost:5432` (`appuser` / `apppass` / `appdb`)

### 2) Configure environment variables

Use local `.env` files and keep secrets out of git.

`backend/.env` (example):

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

# Optional LLM keys/models
GROQ_API_KEY=<your_groq_key>
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
LLM_PRIMARY=meta-llama/llama-4-scout-17b-16e-instruct

# Optional flags
FORCE_NARRATIVE_FALLBACK=false

# Optional S3 upload
S3_LAS_BUCKET=
S3_LAS_PREFIX=las-files
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

`ai-service/.env` (example):

```env
# Provide at least one provider key
GROQ_API_KEY=<your_groq_key>
OPENAI_API_KEY=

LLM_PRIMARY=llama-3.3-70b-versatile
LOG_LEVEL=INFO
```

### 3) Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
cd ../ai-service && python -m venv .venv
```

Activate virtual environment and install Python deps:

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

### 4) Run services

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

### 5) Verify health

- Frontend: `http://localhost:5173`
- Backend health: `http://localhost:5000/api/health`
- AI service health: `http://localhost:8000/health`
- Backend metrics: `http://localhost:5000/metrics`

## Data Onboarding

Upload a LAS file using API:

```bash
curl -F "file=@/absolute/path/to/well.las" http://localhost:5000/api/las/upload
```

The response contains a `wellId`. Use that well in the dashboard.

## Key API Endpoints

### Wells / data

- `POST /api/las/upload` - upload and parse LAS
- `GET /api/wells` - list wells
- `GET /api/well/:wellId/overview` - downsampled overview data
- `GET /api/well/:wellId/window` - range window data
- `GET /api/well/:wellId/window-plan` - tile/window planning metadata
- `GET /api/well/:wellId/window-data` - tile/window rows
- `GET /api/well/:wellId/event-timeline` - interval timeline aggregation
- `POST /api/well/:wellId/crossplot-matrix` - multi-pair crossplot payload

### AI / interpretation

- `POST /api/ai/interpret` - run deterministic + narrative interpretation
- `GET /api/ai/runs` - list interpretation runs
- `GET /api/ai/runs/:runId` - get run details
- `DELETE /api/ai/runs/:runId` - delete run
- `POST /api/ai/interpret/export/pdf` - export interpretation PDF
- `POST /api/ai/copilot/query` - grounded copilot Q&A
- `GET /api/ai/copilot/runs` - list copilot runs
- `GET /api/ai/copilot/runs/:id` - get copilot run
- `GET /api/ai/copilot/history` - copilot history list
- `POST /api/ai/interval-diff` - compare two depth intervals
- `POST /api/ai/feedback` - submit interval feedback
- `GET /api/ai/feedback` - list feedback by well/range
- `GET /api/ai/feedback/summary` - aggregated feedback summary

### Reports

- `POST /api/reports` - save report JSON to Postgres
- `GET /api/reports` - list saved reports
- `GET /api/reports/:reportId` - fetch report

## PostgreSQL Migrations

`docker-compose` initializes `interpretation_runs` via `backend/db/init/001_interpretation_runs.sql`.

Apply remaining migrations manually:

```bash
psql -h localhost -U appuser -d appdb -f backend/db/migrations/XXXX_create_copilot_runs.sql
psql -h localhost -U appuser -d appdb -f backend/db/migrations/20260216_create_interval_feedback.sql
```

If `psql` is not installed locally, run from the Postgres container:

```bash
docker exec -i app_postgres psql -U appuser -d appdb < backend/db/migrations/XXXX_create_copilot_runs.sql
docker exec -i app_postgres psql -U appuser -d appdb < backend/db/migrations/20260216_create_interval_feedback.sql
```

## Testing

### Backend

```bash
cd backend
npm run test:unit
npm run test:integration
npm test
```

### Frontend E2E (Playwright)

```bash
cd frontend
npx playwright install chromium
npm run test:e2e
```

### Golden regression

Requires a valid seeded `TEST_WELL_ID` available in backend data.

```bash
node testing/golden/runGolden.js
node testing/golden/compareIntervalsBatch.js
```

### Postman/Newman smoke

```bash
newman run testing/postman/Wellsite-Phase3.postman_collection.json \
  -e testing/postman/Wellsite-Phase3.local.postman_environment.json
```

## CI

GitHub Actions workflow (`.github/workflows/ci.yml`) runs:

- backend unit + integration tests
- golden regression checks
- frontend Playwright smoke test

## Troubleshooting

- `Well not found`: upload LAS first, then use returned `wellId`.
- `interval_feedback table is not available`: run feedback migration.
- `AI service unreachable/timeout`: verify AI service is running on `:8000` and backend `AI_SERVICE_URL` / `PY_AI_BASE` match.
- Frequent narrative fallback: verify `GROQ_API_KEY` or `OPENAI_API_KEY`, provider quota, and model names.
- `Cannot GET /api/reports`: restart backend after route/migration updates.

## Security Notes

- Do not commit real API keys or cloud credentials.
- Keep `.env` local and rotate any keys that were previously exposed.
- Limit IAM permissions for S3 credentials used by the upload path.

# Assignment Workspace

This repository is organized as a 3-service workspace:

- `frontend/` : React + Vite UI
- `backend/` : Node.js API and persistence layer
- `ai-service/` : Python FastAPI AI/interpretation service

## Clean Structure

- Runtime/build artifacts are ignored in root `.gitignore`.
- `backend/server.js` is a single startup path (no duplicate listeners/routes).
- `ai-service` is treated as a Python service only (accidental Node manifests removed).

## Run Locally

1. Backend
   - `cd backend`
   - `npm install`
   - `npm run dev`

2. AI Service
   - `cd ai-service`
   - `python -m venv .venv`
   - `.venv\Scripts\activate`
   - `pip install -r requirements.txt`
   - `uvicorn main:app --reload --port 8000`

3. Frontend
   - `cd frontend`
   - `npm install`
   - `npm run dev`

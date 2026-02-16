from fastapi import FastAPI

from routes.copilot import router as copilot_router
from routes.interpret import router as interpret_router

app = FastAPI(title="AI Service", version="1.0.0")
app.include_router(interpret_router)
app.include_router(copilot_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

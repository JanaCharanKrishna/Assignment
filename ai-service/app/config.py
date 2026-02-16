import os
from dataclasses import dataclass
from pathlib import Path

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None

if load_dotenv:
    # Auto-load ai-service/.env so keys work even without --env-file
    dotenv_path = Path(__file__).resolve().parents[1] / ".env"
    # Prefer project-local .env over inherited shell/system env vars.
    load_dotenv(dotenv_path=dotenv_path, override=True)

def _get(name: str, default: str = "") -> str:
    return (os.getenv(name, default) or "").strip()

@dataclass
class Settings:
    GROQ_API_KEY: str = _get("GROQ_API_KEY")
    OPENAI_API_KEY: str = _get("OPENAI_API_KEY")

settings = Settings()

# app/config.py
import os
from dataclasses import dataclass

def _get(name: str, default: str = "") -> str:
    return (os.getenv(name, default) or "").strip()

@dataclass
class Settings:
    GROQ_API_KEY: str = _get("GROQ_API_KEY")
    OPENAI_API_KEY: str = _get("OPENAI_API_KEY")

settings = Settings()

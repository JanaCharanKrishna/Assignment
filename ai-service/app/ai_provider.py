import logging
import os
from openai import OpenAI

from app.config import settings

logger = logging.getLogger(__name__)

_client = None
_provider = "NONE"
_model_name = ""
_client_sig = ""


def get_ai_client():
    global _client, _provider, _model_name, _client_sig

    groq_key = (settings.GROQ_API_KEY or "").strip()
    openai_key = (settings.OPENAI_API_KEY or "").strip()
    preferred_model = (os.getenv("LLM_PRIMARY") or "").strip()

    def is_placeholder(key: str) -> bool:
        return not key or "your_key" in key or "sk-proj-XXX" in key or len(key) < 20

    # Recreate client if env/model changed.
    next_sig = f"{groq_key}|{openai_key}|{preferred_model}"
    if _client and _client_sig != next_sig:
        _client = None
        _provider = "NONE"
        _model_name = ""

    if not _client:
        if not is_placeholder(groq_key):
            _client = OpenAI(api_key=groq_key, base_url="https://api.groq.com/openai/v1")
            _provider = "GROQ"
            _model_name = preferred_model or "llama-3.3-70b-versatile"
            logger.info("AI subsystem online via %s", _provider)
        elif not is_placeholder(openai_key):
            _client = OpenAI(api_key=openai_key)
            _provider = "OPENAI"
            _model_name = preferred_model or "gpt-4o"
            logger.info("AI subsystem online via %s", _provider)

    _client_sig = next_sig
    return _client, _provider, _model_name

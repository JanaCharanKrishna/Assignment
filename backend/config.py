from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # existing fields...
    GROQ_API_KEY: str = "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"
    GROQ_MODEL: str = "openai/gpt-oss-20b"
    AI_TIMEOUT_SECONDS: int = 45
    AI_MAX_RETRIES: int = 2

settings = Settings()

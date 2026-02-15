import os

class Settings:
    GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
    # add more env vars if needed

settings = Settings()

"""Compatibility ASGI entrypoint.

Allows running the service with:
    uvicorn app.main:app
"""

from main import app


from __future__ import annotations

import os
from pathlib import Path


class Config:
    # Flask
    SECRET_KEY = os.environ.get("RAG_CHATBOT_SECRET_KEY", "dev-secret-key-change-me")
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"

    # Uploads
    BASE_DIR = Path(__file__).resolve().parent
    PROJECT_ROOT = BASE_DIR.parent  # repository root

    STATIC_DIR = BASE_DIR / "static"
    UPLOADS_PERMANENT_DIR = STATIC_DIR / "uploads" / "permanent"
    UPLOADS_TEMP_DIR = STATIC_DIR / "uploads" / "temp"

    # Backend script I/O (must match existing scripts that are located in project root)
    BACKEND_DATA_DIR = PROJECT_ROOT / "data"
    MARKDOWN_DIR = BACKEND_DATA_DIR / "markdowns"
    CHROMA_DIR = PROJECT_ROOT / "chroma_store"
    CHROMA_COLLECTION_NAME = "pdf_markdown_embeddings"

    # Flask-SQLAlchemy (SQLite)
    SQLALCHEMY_DATABASE_URI = f"sqlite:///{(BASE_DIR / 'instance' / 'rag.db').as_posix()}"
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Limits
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50 MB


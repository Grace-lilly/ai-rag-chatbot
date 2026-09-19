"""Start the DocuMind RAG Flask app."""

from __future__ import annotations

import os

from dotenv import load_dotenv

from rag_chatbot.app import create_app

load_dotenv()


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)

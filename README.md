# DocuMind RAG

DocuMind is a Flask chatbot that answers questions from PDFs you upload. It extracts text, embeds chunks into ChromaDB, retrieves the most relevant passages (with an optional cross-encoder reranker), and generates answers with a local Qwen model.

The web UI is named **DocuMind RAG**. You register or sign in, upload a PDF, wait until it is indexed, then ask questions about that document. Temporary chats and temporary documents stay session-only; permanent uploads are stored per user.

Model weights are **not** in this repository. They are too large for GitHub. Download them locally with `download_models.py` (see [Setup](#setup)).

## How it works

```
PDF upload
    → PyMuPDF text extraction (saved as markdown)
    → embeddings.py (BGE-large chunks → ChromaDB)
    → user question
    → bi-encoder retrieval + cross-encoder rerank
    → Qwen2-1.5B-Instruct (optional QLoRA adapters)
    → answer in the chat UI
```

- **Permanent documents** go into the shared collection `pdf_markdown_embeddings`.
- **Temp documents** go into a per-user, per-session collection and are cleaned up on logout.
- Admins can trigger QLoRA fine-tuning (`train_qlora.py`) from the UI using `data/qa_pairs_qwen.jsonl`.

## Repository layout

```
.
├── run.py                 # start the Flask app
├── download_models.py     # fetch weights into models/
├── rag_pipeline.py        # retrieval + generation engine
├── embeddings.py          # markdown → ChromaDB
├── train_qlora.py         # optional QLoRA fine-tune
├── requirements.txt
├── rag_chatbot/           # Flask app (auth, chat, uploads, APIs)
│   ├── app.py
│   ├── config.py
│   ├── models.py          # SQLAlchemy users, sessions, documents
│   ├── pipeline_runner.py # background PDF + embed jobs
│   ├── rag_service.py     # lazy loader for rag_pipeline.ask
│   ├── templates/
│   └── static/
├── data/
│   ├── markdowns/         # generated from uploads (gitignored)
│   └── qa_pairs_qwen.jsonl
└── models/                # local weights (gitignored except README)
```

## Requirements

- Python 3.10+
- Enough RAM/VRAM to load Qwen2-1.5B plus the embedding models
- Optional: NVIDIA GPU + a CUDA build of PyTorch (much faster)

## Setup

```bash
git clone https://github.com/Grace-lilly/ai-rag-chatbot.git
cd ai-rag-chatbot
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

Install a CUDA-enabled PyTorch if you have a GPU (example for CUDA 12.1):

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu121
```

Copy `.env.example` to `.env` and set `RAG_CHATBOT_SECRET_KEY`.

Download models (several GB; needs internet once):

```bash
python download_models.py
```

Expected folders after download:

- `models/qwen`
- `models/BAAI-bge-large`
- `models/ms-marco-MiniLM-L-6-v2`
- `models/all-MiniLM-L6-v2` (fallback embedder)

The pipeline runs **offline** after that (`TRANSFORMERS_OFFLINE=1`).

## Run

From the repository root:

```bash
python run.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). Create an account, upload a PDF, wait for indexing, then ask questions.

The first start loads embedding and language models in a background thread. `/api/status` reports `rag_ready` when they are loaded.

## Using the app

1. **Sign up / sign in** on the auth page.
2. **Upload Doc** for permanent PDFs (max 50 MB, PDF only).
3. Ask questions in the conversation sidebar.
4. **Temp Chat** / **Temp Doc** for session-only files that should not join the permanent index.
5. Admins can start fine-tuning from the chat UI (`can_finetune`).

## Optional: QLoRA fine-tuning

Needs a GPU and `bitsandbytes`. Training data is `data/qa_pairs_qwen.jsonl` (chat `messages` format).

```bash
python train_qlora.py
```

Adapters are written to `models/qwen_qlora_adapters/`. If that folder exists, `rag_pipeline.py` loads the adapters on top of the base Qwen model.

## Configuration

| Variable | Purpose |
| --- | --- |
| `RAG_CHATBOT_SECRET_KEY` | Flask session secret |
| `PORT` | HTTP port (default `5000`) |

Paths (relative to the repo root) are set in `rag_chatbot/config.py` and `rag_pipeline.py`:

- Uploads: `rag_chatbot/static/uploads/`
- SQLite: `rag_chatbot/instance/rag.db`
- Chroma: `chroma_store/`
- Extracted text: `data/markdowns/`

## License

Use and share this project as you need for coursework or personal use. Third-party model weights remain under their original Hugging Face licenses (Qwen, BGE, MiniLM).

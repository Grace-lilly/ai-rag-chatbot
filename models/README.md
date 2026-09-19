# Local models

This project loads models from disk (offline). Weights are **not** in git.

Place folders here after running `python download_models.py` from the repo root:

| Local folder | Hugging Face source | Used for |
| --- | --- | --- |
| `qwen/` | `Qwen/Qwen2-1.5B-Instruct` | Answer generation |
| `BAAI-bge-large/` | `BAAI/bge-large-en-v1.5` | Document embeddings |
| `ms-marco-MiniLM-L-6-v2/` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Reranking retrieved chunks |
| `all-MiniLM-L6-v2/` | `sentence-transformers/all-MiniLM-L6-v2` | Fallback embedder |
| `qwen_qlora_adapters/` | created by `train_qlora.py` | Optional fine-tuned adapters |

If adapters are missing, the app uses the base Qwen model.

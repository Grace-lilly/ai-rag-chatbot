"""
Download the local model folders this app expects.

Weights are large (several GB) and are intentionally not stored in git.
Run this once on a machine with internet, then start the app offline.

Usage:
    python download_models.py
    python download_models.py --skip-llm
"""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download


BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"

# Hugging Face repo -> local folder name used by rag_pipeline.py / embeddings.py
MODELS = {
    "Qwen/Qwen2-1.5B-Instruct": MODELS_DIR / "qwen",
    "BAAI/bge-large-en-v1.5": MODELS_DIR / "BAAI-bge-large",
    "cross-encoder/ms-marco-MiniLM-L-6-v2": MODELS_DIR / "ms-marco-MiniLM-L-6-v2",
    "sentence-transformers/all-MiniLM-L6-v2": MODELS_DIR / "all-MiniLM-L6-v2",
}


def download_one(repo_id: str, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    print(f"\nDownloading {repo_id}")
    print(f"  -> {dest}")
    snapshot_download(
        repo_id=repo_id,
        local_dir=str(dest),
    )
    print(f"  Done: {repo_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download DocuMind RAG model weights")
    parser.add_argument(
        "--skip-llm",
        action="store_true",
        help="Skip Qwen2-1.5B (largest download). Embedding models are still fetched.",
    )
    args = parser.parse_args()

    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    for repo_id, dest in MODELS.items():
        if args.skip_llm and dest.name == "qwen":
            print("Skipping Qwen LLM (--skip-llm).")
            continue
        download_one(repo_id, dest)

    print("\nAll requested models are in the models/ folder.")
    print("Optional QLoRA adapters belong in models/qwen_qlora_adapters/ after training.")


if __name__ == "__main__":
    main()

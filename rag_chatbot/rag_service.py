from __future__ import annotations

import os
import sys
from typing import List, Optional, Union


_loaded = False
_ask_fn = None
_error: Optional[str] = None


def _ensure_backend_on_path() -> None:
    # Root RAG scripts: rag_pipeline.py, embeddings.py, train_qlora.py
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)


def load() -> None:
    """
    Loads the heavy RAG components once.
    Safe to call multiple times; only runs the import/initialization once.
    """
    global _loaded, _ask_fn, _error

    if _loaded or _ask_fn is not None:
        return

    try:
        _ensure_backend_on_path()
        from rag_pipeline import ask  # noqa: F401

        _ask_fn = ask
        _loaded = True
    except Exception as e:  # pragma: no cover
        _error = str(e)
        _loaded = False
        raise


def is_ready() -> bool:
    return _loaded


def ready_error() -> Optional[str]:
    return _error


def query(
    question: str,
    *,
    candidate_k: int = 20,
    top_k: int = 5,
    threshold: float = 0.45,
    collection_name: Optional[Union[str, List[str]]] = "pdf_markdown_embeddings",
) -> str:
    """
    Call the RAG pipeline. Returns the answer string.
    Raises RuntimeError if models are not loaded yet.
    """
    if not _loaded or _ask_fn is None:
        raise RuntimeError("RAG models not loaded yet")

    answer = _ask_fn(
        question=question,
        candidate_k=candidate_k,
        top_k=top_k,
        threshold=threshold,
        collection_name=collection_name,
    )
    return answer


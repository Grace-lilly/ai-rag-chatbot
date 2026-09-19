from __future__ import annotations

import os
import queue
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
import shutil
from typing import Any, Callable, Dict, Optional
import sys

import fitz  # PyMuPDF


jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()

finetune_running = False
_finetune_lock = threading.Lock()


def _project_root() -> Path:
    # Using scripts in the repository root next to rag_pipeline.py, embeddings.py, etc.
    return Path(__file__).resolve().parent.parent


def extract_pdf_text(pdf_path: str) -> str:
    """Extract text from PDF using PyMuPDF."""
    doc = fitz.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text


def _push_event(job_id: str, event: dict) -> None:
    job = jobs.get(job_id)
    if not job:
        return
    q: "queue.Queue[dict]" = job["event_queue"]
    q.put(event)


def run_pipeline(
    pdf_path: str,
    is_temp: bool = False,
    *,
    document_id: Optional[int] = None,
    on_document_status: Optional[Callable[[str], None]] = None,
    user_id: Optional[int] = None,
    session_id: Optional[str] = None,
) -> str:
    """
    Starts the full (marker -> embeddings) pipeline in a background thread.

    For this app, Step 3 fine-tuning is NOT run automatically for uploads.
    Instead, fine-tuning is exposed via /api/doc/finetune.
    """
    job_id = str(uuid.uuid4())[:8]
    created_at = time.time()

    with _jobs_lock:
        jobs[job_id] = {
            "created_at": created_at,
            "done": False,
            "failed": False,
            "is_temp": is_temp,
            "document_id": document_id,
            "event_queue": queue.Queue(),
            "steps": [
                {"step": 0, "name": "PDF → Text (PyMuPDF)", "status": "queued", "message": ""},
                {"step": 1, "name": "Generate Embeddings (embeddings.py)", "status": "queued", "message": ""},
            ],
        }

    project_root = _project_root()
    pdf_path = str(pdf_path)
    base_markdown_dir = project_root / "data" / "markdowns"
    markdown_dir = base_markdown_dir / ("temp" if is_temp else "perm") / job_id
    # marker_cmd = os.environ.get("MARKER_SINGLE_CMD", "marker_single")

    # Determine collection name
    if is_temp and user_id and session_id:
        collection_name = f"user_{user_id}_temp_{session_id}_v1"
    else:
        collection_name = "pdf_markdown_embeddings"

    def _run() -> None:
        try:
            # Step 1: PDF → Markdown (using PyMuPDF)
            jobs[job_id]["steps"][0]["status"] = "running"
            _push_event(job_id, {"step": 0, "status": "running", "message": ""})

            markdown_dir.mkdir(parents=True, exist_ok=True)

            try:
                text = extract_pdf_text(pdf_path)
                # Save as markdown
                pdf_name = Path(pdf_path).stem
                md_path = markdown_dir / f"{pdf_name}.md"
                with open(md_path, "w", encoding="utf-8") as f:
                    f.write(text)
                msg = "Text extracted from PDF"
            except Exception as e:
                msg = f"PDF extraction failed: {str(e)}"
                jobs[job_id]["steps"][0]["status"] = "failed"
                jobs[job_id]["steps"][0]["message"] = msg
                _push_event(job_id, {"step": 0, "status": "failed", "message": msg})
                jobs[job_id]["failed"] = True
                if on_document_status:
                    on_document_status("failed")
                return

            jobs[job_id]["steps"][0]["status"] = "done"
            _push_event(job_id, {"step": 0, "status": "done", "message": msg})

            # Step 2
            jobs[job_id]["steps"][1]["status"] = "running"
            _push_event(job_id, {"step": 1, "status": "running", "message": ""})

            try:
                result = subprocess.run(
                    [
                        sys.executable,
                        "embeddings.py",
                        "--collection",
                        collection_name,
                        "--markdown-dir",
                        str(markdown_dir),
                    ],
                    capture_output=True,
                    text=True,
                    cwd=str(project_root),
                )
            except FileNotFoundError:
                result = None

            if result is None or result.returncode != 0:
                stderr = "" if result is None else (result.stderr or "")
                stdout = "" if result is None else (result.stdout or "")
                msg = stderr.strip() or stdout.strip() or "embeddings.py failed"
                jobs[job_id]["steps"][1]["status"] = "failed"
                jobs[job_id]["steps"][1]["message"] = msg
                _push_event(job_id, {"step": 1, "status": "failed", "message": msg})
                jobs[job_id]["failed"] = True
                if on_document_status:
                    on_document_status("failed")
                return

            jobs[job_id]["steps"][1]["status"] = "done"
            _push_event(job_id, {"step": 1, "status": "done", "message": "Embeddings ingested into ChromaDB"})
            jobs[job_id]["done"] = True
            if on_document_status:
                on_document_status("indexed")
            if is_temp:
                try:
                    shutil.rmtree(markdown_dir)
                except Exception:
                    pass
        finally:
            # Make sure SSE consumers don't hang forever if the thread exits unexpectedly.
            job = jobs.get(job_id)
            if job and not job.get("done") and not job.get("failed"):
                jobs[job_id]["failed"] = True
                _push_event(job_id, {"step": -1, "status": "failed", "message": "Pipeline terminated unexpectedly"})

    threading.Thread(target=_run, daemon=True).start()
    return job_id


def run_finetune() -> str:
    """
    Starts train_qlora.py in a background thread.
    """
    global finetune_running
    job_id = str(uuid.uuid4())[:8]

    with _finetune_lock:
        finetune_running = True

    with _jobs_lock:
        jobs[job_id] = {
            "created_at": time.time(),
            "done": False,
            "failed": False,
            "event_queue": queue.Queue(),
            "steps": [
                {"step": 2, "name": "Fine-tune Model (train_qlora.py)", "status": "queued", "message": ""},
            ],
        }

    project_root = _project_root()

    def _run() -> None:
        try:
            jobs[job_id]["steps"][0]["status"] = "running"
            _push_event(job_id, {"step": 2, "status": "running", "message": ""})

            try:
                result = subprocess.run(
                    [sys.executable, "train_qlora.py"],
                    capture_output=True,
                    text=True,
                    cwd=str(project_root),
                )
            except FileNotFoundError:
                result = None

            if result is None or result.returncode != 0:
                stderr = "" if result is None else (result.stderr or "")
                msg = stderr.strip() or "train_qlora.py failed"
                jobs[job_id]["steps"][0]["status"] = "failed"
                jobs[job_id]["steps"][0]["message"] = msg
                _push_event(job_id, {"step": 2, "status": "failed", "message": msg})
                jobs[job_id]["failed"] = True
                return

            jobs[job_id]["steps"][0]["status"] = "done"
            _push_event(job_id, {"step": 2, "status": "done", "message": "Fine-tuning complete"})
            jobs[job_id]["done"] = True
        finally:
            global finetune_running
            with _finetune_lock:
                finetune_running = False

    threading.Thread(target=_run, daemon=True).start()
    return job_id


def get_event_queue(job_id: str) -> Optional["queue.Queue[dict]"]:
    job = jobs.get(job_id)
    if not job:
        return None
    return job["event_queue"]


def job_exists(job_id: str) -> bool:
    return job_id in jobs


def get_job_status(job_id: str) -> Optional[dict]:
    return jobs.get(job_id)


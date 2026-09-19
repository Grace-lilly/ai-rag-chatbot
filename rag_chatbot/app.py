from __future__ import annotations

import json
import os
import sys
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import queue

import chromadb
import torch
try:
    import magic  # python-magic (requires libmagic on some platforms)
except Exception:  # pragma: no cover
    magic = None
from flask import (
    Flask,
    Response,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    session as flask_session,
    stream_with_context,
    url_for,
)
from flask_login import (
    LoginManager,
    current_user,
    login_required,
    login_user,
    logout_user,
)
from flask_wtf import FlaskForm
from sqlalchemy import func
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename
from wtforms import PasswordField, StringField
from wtforms.validators import DataRequired, Email, EqualTo, Length, Regexp


def _collection_exists_with_docs(collection_name: str) -> bool:
    try:
        client = chromadb.PersistentClient(path=str(Config.CHROMA_DIR))
        if collection_name not in [c.name for c in client.list_collections()]:
            return False
        return client.get_collection(collection_name).count() > 0
    except Exception:
        return False

try:
    from .config import Config
    from .models import ChatSession, Document, Message, User, db, new_session_id, new_message_id
    from . import rag_service as rag_pipeline
    from . import pipeline_runner
except ImportError:  # pragma: no cover
    # Allows running via: `python rag_chatbot/app.py`
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)
    from rag_chatbot.config import Config
    from rag_chatbot.models import ChatSession, Document, Message, User, db, new_session_id, new_message_id
    from rag_chatbot import rag_service as rag_pipeline
    from rag_chatbot import pipeline_runner


login_manager = LoginManager()


class LoginForm(FlaskForm):
    username_email = StringField(
        "Username or Email",
        validators=[DataRequired()],
    )
    password = PasswordField("Password", validators=[DataRequired()])


class RegisterForm(FlaskForm):
    full_name = StringField("Full Name", validators=[DataRequired(), Length(min=2, max=120)])
    username = StringField(
        "Username",
        validators=[
            DataRequired(),
            Length(min=3, max=20),
            Regexp(r"^[a-zA-Z0-9_]{3,20}$", message="Username must be 3-20 chars: alphanumeric + underscore."),
        ],
    )
    email = StringField("Email", validators=[DataRequired(), Email()])
    password = PasswordField("Password", validators=[DataRequired(), Length(min=6, max=200)])
    confirm_password = PasswordField(
        "Confirm Password",
        validators=[DataRequired(), EqualTo("password", message="Passwords do not match.")],
    )


def _project_paths() -> dict:
    backend_root = Path(__file__).resolve().parent.parent
    return {"backend_root": backend_root}


def _format_datetime(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _rag_models_background_load() -> None:
    try:
        rag_pipeline.load()
    except Exception as e:  # pragma: no cover
        # Keep server alive; /api/status will show rag_ready=false.
        print(f"RAG loading failed: {e}")


def create_app() -> Flask:
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_object(Config)

    # Ensure instance folder exists for SQLite.
    Path(app.instance_path).mkdir(parents=True, exist_ok=True)

    db.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "auth"

    @login_manager.user_loader
    def load_user(user_id: str) -> Optional[User]:
        return User.query.get(int(user_id))

    with app.app_context():
        db.create_all()

    # Load models once without blocking the server start.
    threading.Thread(target=_rag_models_background_load, daemon=True).start()

    @app.get("/")
    def index():
        if current_user.is_authenticated:
            return redirect(url_for("chat"))
        return redirect(url_for("auth"))

    @app.get("/auth")
    def auth():
        return render_template("auth.html", login_form=LoginForm(), register_form=RegisterForm())

    @app.post("/auth/login")
    def auth_login():
        form = LoginForm()
        if not form.validate_on_submit():
            flash("Please check your credentials.", "error")
            return redirect(url_for("auth"))

        username_email = form.username_email.data.strip()
        password = form.password.data

        user = User.query.filter(
            (User.username == username_email) | (User.email == username_email)
        ).first()

        if not user or not check_password_hash(user.password_hash, password):
            flash("Invalid username/email or password.", "error")
            return redirect(url_for("auth"))

        login_user(user)
        return redirect(url_for("chat"))

    @app.post("/auth/register")
    def auth_register():
        form = RegisterForm()
        if not form.validate_on_submit():
            flash("Please correct the highlighted fields.", "error")
            return redirect(url_for("auth"))

        existing = User.query.filter(
            (User.username == form.username.data) | (User.email == form.email.data)
        ).first()
        if existing:
            flash("Username or email already exists.", "error")
            return redirect(url_for("auth"))

        user = User(
            username=form.username.data.strip(),
            email=form.email.data.strip(),
            full_name=form.full_name.data.strip(),
            password_hash=generate_password_hash(form.password.data, method="pbkdf2:sha256"),
            is_admin=False,
        )
        db.session.add(user)
        db.session.commit()
        flash("Account created successfully. Please sign in.", "success")
        return redirect(url_for("auth"))

    @app.get("/auth/logout")
    def auth_logout():
        # Clean up temp uploads for the active session (if present).
        active_temp_session_id = flask_session.get("active_temp_session_id")
        if active_temp_session_id:
            temp_dir = Config.UPLOADS_TEMP_DIR / str(active_temp_session_id)
            try:
                if temp_dir.exists():
                    shutil.rmtree(temp_dir)
            except Exception:
                pass

            # Also delete the entire temp Chroma collection for this session.
            # Naming scheme (from the redesign):
            #   user_{uid}_temp_{chat_session_id}_{TEMP_VERSION}
            # For robustness, we delete any Chroma collection whose name matches:
            #   user_{uid}_temp_{active_temp_session_id}_
            try:
                client = chromadb.PersistentClient(path=str(Config.CHROMA_DIR))
                prefix = f"user_{current_user.id}_temp_{active_temp_session_id}_"
                for col in client.list_collections():
                    name = getattr(col, "name", "")
                    if name.startswith(prefix):
                        try:
                            client.delete_collection(name)
                        except Exception:
                            pass
            except Exception:
                pass

        flask_session.pop("active_temp_session_id", None)
        logout_user()
        return redirect(url_for("auth"))

    @app.get("/chat")
    @login_required
    def chat():
        return render_template("chat.html", can_finetune=current_user.is_admin)

    # ---------------------------
    # Chat API
    # ---------------------------
    @app.get("/api/chat/sessions")
    @login_required
    def api_chat_sessions():
        sessions = (
            ChatSession.query.filter_by(user_id=current_user.id, is_temporary=False)
            .order_by(ChatSession.updated_at.desc())
            .all()
        )

        out = []
        for s in sessions:
            out.append(
                {
                    "id": s.id,
                    "title": s.title or "Untitled Conversation",
                    "created_at": _format_datetime(s.created_at),
                    "updated_at": _format_datetime(s.updated_at),
                }
            )
        return jsonify({"sessions": out})

    @app.post("/api/chat/new")
    @login_required
    def api_chat_new():
        payload = request.get_json(silent=True) or {}
        temp_mode = bool(payload.get("temp_mode", False))

        session_id = new_session_id()
        if temp_mode:
            flask_session["active_temp_session_id"] = session_id
            return jsonify({"session_id": session_id})

        s = ChatSession(
            id=session_id,
            user_id=current_user.id,
            title="",
            is_temporary=False,
        )
        db.session.add(s)
        db.session.commit()
        return jsonify({"session_id": session_id})

    @app.get("/api/chat/<id>/messages")
    @login_required
    def api_chat_messages(id: str):
        if flask_session.get("active_temp_session_id") == id:
            return jsonify({"session_id": id, "messages": []})

        s = ChatSession.query.filter_by(id=id, user_id=current_user.id).first()
        if not s:
            return jsonify({"error": "Session not found"}), 404

        messages = Message.query.filter_by(session_id=id).order_by(Message.created_at.asc()).all()
        out = []
        for m in messages:
            out.append(
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "created_at": _format_datetime(m.created_at),
                }
            )
        return jsonify({"session_id": id, "messages": out})

    @app.post("/api/chat/message")
    @login_required
    def api_chat_message():
        payload = request.get_json(silent=True) or {}
        question = (payload.get("question") or "").strip()
        session_id = payload.get("session_id")
        temp_mode = bool(payload.get("temp_mode", False))

        if not question:
            return jsonify({"error": "Question is required"}), 400

        # If session_id is missing, create a new session.
        if temp_mode:
            if not session_id:
                session_id = new_session_id()
            flask_session["active_temp_session_id"] = session_id
            s = None
        else:
            if not session_id:
                session_id = new_session_id()
                s = ChatSession(
                    id=session_id,
                    user_id=current_user.id,
                    title=question[:50],
                    is_temporary=False,
                )
                db.session.add(s)
                db.session.commit()
            else:
                s = ChatSession.query.filter_by(id=session_id, user_id=current_user.id).first()
                if not s:
                    return jsonify({"error": "Session not found"}), 404
                if not s.title:
                    s.title = question[:50]
                # Always bump timestamps so sidebar ordering reflects new activity.
                s.updated_at = datetime.now(timezone.utc)
                db.session.commit()

        if not rag_pipeline.is_ready():
            return jsonify({"error": "RAG engine not ready"}), 503

        # Determine collection name.
        # Temp chat should use only the uploaded temporary documents,
        # not the shared permanent collection, to avoid unrelated answers.
        if temp_mode and session_id:
            temp_collection_name = f"user_{current_user.id}_temp_{session_id}_v1"
            if _collection_exists_with_docs(temp_collection_name):
                collection_name = [temp_collection_name]
            else:
                collection_name = None
        else:
            collection_name = Config.CHROMA_COLLECTION_NAME if _collection_exists_with_docs(Config.CHROMA_COLLECTION_NAME) else None

        # Save user message only for non-temporary chats.
        if not temp_mode:
            user_msg = Message(
                id=new_message_id(),
                session_id=session_id,
                role="user",
                content=question,
            )
            db.session.add(user_msg)
            db.session.commit()

        try:
            answer = rag_pipeline.query(
                question,
                candidate_k=6,
                top_k=1,
                threshold=0.35,
                collection_name=collection_name,
            )
        except Exception as e:
            return jsonify({"error": f"Could not reach RAG engine: {e}"}), 500

        # Save assistant message only for non-temporary chats.
        if not temp_mode:
            assistant_msg = Message(
                id=new_message_id(),
                session_id=session_id,
                role="assistant",
                content=answer,
            )
            db.session.add(assistant_msg)
            # updated_at handled by event listener.
            db.session.commit()

        return jsonify({"answer": answer, "session_id": session_id})

    @app.delete("/api/chat/<id>")
    @login_required
    def api_chat_delete(id: str):
        s = ChatSession.query.filter_by(id=id, user_id=current_user.id).first()
        if not s:
            return jsonify({"error": "Session not found"}), 404

        db.session.delete(s)
        db.session.commit()
        # Temp files clean-up (if this session was used for temp docs)
        try:
            temp_dir = Config.UPLOADS_TEMP_DIR / str(id)
            if temp_dir.exists():
                shutil.rmtree(temp_dir)
        except Exception:
            pass

        return jsonify({"ok": True})

    # ---------------------------
    # Document API
    # ---------------------------
    def _validate_pdf_file(upload) -> None:
        if not upload:
            raise ValueError("No file provided")
        if not upload.filename:
            raise ValueError("Empty filename")

        # Server-side MIME validation via python-magic (if available).
        # If libmagic isn't available, we fall back to filename extension.
        if magic is not None:
            buf = upload.stream.read(4096)
            upload.stream.seek(0)
            m = magic.Magic(mime=True)
            mime_type = m.from_buffer(buf)
            if mime_type != "application/pdf":
                raise ValueError(f"Invalid file type: {mime_type}. Only PDFs are allowed.")
        else:
            if not upload.filename.lower().endswith(".pdf"):
                raise ValueError("Invalid file type. Only PDFs are allowed.")

    @app.post("/api/doc/upload")
    @login_required
    def api_doc_upload():
        if "file" not in request.files:
            return jsonify({"error": "Missing file"}), 400
        upload = request.files["file"]

        try:
            _validate_pdf_file(upload)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        filename = secure_filename(upload.filename)
        if not filename.lower().endswith(".pdf"):
            filename += ".pdf"

        user_dir = Config.UPLOADS_PERMANENT_DIR / str(current_user.id)
        user_dir.mkdir(parents=True, exist_ok=True)

        stored_name = f"{uuid.uuid4().hex}_{filename}"
        pdf_path = user_dir / stored_name
        upload.save(str(pdf_path))

        file_size = pdf_path.stat().st_size

        doc = Document(
            user_id=current_user.id,
            filename=stored_name,
            original_filename=filename,
            file_size_bytes=file_size,
            status="processing",
            is_temporary=False,
        )
        db.session.add(doc)
        db.session.commit()

        def _update(status: str) -> None:
            with app.app_context():
                doc_obj = Document.query.get(doc.id)
                if not doc_obj:
                    return
                doc_obj.status = status
                doc_obj.indexed_at = datetime.now(timezone.utc) if status == "indexed" else None
                db.session.commit()

        job_id = pipeline_runner.run_pipeline(
            str(pdf_path),
            is_temp=False,
            document_id=doc.id,
            on_document_status=_update,
        )

        return jsonify({"job_id": job_id, "filename": filename})

    @app.get("/api/doc/list")
    @login_required
    def api_doc_list():
        docs = Document.query.filter_by(user_id=current_user.id, is_temporary=False).order_by(Document.created_at.desc()).all()
        out = []
        for d in docs:
            out.append(
                {
                    "id": d.id,
                    "filename": d.filename,
                    "original_filename": d.original_filename,
                    "file_size_bytes": d.file_size_bytes,
                    "status": d.status,
                    "is_temporary": d.is_temporary,
                    "created_at": _format_datetime(d.created_at),
                    "indexed_at": _format_datetime(d.indexed_at),
                }
            )
        return jsonify({"documents": out})

    @app.delete("/api/doc/<int:id>")
    @login_required
    def api_doc_delete(id: int):
        d = Document.query.filter_by(id=id, user_id=current_user.id).first()
        if not d:
            return jsonify({"error": "Document not found"}), 404

        # Best-effort file deletion.
        try:
            pdf_path = Config.UPLOADS_PERMANENT_DIR / str(current_user.id) / d.filename
            if pdf_path.exists():
                pdf_path.unlink()
        except Exception:
            pass

        db.session.delete(d)
        db.session.commit()
        return jsonify({"ok": True})

    @app.post("/api/doc/finetune")
    @login_required
    def api_doc_finetune():
        if not current_user.is_admin:
            return jsonify({"error": "Forbidden"}), 403
        job_id = pipeline_runner.run_finetune()
        return jsonify({"job_id": job_id})

    @app.post("/api/doc/temp/upload")
    @login_required
    def api_doc_temp_upload():
        if "file" not in request.files:
            return jsonify({"error": "Missing file"}), 400
        upload = request.files["file"]

        payload = request.form.to_dict()
        session_id = payload.get("session_id")
        if not session_id:
            return jsonify({"error": "Missing session_id"}), 400

        if flask_session.get("active_temp_session_id") != session_id:
            return jsonify({"error": "Temp session not found"}), 404

        try:
            _validate_pdf_file(upload)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        filename = secure_filename(upload.filename)
        if not filename.lower().endswith(".pdf"):
            filename += ".pdf"

        temp_dir = Config.UPLOADS_TEMP_DIR / str(session_id)
        temp_dir.mkdir(parents=True, exist_ok=True)

        stored_name = f"{uuid.uuid4().hex}_{filename}"
        pdf_path = temp_dir / stored_name
        upload.save(str(pdf_path))

        flask_session["active_temp_session_id"] = session_id

        job_id = pipeline_runner.run_pipeline(str(pdf_path), is_temp=True, user_id=current_user.id, session_id=session_id)
        return jsonify({"job_id": job_id, "filename": filename, "stored_name": stored_name})

    @app.delete("/api/doc/temp")
    @login_required
    def api_doc_temp_delete():
        session_id = flask_session.get("active_temp_session_id")
        if not session_id:
            return jsonify({"error": "No temp doc active for this session"}), 400

        temp_dir = Config.UPLOADS_TEMP_DIR / str(session_id)
        if temp_dir.exists():
            try:
                shutil.rmtree(temp_dir)
            except Exception:
                pass
        return jsonify({"ok": True})

    @app.delete("/api/doc/temp/<path:file_id>")
    @login_required
    def api_doc_temp_delete_one(file_id: str):
        session_id = flask_session.get("active_temp_session_id")
        if not session_id:
            return jsonify({"error": "No temp doc active for this session"}), 400

        temp_dir = Config.UPLOADS_TEMP_DIR / str(session_id)
        target_path = temp_dir / file_id
        if target_path.exists():
            try:
                target_path.unlink()
            except Exception:
                pass

        # Remove associated chunks from the temp Chroma collection if present.
        collection_name = f"user_{current_user.id}_temp_{session_id}_v1"
        try:
            client = chromadb.PersistentClient(path=str(Config.CHROMA_DIR))
            if collection_name in [c.name for c in client.list_collections()]:
                collection = client.get_collection(collection_name)
                source_name = f"{Path(file_id).stem}.md"
                stored = collection.get(include=["ids", "metadatas"])
                ids_to_remove = [doc_id for doc_id, metadata in zip(stored["ids"], stored["metadatas"]) if metadata.get("source") == source_name]
                if ids_to_remove:
                    collection.delete(ids=ids_to_remove)
        except Exception:
            pass

        return jsonify({"ok": True})

    # ---------------------------
    # Pipeline status (SSE)
    # ---------------------------
    @app.get("/api/pipeline/status/<job_id>")
    @login_required
    def api_pipeline_status(job_id: str):
        q = pipeline_runner.get_event_queue(job_id)
        if q is None:
            return jsonify({"error": "Job not found"}), 404

        job = pipeline_runner.get_job_status(job_id) or {}

        def generate():
            # Stream events until job marks done/failed.
            while True:
                try:
                    event = q.get(timeout=1.0)
                except queue.Empty:
                    # If job completed and queue drained, stop.
                    job_state = pipeline_runner.get_job_status(job_id) or {}
                    if (job_state.get("done") or job_state.get("failed")) and q.empty():
                        break
                    # Heartbeat to keep connections alive.
                    yield ":\n\n"
                    continue

                payload = json.dumps(event)
                yield f"data: {payload}\n\n"

                job_state = pipeline_runner.get_job_status(job_id) or {}
                if job_state.get("done") or job_state.get("failed"):
                    # Wait until queue drains.
                    if q.empty():
                        break

        return Response(stream_with_context(generate()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})

    # ---------------------------
    # System status
    # ---------------------------
    @app.get("/api/status")
    @login_required
    def api_status():
        rag_ready = rag_pipeline.is_ready()
        finetune = pipeline_runner.finetune_running

        # Document count
        with app.app_context():
            doc_count = Document.query.filter_by(user_id=current_user.id, is_temporary=False, status="indexed").count()

        # Chroma chunk count
        try:
            client = chromadb.PersistentClient(path=str(Config.CHROMA_DIR))
            collection = client.get_collection(Config.CHROMA_COLLECTION_NAME)
            chunk_count = collection.count()
        except Exception:
            chunk_count = 0

        return jsonify(
            {
                "rag_ready": rag_ready,
                "rag_error": rag_pipeline.ready_error(),
                "doc_count": doc_count,
                "chunk_count": chunk_count,
                "finetune_running": finetune,
                "gpu_available": torch.cuda.is_available(),
                "gpu_count": torch.cuda.device_count(),
                "cuda_version": torch.version.cuda,
            }
        )

    return app


if __name__ == "__main__":
    application = create_app()
    application.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)


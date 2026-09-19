from __future__ import annotations

import uuid
from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from sqlalchemy import event


db = SQLAlchemy()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(db.Model, UserMixin):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    username = db.Column(db.String(50), unique=True, nullable=False, index=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    full_name = db.Column(db.String(120), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    chat_sessions = db.relationship(
        "ChatSession",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ChatSession(db.Model):
    __tablename__ = "chat_sessions"

    id = db.Column(db.String(64), primary_key=True)  # UUID string
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = db.Column(db.String(200), nullable=False, default="")
    is_temporary = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    user = db.relationship("User", back_populates="chat_sessions")
    messages = db.relationship(
        "Message",
        back_populates="session",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Message.created_at",
    )


class Message(db.Model):
    __tablename__ = "messages"

    id = db.Column(db.String(64), primary_key=True)  # UUID string
    session_id = db.Column(db.String(64), db.ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    role = db.Column(db.String(20), nullable=False)  # "user" | "assistant"
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    session = db.relationship("ChatSession", back_populates="messages")


class Document(db.Model):
    __tablename__ = "documents"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    filename = db.Column(db.String(200), nullable=False)  # stored filename
    original_filename = db.Column(db.String(200), nullable=False)
    file_size_bytes = db.Column(db.Integer, nullable=False, default=0)
    status = db.Column(db.String(30), nullable=False, default="processing")  # processing | indexed | failed
    is_temporary = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    indexed_at = db.Column(db.DateTime, nullable=True)


@event.listens_for(ChatSession, "before_update")
def _chat_session_before_update(mapper, connection, target: ChatSession):
    # Keep timestamps consistent for sidebar sorting.
    target.updated_at = utcnow()


def new_session_id() -> str:
    return str(uuid.uuid4())


def new_message_id() -> str:
    return str(uuid.uuid4())


const state = {
  currentSessionId: null,
  isTempMode: false,
  hasTempDoc: false,
  tempDocs: [],
  ragReady: false,
  isLoading: false,
  activeTempFilename: null,
  isIndexing: false,
  pipelineBusyCount: 0,
  completedPipelineJobs: {},
};

let currentAbortController = null;

const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));

function applyThemeFromStorage() {
  const t = localStorage.getItem("theme") || "dark";
  document.documentElement.dataset.theme = t;
}

function wireThemeToggle() {
  qsa("[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-theme") || "dark";
      localStorage.setItem("theme", t);
      document.documentElement.dataset.theme = t;
    });
  });
}

function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function showToast(message, type = "error") {
  const container = qs("#toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type} show`;

  toast.innerHTML = `
    <div class="toast-row">
      <div class="toast-msg">${escapeHtml(message)}</div>
      <button class="toast-close" type="button" aria-label="Dismiss">✕</button>
    </div>
  `;

  container.appendChild(toast);

  const close = () => toast.remove();
  toast.querySelector(".toast-close")?.addEventListener("click", close);
  setTimeout(close, 5000);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setTempModeUI(on) {
  state.isTempMode = !!on;

  const btn = qs("#temp-chat-btn");
  const badge = qs("#temp-chat-badge");
  if (btn) btn.classList.toggle("active", state.isTempMode);
  if (badge) badge.style.display = state.isTempMode ? "inline-block" : "none";
}

function openDrawer(which) {
  const perm = qs("#permanent-drawer");
  const temp = qs("#temp-drawer");
  if (which === "permanent") {
    perm?.classList.add("open");
  } else {
    temp?.classList.add("open");
  }
}

function closeDrawer() {
  qs("#permanent-drawer")?.classList.remove("open");
  qs("#temp-drawer")?.classList.remove("open");
}

function toggleSidebar() {
  qs("#sidebar")?.classList.toggle("closed");
}

function _parseIsoTimestamp(iso) {
  if (!iso) return new Date(NaN);
  const str = String(iso).trim();
  const hasOffset = /[Zz]|[+-]\d{2}:?\d{2}$/.test(str);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(str) && !hasOffset) {
    return new Date(str + "Z");
  }
  return new Date(str);
}

function formatRelativeTime(iso) {
  const dt = _parseIsoTimestamp(iso);
  if (Number.isNaN(dt.getTime())) {
    return "Unknown";
  }

  const diffMs = Date.now() - dt.getTime();
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 10) {
    return "Just now";
  }
  if (seconds < 60) {
    return `${seconds} seconds ago`;
  }
  if (minutes === 1) {
    return "1 minute ago";
  }
  if (minutes < 60) {
    return `${minutes} minutes ago`;
  }
  if (hours === 1) {
    return "1 hour ago";
  }
  if (hours < 24) {
    return `${hours} hours ago`;
  }
  return `${days} days ago`;
}

function dayGroupKey(iso) {
  const dt = _parseIsoTimestamp(iso);
  if (Number.isNaN(dt.getTime())) return "OLDER";

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfThat = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const daysDiff = Math.round((startOfToday - startOfThat) / (24 * 60 * 60 * 1000));

  if (daysDiff === 0) return "TODAY";
  if (daysDiff === 1) return "YESTERDAY";
  if (daysDiff <= 7) return "THIS WEEK";
  return "OLDER";
}

function renderSessionItem(s) {
  const el = document.createElement("div");
  el.className = "session-item";
  el.dataset.sessionId = s.id;

  el.innerHTML = `
    <div class="session-title">${escapeHtml(s.title || "Untitled Conversation")}</div>
    <div class="session-meta-row">
      <div class="session-time">${escapeHtml(formatRelativeTime(s.updated_at || s.created_at))}</div>
      <button class="delete-icon" type="button" data-delete-session="${s.id}" aria-label="Delete session">🗑</button>
    </div>
  `;

  el.addEventListener("click", () => {
    state.currentSessionId = s.id;
    qsa(".session-item").forEach((x) => x.classList.remove("active"));
    el.classList.add("active");
    loadSession(s.id);
  });

  el.querySelector(`[data-delete-session="${s.id}"]`)?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    inlineDeleteSession(s.id, el);
  });

  return el;
}

function inlineDeleteSession(id, el) {
  const title = el.querySelector(".session-title")?.textContent || "conversation";
  el.innerHTML = `
    <div style="font-family: 'IBM Plex Mono', monospace; color: var(--text-muted); font-size: 11px;">
      Delete? <span style="color: var(--text-dim)">${escapeHtml(title.slice(0, 22))}</span>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px;">
      <button type="button" class="btn-secondary" data-del-no>No</button>
      <button type="button" class="btn-warning" data-del-yes>Yes</button>
    </div>
  `;

  el.classList.remove("active");

  const noBtn = el.querySelector("[data-del-no]");
  const yesBtn = el.querySelector("[data-del-yes]");
  noBtn?.addEventListener("click", () => loadSidebarHistory());
  yesBtn?.addEventListener("click", async () => {
    try {
      await fetch(`/api/chat/${id}`, { method: "DELETE" });
      showToast("Session deleted.", "success");
    } catch (e) {
      showToast("Could not delete session.", "error");
    } finally {
      if (state.currentSessionId === id) {
        state.currentSessionId = null;
      }
      await loadSidebarHistory();
      renderEmptyState();
    }
  });
}

function renderEmptyState() {
  const empty = qs("#empty-state");
  if (empty) empty.style.display = "flex";
  qsa("#messages .bubble-row, #messages .typing-indicator").forEach((x) => x.remove());
}

function showEmptyIfNoMessages() {
  const container = qs("#messages");
  const empty = qs("#empty-state");
  if (!container || !empty) return;
  const rows = qsa("#messages .bubble-row");
  empty.style.display = rows.length === 0 ? "flex" : "none";
}

function renderUserBubble(text, timestamp) {
  const row = document.createElement("div");
  row.className = "bubble-row user message-enter";
  row.innerHTML = `
    <div class="bubble user">
      <div class="bubble-content"></div>
      <div class="meta-row">
        <span>YOU · ${escapeHtml(timestamp)}</span>
      </div>
    </div>
  `;
  row.querySelector(".bubble-content").textContent = text;
  return row;
}

function renderAIBubble(text, timestamp, { typewriter = false } = {}) {
  const row = document.createElement("div");
  row.className = "bubble-row assistant message-enter";
  row.innerHTML = `
    <div class="bubble assistant">
      <div class="bubble-header">
        <div class="ai-avatar">AI</div>
      </div>
      <div class="bubble-content"></div>
      <div class="meta-row">
        <span>AI · ${escapeHtml(timestamp)}</span>
        <button class="copy-btn" type="button" data-copy>📋 Copy</button>
      </div>
    </div>
  `;

  const contentEl = row.querySelector(".bubble-content");
  const copyBtn = row.querySelector("[data-copy]");

  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "📋 Copy"), 2000);
    } catch {
      showToast("Clipboard permission denied.", "warning");
    }
  });

  if (!typewriter) {
    contentEl.innerHTML = safeMarkdownToHtml(text);
  } else {
    typewriterEffect(contentEl, text, () => {
      contentEl.innerHTML = safeMarkdownToHtml(text);
    });
  }

  return row;
}

function safeMarkdownToHtml(markdownText) {
  const html = window.marked ? window.marked.parse(markdownText || "") : escapeHtml(markdownText || "");
  if (window.DOMPurify) {
    return window.DOMPurify.sanitize(html);
  }
  return html;
}

function typewriterEffect(el, text, onDone) {
  el.textContent = "";
  let i = 0;
  const raw = text || "";

  const interval = setInterval(() => {
    i += 1;
    el.textContent = raw.slice(0, i);
    if (i >= raw.length) {
      clearInterval(interval);
      onDone?.();
    }
  }, 10);
}

function renderTypingIndicator() {
  const row = document.createElement("div");
  row.className = "bubble-row assistant typing-indicator message-enter";
  row.innerHTML = `
    <div class="typing-indicator">
      <div style="width:24px;height:24px;border-radius:999px;background: var(--border);display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono',monospace;color:var(--primary);font-size:10px;">AI</div>
      <div class="typing-dots" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  return row;
}

function scrollToBottom() {
  const messages = qs("#messages");
  if (!messages) return;
  messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
}

async function loadSidebarHistory() {
  const wrap = qs("#session-groups");
  if (!wrap) return;
  wrap.innerHTML = "";

  let data;
  try {
    const res = await fetch("/api/chat/sessions");
    data = await res.json();
  } catch {
    return;
  }

  const grouped = { TODAY: [], YESTERDAY: [], "THIS WEEK": [], OLDER: [] };
  (data.sessions || []).forEach((s) => {
    const k = dayGroupKey(s.updated_at || s.created_at);
    grouped[k].push(s);
  });

  Object.entries(grouped).forEach(([k, items]) => {
    if (!items.length) return;
    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = `— ${k.replaceAll("_", " ")} —`;
    wrap.appendChild(title);

    items.forEach((s) => {
      const item = renderSessionItem(s);
      if (state.currentSessionId === s.id) item.classList.add("active");
      wrap.appendChild(item);
    });
  });
}

async function loadSession(sessionId) {
  const container = qs("#messages");
  if (!container) return;
  container.querySelectorAll(".bubble-row").forEach((x) => x.remove());

  const empty = qs("#empty-state");
  if (empty) empty.style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/chat/${sessionId}/messages`);
    data = await res.json();
  } catch {
    showToast("Could not load messages.", "error");
    return;
  }

  const messages = data.messages || [];
  if (!messages.length) {
    renderEmptyState();
    return;
  }

  messages.forEach((m) => {
    if (m.role === "user") {
      container.appendChild(renderUserBubble(m.content, new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
    } else {
      container.appendChild(renderAIBubble(m.content, new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), { typewriter: false }));
    }
  });

  showEmptyIfNoMessages();
  scrollToBottom();
}

async function createNewSession() {
  const res = await fetch("/api/chat/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ temp_mode: state.isTempMode }),
  });
  const data = await res.json();
  state.currentSessionId = data.session_id;

  // New session: clear any previous temp-doc UI state.
  state.hasTempDoc = false;
  state.activeTempFilename = null;
  state.tempDocs = [];
  const tempScroll = qs("#temp-docs-scroll");
  if (tempScroll) tempScroll.style.display = "none";
  const list = qs("#temp-doc-list");
  if (list) list.innerHTML = "";
  const countEl = qs("#temp-doc-count");
  if (countEl) countEl.textContent = "0";
  const badge = qs("#temp-doc-badge");
  if (badge) {
    badge.style.display = "none";
    badge.classList.remove("amber-pulse");
  }
}

async function sendMessage(question) {
  const textarea = qs("#question-input");
  const sendBtn = qs("#send-btn");
  const cancelBtn = qs("#cancel-btn");
  if (!textarea || !sendBtn || !cancelBtn) return;

  const q = String(question || "").trim();
  if (!q) return;

  if (!state.currentSessionId) {
    await createNewSession();
  }

  const container = qs("#messages");
  const empty = qs("#empty-state");
  empty && (empty.style.display = "none");

  container.appendChild(renderUserBubble(q, nowTime()));
  scrollToBottom();

  textarea.value = "";
  updateCharCounter();

  textarea.disabled = true;
  sendBtn.disabled = true;
  cancelBtn.disabled = false;
  cancelBtn.textContent = "STOP";
  sendBtn.textContent = "";
  sendBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:10px;">⏳ Sending</span>`;

  const typing = renderTypingIndicator();
  container.appendChild(typing);
  scrollToBottom();

  currentAbortController = new AbortController();

  try {
    const res = await fetch("/api/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: currentAbortController.signal,
      body: JSON.stringify({
        question: q,
        session_id: state.currentSessionId,
        temp_mode: state.isTempMode,
      }),
    });
    const data = await res.json();
    typing.remove();

    if (!res.ok) {
      showToast(data.error || "Chat failed.", "error");
      return;
    }

    container.appendChild(renderAIBubble(data.answer, nowTime(), { typewriter: true }));
    scrollToBottom();

    if (!state.isTempMode) {
      await loadSidebarHistory();
    }
  } catch (error) {
    typing.remove();
    if (error.name === "AbortError") {
      showToast("Generation stopped.", "warning");
    } else {
      showToast("Could not reach the server.", "error");
    }
  } finally {
    currentAbortController = null;
    sendBtn.disabled = false;
    textarea.disabled = false;
    cancelBtn.disabled = true;
    sendBtn.textContent = "SEND →";
  }
}

function updateCharCounter() {
  const textarea = qs("#question-input");
  const counter = qs("#char-counter");
  if (!textarea || !counter) return;
  const len = textarea.value.length;
  counter.textContent = `${len} / 150`;
  counter.classList.toggle("show", len >= 150);
}

function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = "auto";

  const style = window.getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight || "18");
  const maxLines = 5;
  const maxHeight = lineHeight * maxLines + 18;

  el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
}

function initInputBar() {
  const textarea = qs("#question-input");
  const sendBtn = qs("#send-btn");
  const cancelBtn = qs("#cancel-btn");
  const attachBtn = qs("#attach-btn");
  const attachInput = qs("#attach-input");

  textarea?.addEventListener("input", () => {
    autoResizeTextarea(textarea);
    updateCharCounter();
    sendBtn.disabled = !textarea.value.trim();
  });

  textarea?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage(textarea.value);
    }
  });

  sendBtn?.addEventListener("click", () => sendMessage(textarea.value));

  cancelBtn?.addEventListener("click", () => {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  });

  attachBtn?.addEventListener("click", () => attachInput?.click());

  if (cancelBtn) {
    cancelBtn.disabled = true;
  }

  attachInput?.addEventListener("change", async () => {
    const file = attachInput.files?.[0];
    if (!file) return;
    // Upload as temp doc and enable temp mode for this session.
    if (!state.currentSessionId) {
      setTempModeUI(true);
      await createNewSession();
    } else if (!state.isTempMode) {
      setTempModeUI(true);
      await createNewSession();
      const container = qs("#messages");
      container.querySelectorAll(".bubble-row, .typing-indicator").forEach((x) => x.remove());
      qs("#empty-state").style.display = "flex";
    }
    await uploadTempDocument(file);
    attachInput.value = "";
  });

  updateCharCounter();
  autoResizeTextarea(textarea);
}

async function uploadDocument(file) {
  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/api/doc/upload", { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data;
}

async function uploadTempDocument(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("session_id", state.currentSessionId);

  const res = await fetch("/api/doc/temp/upload", { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Temp upload failed");

  state.hasTempDoc = true;
  state.activeTempFilename = data.filename;

  state.tempDocs.push(data.stored_name);
  const list = qs("#temp-doc-list");
  if (list) {
    const idx = state.tempDocs.length;
    const item = document.createElement("div");
    item.className = "temp-doc-item";
    item.dataset.fileId = data.stored_name || data.filename;
    item.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex:1;">
        <div class="doc-title">📄 ${escapeHtml(data.filename)}</div>
        <div class="doc-meta mono" style="font-size:10px;color:var(--text-muted);letter-spacing:1px;">
          #${idx}
        </div>
      </div>
      <button class="doc-delete" type="button" aria-label="Delete temp document">🗑</button>
    `;
    item.querySelector(".doc-delete")?.addEventListener("click", () => inlineDeleteTempDoc(data.stored_name || data.filename, item));
    list.appendChild(item);
  }

  const scroll = qs("#temp-docs-scroll");
  if (scroll) scroll.style.display = "block";
  const countEl = qs("#temp-doc-count");
  if (countEl) countEl.textContent = String(state.tempDocs.length);

  const badge = qs("#temp-doc-badge");
  if (badge) {
    badge.style.display = "inline-block";
    badge.classList.add("amber-pulse");
  }
  showToast("Saved to this session. Indexing…", "success");
  startPipelineSSE(data.job_id, "temp");

  return data;
}

function resetStepRow(rowEl) {
  rowEl?.classList.remove("running", "done", "failed");
  rowEl?.classList.add("queued");
  const stepIdx = rowEl?.dataset?.stepIdx;
  const badge = qs(`[id$='${stepIdx}']`);
  if (badge) badge.textContent = "[QUEUED]";
}

function setStepRowStatus(drawer, stepIdx, status, message) {
  let rowId = null;
  if (drawer === "permanent") {
    rowId = stepIdx === 0 ? "perm-step-0" : stepIdx === 1 ? "perm-step-1" : "perm-step-2";
  } else if (drawer === "temp") {
    rowId = stepIdx === 0 ? "temp-step-0" : "temp-step-1";
    if (stepIdx > 1) return;
  }

  const row = qs(`#${rowId}`);
  if (!row) return;
  row.classList.remove("queued", "running", "done", "failed");

  const badge = qs(
    drawer === "permanent"
      ? stepIdx === 0
        ? "#perm-badge-0"
        : stepIdx === 1
          ? "#perm-badge-1"
          : "#perm-badge-2"
      : stepIdx === 0
        ? "#temp-badge-0"
        : "#temp-badge-1"
  );

  if (status === "running") {
    row.classList.add("running");
    if (badge) badge.textContent = "[RUNNING...]";
  } else if (status === "done") {
    row.classList.add("done");
    if (badge) badge.textContent = "[DONE ✓]";
  } else if (status === "failed") {
    row.classList.add("failed");
    if (badge) badge.textContent = "[FAILED ✗]";
  } else {
    row.classList.add("queued");
    if (badge) badge.textContent = "[QUEUED]";
  }

  // Message shown in badge area (simple).
  if (message && badge) {
    badge.title = message;
  }
}

function startPipelineSSE(jobId, drawer, { resetStep2 = false } = {}) {
  // Avoid GPU contention: while embeddings are running, disable input.
  state.pipelineBusyCount += 1;
  if (state.pipelineBusyCount === 1) setChatInputDisabled(true);

  // Mark completion per job so we decrement at most once.
  state.completedPipelineJobs[jobId] = false;
  let esRef = null;

  // Reset indicators so repeated jobs show the correct timeline.
  setStepRowStatus(drawer, 0, "queued", "");
  setStepRowStatus(drawer, 1, "queued", "");
  if (drawer === "permanent" && resetStep2) setStepRowStatus(drawer, 2, "queued", "");

  const es = new EventSource(`/api/pipeline/status/${jobId}`);
  esRef = es;

  const isFinalStep = (step) => {
    // embeddings pipeline ends at step=1, finetune ends at step=2
    if (drawer === "temp") return step === 1;
    return step === 1 || step === 2;
  };

  es.onmessage = (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.step === -1) return;
      setStepRowStatus(drawer, payload.step, payload.status, payload.message);

      // Show toast on success for UX.
      if (drawer === "permanent" && payload.step === 1 && payload.status === "done") {
        loadDocumentList();
        refreshNavBadges();
        showToast("Saved to your knowledge base and indexed successfully.", "success");
      }

      if (drawer === "temp" && payload.step === 1 && payload.status === "done") {
        showToast("Temporary documents indexed for this session.", "success");
      }

      // Handle completion: done or failed at the final step (or any failure at step 0).
      if (payload.status === "failed") {
        if (!state.completedPipelineJobs[jobId]) {
          state.completedPipelineJobs[jobId] = true;
          state.pipelineBusyCount = Math.max(0, state.pipelineBusyCount - 1);
          if (state.pipelineBusyCount === 0) setChatInputDisabled(false);
        }
        const msg = payload.message || "Pipeline step failed.";
        showToast(msg, "error");
        es.close();
        return;
      }

      if (payload.status === "done" && isFinalStep(payload.step) && !state.completedPipelineJobs[jobId]) {
        state.completedPipelineJobs[jobId] = true;
        state.pipelineBusyCount = Math.max(0, state.pipelineBusyCount - 1);
        if (state.pipelineBusyCount === 0) setChatInputDisabled(false);
        es.close();
      }
    } catch {
      // ignore malformed
    }
  };
  es.onerror = () => {
    es.close();
    // If the pipeline failed/completed, we already handled toasts.
    // This error can also happen during normal stream close, so don't spam.
    if (!state.completedPipelineJobs[jobId]) {
      showToast("Pipeline SSE disconnected unexpectedly.", "error");
      state.pipelineBusyCount = Math.max(0, state.pipelineBusyCount - 1);
      if (state.pipelineBusyCount === 0) setChatInputDisabled(false);
      state.completedPipelineJobs[jobId] = true;
    }
  };
}

function setChatInputDisabled(disabled) {
  const textarea = qs("#question-input");
  const sendBtn = qs("#send-btn");
  const attachBtn = qs("#attach-btn");
  if (textarea) textarea.disabled = !!disabled;
  if (attachBtn) attachBtn.disabled = !!disabled;
  if (sendBtn && textarea) {
    if (disabled) {
      sendBtn.disabled = true;
    } else {
      sendBtn.disabled = !textarea.value.trim();
    }
  }
}

async function loadDocumentList() {
  const wrap = qs("#document-list");
  if (!wrap) return;
  wrap.innerHTML = "";

  const res = await fetch("/api/doc/list");
  const data = await res.json();
  if (!res.ok) return;

  const docs = data.documents || [];
  if (!docs.length) {
    wrap.innerHTML = `<div class="mono" style="color:var(--text-muted);font-size:11px;padding:12px;">No documents indexed yet.</div>`;
    return;
  }

  docs.forEach((d) => {
    const row = document.createElement("div");
    row.className = "doc-row";
    row.dataset.docId = d.id;

    let badgeClass = "badge-processing";
    let badgeText = d.status === "indexed" ? "✓ Indexed" : d.status === "failed" ? "✗ Failed" : "⟳ Processing";
    badgeClass =
      d.status === "indexed" ? "badge-indexed" : d.status === "failed" ? "badge-failed" : "badge-processing";

    row.innerHTML = `
      <div class="doc-left">
        <div class="doc-title">📄 ${escapeHtml(d.original_filename || d.filename)}</div>
        <div class="doc-meta">
          ${d.file_size_bytes ? Math.round(d.file_size_bytes / 1024 / 10) / 100 + " MB" : ""} •
          ${d.indexed_at ? new Date(d.indexed_at).toLocaleDateString() : new Date(d.created_at).toLocaleDateString()}
        </div>
      </div>
      <div class="doc-actions">
        <div class="${badgeClass}">${badgeText}</div>
        <button class="doc-delete" type="button" data-delete-doc="${d.id}" aria-label="Delete document">🗑</button>
      </div>
    `;

    row.querySelector(`[data-delete-doc="${d.id}"]`)?.addEventListener("click", () => inlineDeleteDoc(d.id, row));
    wrap.appendChild(row);
  });
}

function inlineDeleteDoc(docId, rowEl) {
  const original = rowEl.innerHTML;
  rowEl.innerHTML = `
    <div style="flex:1;font-family:'IBM Plex Mono',monospace;color:var(--text-muted);font-size:11px;">
      Remove from index? <span style="color:var(--text-dim);">This won't remove from embeddings.</span>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px;">
        <button type="button" class="btn-secondary" data-no>No</button>
        <button type="button" class="btn-warning" data-yes>Yes</button>
      </div>
    </div>
  `;

  rowEl.querySelector("[data-no]")?.addEventListener("click", () => {
    rowEl.innerHTML = original;
  });

  rowEl.querySelector("[data-yes]")?.addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/doc/${docId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      showToast("Document removed.", "success");
    } catch {
      showToast("Could not delete document.", "error");
    } finally {
      await loadDocumentList();
      await refreshNavBadges();
    }
  });
}

async function inlineDeleteTempDoc(fileId, itemEl) {
  const originalHtml = itemEl.innerHTML;
  itemEl.innerHTML = `
    <div style="flex:1;font-family:'IBM Plex Mono',monospace;color:var(--text-muted);font-size:11px;">
      Delete temporary document?
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px;">
        <button type="button" class="btn-secondary" data-no>No</button>
        <button type="button" class="btn-warning" data-yes>Yes</button>
      </div>
    </div>
  `;

  itemEl.querySelector("[data-no]")?.addEventListener("click", () => {
    itemEl.innerHTML = originalHtml;
    itemEl.querySelector(".doc-delete")?.addEventListener("click", () => inlineDeleteTempDoc(fileId, itemEl));
  });

  itemEl.querySelector("[data-yes]")?.addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/doc/temp/${encodeURIComponent(fileId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      itemEl.remove();
      state.tempDocs = state.tempDocs.filter((name) => name !== fileId);
      const countEl = qs("#temp-doc-count");
      if (countEl) countEl.textContent = String(state.tempDocs.length);
      showToast("Temporary document removed.", "success");
      if (state.tempDocs.length === 0) {
        const scroll = qs("#temp-docs-scroll");
        if (scroll) scroll.style.display = "none";
      }
    } catch {
      showToast("Could not delete temporary document.", "error");
      itemEl.innerHTML = originalHtml;
      itemEl.querySelector(".doc-delete")?.addEventListener("click", () => inlineDeleteTempDoc(fileId, itemEl));
    }
  });
}

function wireDropzone(dropzoneEl, onFile) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/pdf";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  dropzoneEl.addEventListener("click", () => fileInput.click());

  dropzoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzoneEl.classList.add("dragover");
  });
  dropzoneEl.addEventListener("dragleave", () => dropzoneEl.classList.remove("dragover"));
  dropzoneEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove("dragover");
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await onFile(file);
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await onFile(file);
    fileInput.value = "";
  });
}

async function handlePermanentUpload(file) {
  openDrawer("permanent");
  try {
    const data = await uploadDocument(file);
    showToast("Saved to your knowledge base. Indexing…", "success");
    startPipelineSSE(data.job_id, "permanent");
  } catch (e) {
    showToast(e.message || "Upload failed.", "error");
  }
}

async function handleTempUpload(file) {
  try {
    openDrawer("temp");
    // TEMP DOC should always run in a temporary chat session (not in permanent history).
    if (!state.isTempMode) {
      setTempModeUI(true);
      await createNewSession();
      const container = qs("#messages");
      container.querySelectorAll(".bubble-row, .typing-indicator").forEach((x) => x.remove());
      qs("#empty-state").style.display = "flex";
      qsa(".session-item").forEach((x) => x.classList.remove("active"));
    }
    await uploadTempDocument(file);
    // uploadTempDocument already shows a saved toast
  } catch (e) {
    showToast(e.message || "Temp upload failed.", "error");
  }
}

async function removeTempDoc() {
  try {
    const res = await fetch("/api/doc/temp", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Remove failed");
    showToast("Temporary document removed.", "success");
  } catch (e) {
    showToast(e.message || "Remove failed.", "error");
  } finally {
    state.hasTempDoc = false;
    state.activeTempFilename = null;
    state.tempDocs = [];

    const list = qs("#temp-doc-list");
    if (list) list.innerHTML = "";
    const scroll = qs("#temp-docs-scroll");
    if (scroll) scroll.style.display = "none";
    const countEl = qs("#temp-doc-count");
    if (countEl) countEl.textContent = "0";

    const badge = qs("#temp-doc-badge");
    if (badge) {
      badge.style.display = "none";
      badge.classList.remove("amber-pulse");
    }

    setStepRowStatus("temp", 0, "queued", "");
    setStepRowStatus("temp", 1, "queued", "");
  }
}

async function triggerFinetune() {
  const res = await fetch("/api/doc/finetune", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || "Fine-tuning failed to start.", "error");
    return;
  }
  showToast("Fine-tuning started.", "warning");
  startPipelineSSE(data.job_id, "permanent", { resetStep2: true });
}

async function refreshNavBadges() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    const count = data.doc_count || 0;
    qs("#indexed-doc-count").textContent = count;
  } catch {
    // ignore
  }
}

function initOverlayAndStatus() {
  const overlay = qs("#loading-overlay");
  const msg = qs("#overlay-message");
  const modelsText = qs("#models-ready-text");
  const modelsDot = qs("#models-dot");

  const cycleMsgs = [
    "Loading Qwen 1.5B neural engine...",
    "Loading BAAI/bge-large embedding model...",
    "Loading ms-marco cross-encoder reranker...",
    "Connecting to ChromaDB vector store...",
    "System ready.",
  ];

  let idx = 0;
  let cycleTimer = setInterval(() => {
    if (!msg) return;
    msg.textContent = cycleMsgs[idx % cycleMsgs.length];
    idx += 1;
  }, 2000);

  async function poll() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      const ready = !!data.rag_ready;
      state.ragReady = ready;

      if (modelsText) modelsText.textContent = ready ? "Ready" : "Loading";
      if (modelsDot) {
        modelsDot.classList.remove("dot-green", "dot-violet");
        modelsDot.classList.add(ready ? "dot-green" : "dot-violet");
      }

      if (data.rag_error) {
        clearInterval(cycleTimer);
        if (msg) {
          msg.textContent = `Initialization failed: ${data.rag_error}`;
        }
        return;
      }

      if (ready) {
        clearInterval(cycleTimer);
        await refreshNavBadges();
        overlay?.classList.add("hide");
        setTimeout(() => (overlay.style.display = "none"), 500);
      }

      const chunksEl = qs("#chroma-chunks");
      if (chunksEl && typeof data.chunk_count !== "undefined") {
        chunksEl.textContent = String(data.chunk_count);
      }
    } catch {
      // keep polling
    }
  }

  poll();
  setInterval(poll, 2000);
}

function wireModalConfirm() {
  const backdrop = qs("#finetune-modal");
  const cancel = qs("#finetune-cancel");
  const confirm = qs("#finetune-confirm");

  const close = () => backdrop?.classList.remove("show");
  cancel?.addEventListener("click", close);
  backdrop?.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  confirm?.addEventListener("click", async () => {
    close();
    await triggerFinetune();
  });

  qs("#finetune-btn")?.addEventListener("click", () => backdrop?.classList.add("show"));
}

function initTempDrawerControls() {
  const close = qs("#temp-drawer-close");
  close?.addEventListener("click", () => qs("#temp-drawer")?.classList.remove("open"));
}

function initPermanentDrawerControls() {
  qs("#perm-drawer-close")?.addEventListener("click", () => qs("#permanent-drawer")?.classList.remove("open"));
}

async function init() {
  applyThemeFromStorage();
  state.isTempMode = false;
  setTempModeUI(state.isTempMode);

  initOverlayAndStatus();
  initInputBar();
  initPermanentDrawerControls();
  initTempDrawerControls();
  wireModalConfirm();

  qs("#sidebar-toggle")?.addEventListener("click", toggleSidebar);

  qs("#temp-chat-btn")?.addEventListener("click", async () => {
    const next = !state.isTempMode;
    setTempModeUI(next);
    await createNewSession();
    const container = qs("#messages");
    container.querySelectorAll(".bubble-row, .typing-indicator").forEach((x) => x.remove());
    qs("#empty-state").style.display = "flex";
    qsa(".session-item").forEach((x) => x.classList.remove("active"));
    if (!state.isTempMode) {
      await loadSidebarHistory();
    }
  });

  qs("#upload-doc-btn")?.addEventListener("click", () => {
    openDrawer("permanent");
    loadDocumentList();
  });

  qs("#temp-doc-btn")?.addEventListener("click", () => openDrawer("temp"));

  qs("#temp-doc-remove-btn")?.addEventListener("click", removeTempDoc);

  // User menu dropdown
  const userBtn = qs("#user-menu-btn");
  const dropdown = qs("#user-dropdown");
  userBtn?.addEventListener("click", () => dropdown?.classList.toggle("show"));

  document.addEventListener("click", (e) => {
    if (!dropdown || !userBtn) return;
    if (dropdown.classList.contains("show")) {
      if (dropdown.contains(e.target) || userBtn.contains(e.target)) return;
      dropdown.classList.remove("show");
    }
  });

  wireThemeToggle();

  qs("#perm-dropzone") && wireDropzone(qs("#perm-dropzone"), handlePermanentUpload);
  qs("#temp-dropzone") && wireDropzone(qs("#temp-dropzone"), handleTempUpload);

  qs("#new-chat-btn")?.addEventListener("click", async () => {
    // For temp mode, new session is temporary and won't appear in the sidebar history.
    await createNewSession();
    const container = qs("#messages");
    container.querySelectorAll(".bubble-row").forEach((x) => x.remove());
    qs("#empty-state").style.display = "flex";
  });

  // Suggestion pills
  qsa("[data-suggestion]").forEach((pill) => {
    pill.addEventListener("click", async () => {
      const textarea = qs("#question-input");
      textarea.value = pill.dataset.suggestion;
      autoResizeTextarea(textarea);
      updateCharCounter();
      await sendMessage(textarea.value);
    });
  });

  await loadSidebarHistory();
  // Start with empty state if no session selected
  renderEmptyState();
  scrollToBottom();
}

window.addEventListener("DOMContentLoaded", init);


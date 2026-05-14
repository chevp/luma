// chi · Console — UX prototype
// Vanilla HTML/CSS/JS. Talks to the `chi serve` companion at the same origin:
//   GET  /api/health        → { ok, provider, model, version }
//   GET  /api/models        → { models: string[] }
//   POST /api/chat          → NDJSON stream { message: { content }, done }
//   POST /api/run           → { stdout, stderr, code } for chi <name> tools

(() => {
    "use strict";

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    const els = {
        sidebar: $("#sidebar"),
        toggleSidebar: $("#toggleSidebarBtn"),
        model: $("#modelSelect"),
        msgCount: $("#msgCount"),
        feed: $("#feed"),
        userInput: $("#userInput"),
        sendBtn: $("#sendBtn"),
        abortBtn: $("#abortBtn"),
        clearBtn: $("#clearBtn"),
        exportBtn: $("#exportBtn"),
        newChat: $("#newChatBtn"),
        chatList: $("#chatList"),
        chatNavSection: $("#chatNavSection"),
        suggestionGrid: $("#suggestionGrid"),
        latency: $("#latencyText"),
        tokens: $("#tokenText"),
        modelEcho: $("#modelEcho"),
        composerHint: $("#composerHint"),
        connDot: $("#connDot"),
        connText: $("#connText"),
        versionText: $("#versionText"),
        providerBadge: $("#providerBadge"),
    };

    // Default port chi serve listens on. Surfaced in error hints when the
    // browser can reach the static page but not the server (rare — usually
    // means the user opened index.html via file:// or chi serve was killed).
    const SERVE_HINT = "is `chi serve` running? start it with: chi serve";

    const friendlyFetchError = (e) => {
        const msg = e && e.message ? e.message : String(e);
        // Browsers report a network-layer failure as TypeError "Failed to fetch".
        if (e && (e.name === "TypeError" || /failed to fetch|networkerror/i.test(msg))) {
            return `${msg} — ${SERVE_HINT}`;
        }
        return msg;
    };

    const STORAGE_SESSIONS = "chi.console.sessions";
    const STORAGE_ACTIVE = "chi.console.activeId";

    const state = {
        sessions: [],
        activeId: null,
        currentRequest: null,
    };

    const SUGGESTIONS = [
        { icon: "fa-code-commit", title: "Commit message", hint: "Draft a commit message from the staged diff." },
        { icon: "fa-circle-question", title: "What is chi?",  hint: "Give a one-paragraph overview of chi and what it does." },
        { icon: "fa-bug",            title: "Debug",         hint: "Diagnose the last chi ship/commit failure I saw." },
        { icon: "fa-list-check",     title: "Plan",          hint: "Sketch a CTX → EXP → PRD plan for a small refactor." },
    ];

    const escapeHtml = (s) =>
        s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

    const renderContent = (text) => {
        const parts = text.split(/(```[\s\S]*?```)/g);
        return parts.map((p) => {
            if (p.startsWith("```") && p.endsWith("```")) {
                const inner = p.slice(3, -3).replace(/^[a-zA-Z0-9_-]*\n?/, "");
                return `<pre>${escapeHtml(inner)}</pre>`;
            }
            return escapeHtml(p);
        }).join("");
    };

    const setConn = (kind, text) => {
        els.connDot.className = `dot dot-${kind}`;
        els.connText.textContent = text;
    };

    const updateSendBtn = () => {
        const ready = els.userInput.value.trim().length > 0
            && els.model.value
            && !state.currentRequest;
        els.sendBtn.disabled = !ready;
    };

    const updateMsgCount = () => {
        const s = activeSession();
        const n = s ? s.messages.filter((m) => m.role !== "system").length : 0;
        els.msgCount.textContent = `${n} message${n === 1 ? "" : "s"}`;
    };

    const autosize = () => {
        els.userInput.style.height = "auto";
        els.userInput.style.height = Math.min(els.userInput.scrollHeight, 200) + "px";
    };

    const scrollToBottom = () => {
        els.feed.scrollTop = els.feed.scrollHeight;
    };

    const lsGet = (key, fallback) => {
        try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
        catch { return fallback; }
    };
    const lsSet = (key, value) => {
        try { localStorage.setItem(key, value); } catch { /* quota */ }
    };

    // ==========================================================
    //   SESSIONS
    // ==========================================================
    function loadSessions() {
        try {
            const raw = localStorage.getItem(STORAGE_SESSIONS);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    function persistSessions() {
        lsSet(STORAGE_SESSIONS, JSON.stringify(state.sessions));
    }

    function activeSession() {
        return state.sessions.find((s) => s.id === state.activeId) || null;
    }

    function newSessionObject() {
        return {
            id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: "New chat",
            model: els.model.value || "",
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }

    function createSession({ activate = true } = {}) {
        const s = newSessionObject();
        state.sessions.unshift(s);
        if (activate) state.activeId = s.id;
        persistSessions();
        lsSet(STORAGE_ACTIVE, state.activeId || "");
        renderChatList();
        if (activate) loadActiveIntoUi();
        return s;
    }

    function deleteSession(id) {
        const idx = state.sessions.findIndex((s) => s.id === id);
        if (idx === -1) return;
        state.sessions.splice(idx, 1);
        persistSessions();
        if (state.activeId === id) {
            const next = state.sessions[0];
            if (next) {
                state.activeId = next.id;
                lsSet(STORAGE_ACTIVE, next.id);
                renderChatList();
                loadActiveIntoUi();
            } else {
                createSession();
            }
        } else {
            renderChatList();
        }
    }

    function switchSession(id) {
        if (state.activeId === id) return;
        if (state.currentRequest) state.currentRequest.abort();
        state.activeId = id;
        lsSet(STORAGE_ACTIVE, id);
        renderChatList();
        loadActiveIntoUi();
    }

    function persistActive() {
        const s = activeSession();
        if (!s) return;
        s.model = els.model.value || s.model;
        s.updatedAt = Date.now();
        if (s.title === "New chat") {
            const firstUser = s.messages.find((m) => m.role === "user");
            if (firstUser) {
                const t = firstUser.content.trim().replace(/\s+/g, " ");
                s.title = t.length > 40 ? t.slice(0, 37) + "…" : t;
                renderChatList();
            }
        }
        persistSessions();
    }

    function renderChatList() {
        els.chatList.innerHTML = "";
        for (const s of state.sessions) {
            const row = document.createElement("div");
            row.className = "chat-row" + (s.id === state.activeId ? " active" : "");
            row.dataset.id = s.id;
            row.innerHTML = `
                <button class="nav-item chat-row-open" type="button" title="${escapeHtml(s.title)}">
                    <i class="fa-regular fa-comment" aria-hidden="true"></i>
                    <span class="chat-row-title">${escapeHtml(s.title)}</span>
                </button>
                <button class="chat-row-del" type="button" title="Delete chat" aria-label="Delete chat">
                    <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
                </button>`;
            row.querySelector(".chat-row-open").addEventListener("click", () => switchSession(s.id));
            row.querySelector(".chat-row-del").addEventListener("click", (e) => {
                e.stopPropagation();
                if (confirm(`Delete “${s.title}”?`)) deleteSession(s.id);
            });
            els.chatList.appendChild(row);
        }
    }

    function loadActiveIntoUi() {
        const s = activeSession();
        if (!s) return;
        if (s.model && Array.from(els.model.options).some((o) => o.value === s.model)) {
            els.model.value = s.model;
            els.modelEcho.textContent = s.model;
        }
        renderFeedFromMessages(s.messages);
        updateMsgCount();
        updateSendBtn();
    }

    function renderFeedFromMessages(messages) {
        els.feed.innerHTML = "";
        const visible = messages.filter((m) => m.role !== "system");
        if (visible.length === 0) {
            renderWelcome();
            return;
        }
        for (const m of messages) {
            if (m.role === "user") appendUserMsg(m.content);
            else if (m.role === "assistant") {
                const wrap = appendAssistantMsg(m.model || els.model.value);
                wrap.querySelector(".msg-content").innerHTML = renderContent(m.content);
                wireMsgActions(wrap, m.content);
            } else if (m.role === "tool") {
                appendToolOutput(m.name || "tool", m.content);
            }
        }
    }

    function renderWelcome() {
        els.feed.innerHTML = `
            <div class="welcome">
                <h1>What can chi do for you?</h1>
                <p class="welcome-sub">A chat surface over the same cura backend chi uses on the CLI.
                    Ask for a commit message, a diff summary, or run a tool from the sidebar.</p>
                <div id="suggestionGrid" class="suggestion-grid"></div>
            </div>`;
        els.suggestionGrid = $("#suggestionGrid");
        renderSuggestions();
    }

    // ==========================================================
    //   FEED
    // ==========================================================
    const removeWelcome = () => {
        const w = els.feed.querySelector(".welcome");
        if (w) w.remove();
    };

    const appendUserMsg = (content) => {
        removeWelcome();
        const wrap = document.createElement("div");
        wrap.className = "msg msg-user";
        wrap.innerHTML = `<div class="msg-bubble"></div>`;
        wrap.querySelector(".msg-bubble").textContent = content;
        els.feed.appendChild(wrap);
        scrollToBottom();
    };

    const appendAssistantMsg = (model) => {
        removeWelcome();
        const wrap = document.createElement("div");
        wrap.className = "msg msg-assistant";
        wrap.innerHTML = `
            <div class="msg-content"><span class="cursor"></span></div>
            <div class="msg-actions">
                <button class="msg-action" data-act="copy" title="Copy">
                    <i class="fa-regular fa-copy" aria-hidden="true"></i>
                </button>
                <button class="msg-action" data-act="regen" title="Regenerate">
                    <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>
                </button>
            </div>
            <div class="msg-meta-line">${escapeHtml(model || "")}</div>`;
        els.feed.appendChild(wrap);
        scrollToBottom();
        return wrap;
    };

    const appendSystemNote = (content, kind = "system") => {
        removeWelcome();
        const wrap = document.createElement("div");
        wrap.className = `msg msg-${kind}`;
        wrap.innerHTML = `<div class="msg-content"></div>`;
        wrap.querySelector(".msg-content").textContent = content;
        els.feed.appendChild(wrap);
        scrollToBottom();
    };

    const appendToolOutput = (name, output) => {
        removeWelcome();
        const wrap = document.createElement("div");
        wrap.className = "msg msg-tool";
        wrap.innerHTML = `<div class="msg-content"><div class="msg-tool-header">$ chi ${escapeHtml(name)}</div></div>`;
        const pre = document.createElement("div");
        pre.textContent = output;
        wrap.querySelector(".msg-content").appendChild(pre);
        els.feed.appendChild(wrap);
        scrollToBottom();
    };

    // ==========================================================
    //   CHI SERVE API
    // ==========================================================
    const providerOf = (id) => (id && id.indexOf("/") > 0 ? id.split("/")[0] : "");
    const modelNameOf = (id) => (id && id.indexOf("/") > 0 ? id.slice(id.indexOf("/") + 1) : id || "");

    const refreshProviderBadge = () => {
        const p = providerOf(els.model.value);
        if (!p) { els.providerBadge.textContent = "—"; return; }
        els.providerBadge.textContent = p === "ollama" ? "local" : "cura";
    };

    async function apiHealth() {
        try {
            const r = await fetch("/api/health");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            const ollamaOk = data.providers && data.providers.ollama && data.providers.ollama.ok;
            const curaOk = data.providers && data.providers.cura && data.providers.cura.ok;
            if (ollamaOk && curaOk) setConn("ok", "ollama + cura ready");
            else if (ollamaOk) setConn("ok", "local ollama ready");
            else if (curaOk) setConn("ok", "cura ready");
            else setConn("warn", "no provider reachable");
            return data;
        } catch (e) {
            setConn("err", "chi serve down");
            return { ok: false, error: friendlyFetchError(e) };
        }
    }

    async function apiModels() {
        try {
            const r = await fetch("/api/models");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            const models = Array.isArray(data.models) ? data.models : [];
            const preferred = (activeSession() && activeSession().model) || els.model.value;

            els.model.innerHTML = "";
            if (models.length === 0) {
                const opt = document.createElement("option");
                opt.value = "";
                opt.textContent = "— no models —";
                els.model.appendChild(opt);
            } else {
                const groups = { ollama: [], cura: [] };
                for (const m of models) (groups[m.provider] || (groups[m.provider] = [])).push(m);
                const labels = { ollama: "Local ollama", cura: "Cura (hosted)" };
                for (const key of ["ollama", "cura"]) {
                    const list = groups[key];
                    if (!list || list.length === 0) continue;
                    const og = document.createElement("optgroup");
                    og.label = labels[key];
                    for (const m of list) {
                        const opt = document.createElement("option");
                        opt.value = m.id;
                        opt.textContent = m.name;
                        og.appendChild(opt);
                    }
                    els.model.appendChild(og);
                }
                const ids = models.map((m) => m.id);
                els.model.value = ids.includes(preferred) ? preferred : (data.active || ids[0]);
            }
            els.modelEcho.textContent = modelNameOf(els.model.value) || "no model";
            refreshProviderBadge();
            updateSendBtn();
            return models;
        } catch (e) {
            els.model.innerHTML = `<option value="">— error: ${escapeHtml(friendlyFetchError(e))} —</option>`;
            els.modelEcho.textContent = "no model";
            refreshProviderBadge();
            return [];
        }
    }

    async function apiChat({ model, messages, onDelta, onDone, onError, signal }) {
        const t0 = performance.now();
        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model, messages, stream: true }),
                signal,
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            let full = "";
            let finalMeta = null;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    if (!line) continue;
                    let chunk;
                    try { chunk = JSON.parse(line); }
                    catch { continue; }
                    const delta = chunk.message && chunk.message.content;
                    if (delta) {
                        full += delta;
                        onDelta(full);
                    }
                    if (chunk.done) finalMeta = chunk;
                }
            }
            if (buf.trim()) {
                try {
                    const chunk = JSON.parse(buf);
                    if (chunk.done) finalMeta = chunk;
                    if (!finalMeta && chunk.message && chunk.message.content) {
                        full += chunk.message.content;
                        onDelta(full);
                    }
                } catch { /* ignore */ }
            }

            onDone({
                content: full,
                eval_count: (finalMeta && finalMeta.eval_count) || 0,
                latency_ms: (performance.now() - t0).toFixed(0),
            });
        } catch (e) {
            if (e.name === "AbortError") onError(new Error("Request aborted."));
            else onError(new Error(friendlyFetchError(e)));
        }
    }

    async function apiRun(name) {
        const r = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        return data;
    }

    // ==========================================================
    //   SEND FLOW
    // ==========================================================
    async function sendMessage() {
        const s = activeSession();
        if (!s) return;
        const text = els.userInput.value.trim();
        const model = els.model.value;
        if (!text || !model) return;

        const sourceId = s.id;
        const stillActive = () => state.activeId === sourceId;

        appendUserMsg(text);
        s.messages.push({ role: "user", content: text });
        els.userInput.value = "";
        autosize();
        updateMsgCount();
        persistActive();

        const wrap = appendAssistantMsg(model);
        const contentEl = wrap.querySelector(".msg-content");

        const ctrl = new AbortController();
        state.currentRequest = ctrl;
        els.abortBtn.disabled = false;
        els.sendBtn.disabled = true;
        setConn("busy", `${model} thinking…`);

        await apiChat({
            model,
            messages: s.messages.filter((m) => ["system","user","assistant"].includes(m.role))
                                .map((m) => ({ role: m.role, content: m.content })),
            signal: ctrl.signal,
            onDelta: (full) => {
                if (!stillActive()) return;
                contentEl.innerHTML = renderContent(full) + `<span class="cursor"></span>`;
                scrollToBottom();
            },
            onDone: (meta) => {
                s.messages.push({ role: "assistant", content: meta.content, model });
                persistActive();
                state.currentRequest = null;
                if (!stillActive()) return;
                contentEl.innerHTML = renderContent(meta.content);
                els.latency.textContent = `${meta.latency_ms} ms`;
                els.tokens.textContent = `${meta.eval_count} tokens`;
                els.modelEcho.textContent = modelNameOf(model);
                setConn("ok", "ready");
                els.abortBtn.disabled = true;
                updateSendBtn();
                updateMsgCount();
                wireMsgActions(wrap, meta.content);
            },
            onError: (err) => {
                state.currentRequest = null;
                if (!stillActive()) return;
                wrap.remove();
                appendSystemNote(friendlyFetchError(err), "error");
                setConn("err", "error");
                els.abortBtn.disabled = true;
                updateSendBtn();
            }
        });
    }

    function wireMsgActions(wrap, content) {
        wrap.querySelectorAll(".msg-action").forEach((btn) => {
            btn.addEventListener("click", () => {
                const act = btn.dataset.act;
                if (act === "copy") {
                    navigator.clipboard.writeText(content);
                    btn.innerHTML = `<i class="fa-solid fa-check"></i>`;
                    setTimeout(() => btn.innerHTML = `<i class="fa-regular fa-copy"></i>`, 1200);
                } else if (act === "regen") {
                    const s = activeSession();
                    if (!s) return;
                    if (s.messages.length >= 2 && s.messages[s.messages.length - 1].role === "assistant") {
                        s.messages.pop();
                        wrap.remove();
                        const lastUser = [...s.messages].reverse().find((m) => m.role === "user");
                        if (lastUser) {
                            els.userInput.value = lastUser.content;
                            s.messages.pop();
                            persistActive();
                            sendMessage();
                        }
                    }
                }
            });
        });
    }

    // ==========================================================
    //   SUGGESTIONS + TOOLS
    // ==========================================================
    function renderSuggestions() {
        if (!els.suggestionGrid) return;
        els.suggestionGrid.innerHTML = "";
        for (const s of SUGGESTIONS) {
            const btn = document.createElement("button");
            btn.className = "suggestion";
            btn.type = "button";
            btn.innerHTML = `
                <span class="suggestion-icon"><i class="fa-solid ${s.icon}" aria-hidden="true"></i></span>
                <span class="suggestion-title">${escapeHtml(s.title)}</span>
                <span class="suggestion-hint">${escapeHtml(s.hint)}</span>`;
            btn.addEventListener("click", () => {
                els.userInput.value = s.hint;
                autosize();
                updateSendBtn();
                els.userInput.focus();
            });
            els.suggestionGrid.appendChild(btn);
        }
    }

    async function runTool(name) {
        const s = activeSession();
        if (!s) return;
        const placeholder = appendToolOutput(name, "running…");
        try {
            const data = await apiRun(name);
            const output = [data.stdout, data.stderr].filter(Boolean).join("\n").trim()
                || `(exit ${data.code})`;
            placeholder && placeholder.remove && placeholder.remove();
            appendToolOutput(name, output);
            s.messages.push({ role: "tool", name, content: output });
            persistActive();
            updateMsgCount();
        } catch (e) {
            placeholder && placeholder.remove && placeholder.remove();
            appendSystemNote(`chi ${name}: ${friendlyFetchError(e)}`, "error");
        }
    }

    function clearActive() {
        const s = activeSession();
        if (!s) return;
        s.messages = [];
        s.title = "New chat";
        s.updatedAt = Date.now();
        persistSessions();
        renderChatList();
        renderWelcome();
        updateMsgCount();
        els.latency.textContent = "— ms";
        els.tokens.textContent = "— tokens";
    }

    function exportJson() {
        const s = activeSession();
        if (!s) return;
        const blob = {
            kind: "chi-console-session",
            title: s.title,
            model: s.model,
            startedAt: new Date(s.createdAt).toISOString(),
            exportedAt: new Date().toISOString(),
            messages: s.messages,
        };
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify(blob, null, 2)], { type: "application/json" }));
        a.download = `chi-session-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ==========================================================
    //   WIRE-UP
    // ==========================================================
    function bind() {
        els.userInput.addEventListener("input", () => { autosize(); updateSendBtn(); });
        els.userInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        els.sendBtn.addEventListener("click", sendMessage);
        els.abortBtn.addEventListener("click", () => {
            if (state.currentRequest) state.currentRequest.abort();
        });
        els.model.addEventListener("change", () => {
            els.modelEcho.textContent = modelNameOf(els.model.value) || "no model";
            refreshProviderBadge();
            updateSendBtn();
            persistActive();
        });
        els.clearBtn.addEventListener("click", () => {
            const s = activeSession();
            if (!s || s.messages.length === 0 || confirm("Clear history?")) clearActive();
        });
        els.exportBtn.addEventListener("click", exportJson);
        els.newChat.addEventListener("click", () => createSession());

        els.toggleSidebar.addEventListener("click", () => els.sidebar.classList.toggle("collapsed"));
        const openBtn = $("#openSidebarBtn");
        if (openBtn) openBtn.addEventListener("click", () => els.sidebar.classList.remove("collapsed"));

        $$(".tool-item").forEach((btn) => {
            btn.addEventListener("click", () => runTool(btn.dataset.tool));
        });
    }

    // ==========================================================
    //   INIT
    // ==========================================================
    async function init() {
        bind();
        autosize();
        setConn("idle", "checking…");

        state.sessions = loadSessions();
        const storedActive = lsGet(STORAGE_ACTIVE, "");
        if (state.sessions.length === 0) {
            const s = newSessionObject();
            state.sessions.push(s);
            state.activeId = s.id;
            persistSessions();
            lsSet(STORAGE_ACTIVE, s.id);
        } else if (storedActive && state.sessions.some((s) => s.id === storedActive)) {
            state.activeId = storedActive;
        } else {
            state.activeId = state.sessions[0].id;
            lsSet(STORAGE_ACTIVE, state.activeId);
        }

        renderChatList();
        loadActiveIntoUi();

        const health = await apiHealth();
        if (health && health.ok) await apiModels();
        loadActiveIntoUi();
    }

    document.addEventListener("DOMContentLoaded", init);
})();

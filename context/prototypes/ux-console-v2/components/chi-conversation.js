// <chi-conversation> — light-DOM. Owns the main column: topbar (model
// picker, agent eyebrow, export/clear), feed (welcome + messages + agent
// banner), composer (textarea + send/stop).

import { store } from "../lib/store.js";
import { AGENT_BY_ID } from "../lib/agents.js";
import { apiChatStream, friendlyFetchError } from "../lib/api.js";
import "./chi-message.js";

const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

const SUGGESTIONS = [
    { icon: "fa-code-commit",     title: "Commit message", hint: "Draft a commit message from the staged diff." },
    { icon: "fa-circle-question", title: "What is chi?",   hint: "Give a one-paragraph overview of chi and what it does." },
    { icon: "fa-bug",             title: "Debug",          hint: "Diagnose the last chi ship/commit failure I saw." },
    { icon: "fa-list-check",      title: "Plan",           hint: "Sketch a CTX → EXP → PRD plan for a small refactor." },
];

const providerOf = (id) => (id && id.indexOf("/") > 0 ? id.split("/")[0] : "");
const modelNameOf = (id) => (id && id.indexOf("/") > 0 ? id.slice(id.indexOf("/") + 1) : id || "");

class ChiConversation extends HTMLElement {
    connectedCallback() {
        this.classList.add("main");
        this._render();
        this._wire();
        this._unsubs = [
            store.on("active", () => this._renderActive()),
            store.on("messages", ({ message }) => this._appendIfActive(message)),
            store.on("models", ({ list, active }) => this._renderModels(list, active)),
            store.on("connection", ({ kind, text }) => this._setBusyHint(kind, text)),
        ];
        this._renderActive();
    }

    disconnectedCallback() {
        (this._unsubs || []).forEach((u) => u());
    }

    _render() {
        this.innerHTML = `
            <section class="view view-chat active" data-view="chat">
                <header class="topbar">
                    <div class="topbar-left">
                        <button data-act="open-sidebar" class="icon-btn ghost-only" type="button" title="Sidebar">
                            <i class="fa-solid fa-bars" aria-hidden="true"></i>
                        </button>
                        <div class="model-picker">
                            <select data-slot="model" aria-label="Pick a model">
                                <option value="">— loading —</option>
                            </select>
                            <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                        </div>
                        <span data-slot="provider-badge" class="topbar-eyebrow">cura</span>
                        <span data-slot="agent-badge" class="topbar-eyebrow agent-eyebrow" hidden></span>
                    </div>
                    <div class="topbar-right">
                        <button data-act="export" class="icon-btn" type="button" title="Export session as JSON">
                            <i class="fa-solid fa-arrow-down-to-line" aria-hidden="true"></i>
                        </button>
                        <button data-act="clear" class="icon-btn" type="button" title="Clear history">
                            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
                        </button>
                    </div>
                </header>

                <section data-slot="feed" class="feed" aria-live="polite"></section>

                <footer class="composer-wrap">
                    <div class="composer">
                        <textarea data-slot="input" class="composer-input" rows="1" placeholder="Ask chi…"></textarea>
                        <div class="composer-bar">
                            <span data-slot="composer-hint" class="composer-hint">Enter to send · Shift+Enter for newline</span>
                            <div class="composer-actions">
                                <button data-act="abort" class="circle-btn stop" type="button" disabled title="Stop generation">
                                    <i class="fa-solid fa-stop" aria-hidden="true"></i>
                                </button>
                                <button data-act="send" class="circle-btn send" type="button" disabled title="Send (Enter)">
                                    <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="composer-meta">
                        <span data-slot="model-echo">no model</span>
                        <span class="dot-sep">·</span>
                        <span data-slot="latency">— ms</span>
                        <span class="dot-sep">·</span>
                        <span data-slot="tokens">— tokens</span>
                        <span class="dot-sep">·</span>
                        <span data-slot="msg-count">0 messages</span>
                    </div>
                </footer>
            </section>`;

        this._els = {
            model: this.querySelector('[data-slot="model"]'),
            providerBadge: this.querySelector('[data-slot="provider-badge"]'),
            agentBadge: this.querySelector('[data-slot="agent-badge"]'),
            feed: this.querySelector('[data-slot="feed"]'),
            input: this.querySelector('[data-slot="input"]'),
            send: this.querySelector('[data-act="send"]'),
            abort: this.querySelector('[data-act="abort"]'),
            modelEcho: this.querySelector('[data-slot="model-echo"]'),
            latency: this.querySelector('[data-slot="latency"]'),
            tokens: this.querySelector('[data-slot="tokens"]'),
            msgCount: this.querySelector('[data-slot="msg-count"]'),
            composerHint: this.querySelector('[data-slot="composer-hint"]'),
        };
    }

    _wire() {
        const { input, send, abort, model } = this._els;

        input.addEventListener("input", () => { this._autosize(); this._refreshSend(); });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this._sendMessage();
            }
        });

        send.addEventListener("click", () => this._sendMessage());
        abort.addEventListener("click", () => {
            if (store.state.currentRequest) store.state.currentRequest.abort();
        });

        model.addEventListener("change", () => {
            store.setActiveModel(model.value);
            this._refreshProviderBadge();
            this._els.modelEcho.textContent = modelNameOf(model.value) || "no model";
            this._refreshSend();
        });

        this.addEventListener("click", (e) => {
            const act = e.target.closest("[data-act]")?.dataset.act;
            if (!act) return;
            if (act === "open-sidebar") {
                document.querySelector("chi-sidebar")?.classList.remove("collapsed");
            } else if (act === "clear") {
                const s = store.activeSession();
                if (!s || s.messages.length === 0 || confirm("Clear history?")) {
                    store.clearActive();
                    this._els.latency.textContent = "— ms";
                    this._els.tokens.textContent = "— tokens";
                }
            } else if (act === "export") {
                this._exportJson();
            } else if (act === "clear-agent") {
                const s = store.activeSession();
                if (!s) return;
                s.agentId = null;
                s.messages = s.messages.filter((m) => m.role !== "system");
                store._persistSessions();
                store.emit("active", s);
            }
        });

        // Bubble-up listener for sidebar events.
        document.addEventListener("run-tool", (e) => this._runTool(e.detail.name));
        document.addEventListener("start-agent", (e) => this._startAgent(e.detail.id));
        document.addEventListener("msg-action", (e) => {
            if (e.detail.action === "regen") this._regenerate();
        });
    }

    // --------------------------------------------------------------
    // Rendering helpers
    // --------------------------------------------------------------
    _renderActive() {
        const s = store.activeSession();
        if (!s) return;
        if (s.model && Array.from(this._els.model.options).some((o) => o.value === s.model)) {
            this._els.model.value = s.model;
            store.state.activeModel = s.model;
            this._els.modelEcho.textContent = modelNameOf(s.model);
        }
        this._renderFeed();
        this._refreshAgentBadge();
        this._refreshProviderBadge();
        this._refreshMsgCount();
        this._refreshSend();
    }

    _renderFeed() {
        const feed = this._els.feed;
        feed.innerHTML = "";
        const s = store.activeSession();
        if (!s) return;
        const agent = s.agentId ? AGENT_BY_ID[s.agentId] : null;
        if (agent) feed.appendChild(this._buildAgentBanner(agent));

        const visible = s.messages.filter((m) => m.role !== "system");
        if (visible.length === 0) {
            feed.appendChild(this._buildWelcome(agent));
            return;
        }
        for (const m of s.messages) {
            if (m.role === "system") continue;
            feed.appendChild(this._buildMessage(m));
        }
        this._scrollToBottom();
    }

    _buildMessage(m) {
        const el = document.createElement("chi-message");
        el.setAttribute("role", m.role);
        if (m.model) el.setAttribute("model", m.model);
        if (m.name) el.setAttribute("name", m.name);
        // Ensure the element is mounted before we push content into it.
        queueMicrotask(() => el.setContent(m.content || ""));
        return el;
    }

    _buildWelcome(agent) {
        const wrap = document.createElement("div");
        wrap.className = "welcome";
        const title = agent ? `Start with ${escapeHtml(agent.title)}` : "What can chi do for you?";
        const sub = agent
            ? escapeHtml(agent.blurb)
            : "A chat surface over the same cura backend chi uses on the CLI. Ask for a commit message, a diff summary, or run a tool from the sidebar.";
        wrap.innerHTML = `<h1>${title}</h1><p class="welcome-sub">${sub}</p>
            <div class="suggestion-grid"></div>`;
        const grid = wrap.querySelector(".suggestion-grid");
        const items = agent ? [] : SUGGESTIONS;
        for (const s of items) {
            const btn = document.createElement("button");
            btn.className = "suggestion";
            btn.type = "button";
            btn.innerHTML = `
                <span class="suggestion-icon"><i class="fa-solid ${s.icon}" aria-hidden="true"></i></span>
                <span class="suggestion-title">${escapeHtml(s.title)}</span>
                <span class="suggestion-hint">${escapeHtml(s.hint)}</span>`;
            btn.addEventListener("click", () => {
                this._els.input.value = s.hint;
                this._autosize();
                this._refreshSend();
                this._els.input.focus();
            });
            grid.appendChild(btn);
        }
        return wrap;
    }

    _buildAgentBanner(agent) {
        const wrap = document.createElement("div");
        wrap.className = "agent-banner";
        wrap.innerHTML = `
            <span class="agent-banner-icon"><i class="fa-solid ${agent.icon}" aria-hidden="true"></i></span>
            <div class="agent-banner-body">
                <div class="agent-banner-title">${escapeHtml(agent.title)}</div>
                <div class="agent-banner-blurb">${escapeHtml(agent.blurb)}</div>
            </div>
            <button data-act="clear-agent" class="agent-banner-clear" type="button">remove agent</button>`;
        return wrap;
    }

    _appendIfActive({ session, message }) {
        if (!session || session.id !== store.state.activeId) return;
        const welcome = this._els.feed.querySelector(".welcome");
        if (welcome) welcome.remove();
        if (message.role === "system") return;
        const el = this._buildMessage(message);
        this._els.feed.appendChild(el);
        this._scrollToBottom();
    }

    _renderModels(list, active) {
        const sel = this._els.model;
        sel.innerHTML = "";
        if (!list || list.length === 0) {
            const opt = document.createElement("option");
            opt.value = ""; opt.textContent = "— no models —";
            sel.appendChild(opt);
            this._els.modelEcho.textContent = "no model";
            this._refreshProviderBadge();
            this._refreshSend();
            return;
        }
        const groups = { ollama: [], cura: [] };
        for (const m of list) (groups[m.provider] || (groups[m.provider] = [])).push(m);
        const labels = { ollama: "Local ollama", cura: "Cura (hosted)" };
        for (const key of ["ollama", "cura"]) {
            const items = groups[key];
            if (!items || items.length === 0) continue;
            const og = document.createElement("optgroup");
            og.label = labels[key];
            for (const m of items) {
                const opt = document.createElement("option");
                opt.value = m.id; opt.textContent = m.name;
                og.appendChild(opt);
            }
            sel.appendChild(og);
        }
        const preferred = (store.activeSession() && store.activeSession().model) || active;
        const ids = list.map((m) => m.id);
        sel.value = ids.includes(preferred) ? preferred : (active || ids[0]);
        store.state.activeModel = sel.value;
        this._els.modelEcho.textContent = modelNameOf(sel.value) || "no model";
        this._refreshProviderBadge();
        this._refreshSend();
    }

    _refreshProviderBadge() {
        const p = providerOf(this._els.model.value);
        const badge = this._els.providerBadge;
        if (!p) { badge.textContent = "—"; badge.className = "topbar-eyebrow"; return; }
        badge.textContent = p === "ollama" ? "local" : "cura";
        badge.className = "topbar-eyebrow";
    }

    _refreshAgentBadge() {
        const s = store.activeSession();
        const agent = s && s.agentId ? AGENT_BY_ID[s.agentId] : null;
        const badge = this._els.agentBadge;
        if (!agent) { badge.hidden = true; return; }
        badge.hidden = false;
        badge.textContent = agent.title.toLowerCase();
    }

    _refreshMsgCount() {
        const s = store.activeSession();
        const n = s ? s.messages.filter((m) => m.role !== "system").length : 0;
        this._els.msgCount.textContent = `${n} message${n === 1 ? "" : "s"}`;
    }

    _refreshSend() {
        const ready = this._els.input.value.trim().length > 0
            && this._els.model.value
            && !store.state.currentRequest;
        this._els.send.disabled = !ready;
    }

    _setBusyHint(kind, text) {
        this._els.composerHint.textContent = (kind === "busy" || kind === "err")
            ? text
            : "Enter to send · Shift+Enter for newline";
    }

    _autosize() {
        const i = this._els.input;
        i.style.height = "auto";
        i.style.height = Math.min(i.scrollHeight, 200) + "px";
    }

    _scrollToBottom() {
        this._els.feed.scrollTop = this._els.feed.scrollHeight;
    }

    // --------------------------------------------------------------
    // Actions
    // --------------------------------------------------------------
    async _sendMessage() {
        const s = store.activeSession();
        if (!s) return;
        const text = this._els.input.value.trim();
        const model = this._els.model.value;
        if (!text || !model || store.state.currentRequest) return;

        store.pushMessage({ role: "user", content: text });
        this._els.input.value = "";
        this._autosize();
        this._refreshMsgCount();

        store.pushMessage({ role: "assistant", content: "", model });
        const assistantEl = this._els.feed.lastElementChild;
        if (assistantEl && assistantEl.tagName === "CHI-MESSAGE") {
            queueMicrotask(() => assistantEl.setContent("", { streaming: true }));
        }

        const ctrl = new AbortController();
        store.setBusy(true, ctrl);
        this._els.abort.disabled = false;
        this._refreshSend();
        store.setConnection("busy", `${modelNameOf(model)} thinking…`);

        const sourceId = s.id;
        try {
            const meta = await apiChatStream({
                model,
                messages: s.messages.filter((m) => ["system","user","assistant"].includes(m.role))
                                    .slice(0, -1)
                                    .map((m) => ({ role: m.role, content: m.content })),
                signal: ctrl.signal,
                onDelta: (full) => {
                    if (store.state.activeId !== sourceId) return;
                    store.updateLastAssistant(full);
                    if (assistantEl) assistantEl.setContent(full, { streaming: true });
                    this._scrollToBottom();
                },
            });
            store.updateLastAssistant(meta.content);
            if (store.state.activeId === sourceId && assistantEl) {
                assistantEl.setContent(meta.content, { streaming: false });
            }
            this._els.latency.textContent = `${meta.latency_ms} ms`;
            this._els.tokens.textContent = `${meta.eval_count} tokens`;
            this._els.modelEcho.textContent = modelNameOf(model);
            store.setConnection("ok", "ready");
        } catch (err) {
            if (err.name === "AbortError") {
                store.pushMessage({ role: "system", content: "Request aborted." });
            } else {
                store.pushMessage({ role: "error", content: friendlyFetchError(err) });
            }
            // Drop the empty assistant bubble we created.
            const sNow = store.activeSession();
            if (sNow) {
                const last = sNow.messages[sNow.messages.length - 2];
                if (last && last.role === "assistant" && !last.content) {
                    sNow.messages.splice(sNow.messages.length - 2, 1);
                    store._persistSessions();
                    if (store.state.activeId === sourceId) this._renderFeed();
                }
            }
            store.setConnection("err", "error");
        } finally {
            store.setBusy(false, null);
            this._els.abort.disabled = true;
            this._refreshSend();
            this._refreshMsgCount();
        }
    }

    async _runTool(name) {
        const s = store.activeSession();
        if (!s) return;
        const placeholder = this._appendToolPlaceholder(name);
        try {
            const r = await fetch("/api/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
            const output = [data.stdout, data.stderr].filter(Boolean).join("\n").trim()
                || `(exit ${data.code})`;
            placeholder.remove();
            store.pushMessage({ role: "tool", name, content: output });
            this._refreshMsgCount();
        } catch (e) {
            placeholder.remove();
            store.pushMessage({ role: "error", content: `chi ${name}: ${friendlyFetchError(e)}` });
        }
    }

    _appendToolPlaceholder(name) {
        const welcome = this._els.feed.querySelector(".welcome");
        if (welcome) welcome.remove();
        const el = document.createElement("chi-message");
        el.setAttribute("role", "tool");
        el.setAttribute("name", name);
        this._els.feed.appendChild(el);
        queueMicrotask(() => el.setContent("running…"));
        this._scrollToBottom();
        return el;
    }

    _startAgent(id) {
        const agent = AGENT_BY_ID[id];
        if (!agent) return;
        const s = store.createSession({ title: agent.title, agentId: agent.id });
        s.messages.push({ role: "system", content: agent.system });
        store._persistSessions();
        store.emit("active", s);
        this._els.input.value = agent.starter || "";
        this._autosize();
        this._refreshSend();
        this._els.input.focus();
        // Place caret where the user is expected to fill in.
        const idx = (agent.starter || "").indexOf("```\n\n```");
        if (idx >= 0) {
            const pos = idx + 4;
            this._els.input.setSelectionRange(pos, pos);
        }
    }

    _regenerate() {
        const s = store.activeSession();
        if (!s) return;
        if (s.messages.length >= 2 && s.messages[s.messages.length - 1].role === "assistant") {
            s.messages.pop();
            const lastUser = [...s.messages].reverse().find((m) => m.role === "user");
            if (lastUser) {
                this._els.input.value = lastUser.content;
                s.messages.pop();
                store._persistSessions();
                store.emit("active", s);
                this._sendMessage();
            }
        }
    }

    _exportJson() {
        const s = store.activeSession();
        if (!s) return;
        const blob = {
            kind: "chi-console-session",
            title: s.title,
            model: s.model,
            agentId: s.agentId,
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
}

customElements.define("chi-conversation", ChiConversation);

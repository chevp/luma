// Tiny event-driven store. Components subscribe to topics; mutations go
// through small action methods so the data shape stays in one place.

const STORAGE_SESSIONS = "chi.console3.sessions";
const STORAGE_ACTIVE = "chi.console3.activeId";
const STORAGE_VIEW = "chi.console3.view";
const STORAGE_WORKFLOW = "chi.console3.workflowId";

function lsGet(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
    } catch { return fallback; }
}
function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* quota */ }
}

function loadSessions() {
    try {
        const raw = localStorage.getItem(STORAGE_SESSIONS);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

function newSessionObject(seed = {}) {
    return {
        id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: seed.title || "New chat",
        model: seed.model || "",
        agentId: seed.agentId || null,
        messages: seed.messages || [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

class Store {
    constructor() {
        this._listeners = new Map();
        this.state = {
            sessions: loadSessions(),
            activeId: lsGet(STORAGE_ACTIVE, ""),
            models: [],
            activeModel: "",
            connection: { kind: "idle", text: "checking…" },
            busy: false,
            currentRequest: null,
            view: lsGet(STORAGE_VIEW, "chat"),
            workflowId: lsGet(STORAGE_WORKFLOW, "chevp-ai-framework"),
        };
        if (this.state.sessions.length === 0) {
            const s = newSessionObject();
            this.state.sessions.push(s);
            this.state.activeId = s.id;
            this._persistSessions();
            lsSet(STORAGE_ACTIVE, s.id);
        } else if (!this.state.sessions.find((s) => s.id === this.state.activeId)) {
            this.state.activeId = this.state.sessions[0].id;
            lsSet(STORAGE_ACTIVE, this.state.activeId);
        }
    }

    on(topic, fn) {
        if (!this._listeners.has(topic)) this._listeners.set(topic, new Set());
        this._listeners.get(topic).add(fn);
        return () => this._listeners.get(topic)?.delete(fn);
    }

    emit(topic, payload) {
        const set = this._listeners.get(topic);
        if (!set) return;
        for (const fn of set) {
            try { fn(payload); } catch (e) { console.error(e); }
        }
    }

    activeSession() {
        return this.state.sessions.find((s) => s.id === this.state.activeId) || null;
    }

    _persistSessions() {
        lsSet(STORAGE_SESSIONS, JSON.stringify(this.state.sessions));
    }

    persistActive() {
        const s = this.activeSession();
        if (!s) return;
        s.model = this.state.activeModel || s.model;
        s.updatedAt = Date.now();
        if (s.title === "New chat") {
            const firstUser = s.messages.find((m) => m.role === "user");
            if (firstUser) {
                const t = firstUser.content.trim().replace(/\s+/g, " ");
                s.title = t.length > 40 ? t.slice(0, 37) + "…" : t;
                this.emit("sessions", this.state.sessions);
            }
        }
        this._persistSessions();
    }

    createSession(seed = {}) {
        const s = newSessionObject({ ...seed, model: this.state.activeModel });
        this.state.sessions.unshift(s);
        this.state.activeId = s.id;
        this._persistSessions();
        lsSet(STORAGE_ACTIVE, s.id);
        this.emit("sessions", this.state.sessions);
        this.emit("active", s);
        return s;
    }

    deleteSession(id) {
        const idx = this.state.sessions.findIndex((s) => s.id === id);
        if (idx === -1) return;
        this.state.sessions.splice(idx, 1);
        this._persistSessions();
        if (this.state.activeId === id) {
            const next = this.state.sessions[0];
            if (next) {
                this.state.activeId = next.id;
                lsSet(STORAGE_ACTIVE, next.id);
                this.emit("sessions", this.state.sessions);
                this.emit("active", next);
            } else {
                this.createSession();
            }
        } else {
            this.emit("sessions", this.state.sessions);
        }
    }

    switchSession(id) {
        if (this.state.activeId === id) return;
        if (this.state.currentRequest) this.state.currentRequest.abort();
        this.state.activeId = id;
        lsSet(STORAGE_ACTIVE, id);
        this.emit("sessions", this.state.sessions);
        this.emit("active", this.activeSession());
    }

    clearActive() {
        const s = this.activeSession();
        if (!s) return;
        s.messages = [];
        s.title = "New chat";
        s.agentId = null;
        s.updatedAt = Date.now();
        this._persistSessions();
        this.emit("sessions", this.state.sessions);
        this.emit("active", s);
    }

    pushMessage(msg) {
        const s = this.activeSession();
        if (!s) return;
        s.messages.push(msg);
        this.persistActive();
        this.emit("messages", { session: s, message: msg });
    }

    updateLastAssistant(content) {
        const s = this.activeSession();
        if (!s) return;
        const last = s.messages[s.messages.length - 1];
        if (last && last.role === "assistant") {
            last.content = content;
            this._persistSessions();
        }
    }

    setModels(list, active) {
        this.state.models = list;
        if (active) this.state.activeModel = active;
        this.emit("models", { list, active: this.state.activeModel });
    }

    setActiveModel(id) {
        this.state.activeModel = id;
        this.persistActive();
        this.emit("models", { list: this.state.models, active: id });
    }

    setConnection(kind, text) {
        this.state.connection = { kind, text };
        this.emit("connection", this.state.connection);
    }

    setBusy(busy, controller = null) {
        this.state.busy = busy;
        this.state.currentRequest = controller;
        this.emit("busy", busy);
    }

    setView(view) {
        if (this.state.view === view) return;
        this.state.view = view;
        lsSet(STORAGE_VIEW, view);
        this.emit("view", view);
    }

    setWorkflow(id) {
        if (this.state.workflowId === id) return;
        this.state.workflowId = id;
        lsSet(STORAGE_WORKFLOW, id);
        this.emit("workflow", id);
    }
}

export const store = new Store();

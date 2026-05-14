// <chi-sidebar> — light-DOM. Brand, Workspace (Chat | Workflow), Tools
// (CLI + agent tools), Agents, Workflows, Chats, connection footer.

import { store } from "../lib/store.js";
import { AGENTS } from "../lib/agents.js";
import { WORKFLOWS } from "../lib/workflows.js";
import { CLI_TOOLS, AGENT_TOOLS } from "../lib/tools.js";

const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

class ChiSidebar extends HTMLElement {
    connectedCallback() {
        this.classList.add("sidebar");
        this.id = "sidebar";
        this._render();
        this._wire();
        this._unsubs = [
            store.on("sessions", () => this._renderChatList()),
            store.on("active", () => this._renderChatList()),
            store.on("connection", (c) => this._renderConn(c)),
            store.on("view", () => this._refreshViewActive()),
            store.on("workflow", () => this._refreshWorkflowActive()),
        ];
        this._renderConn(store.state.connection);
        this._refreshViewActive();
        this._refreshWorkflowActive();
    }

    disconnectedCallback() {
        (this._unsubs || []).forEach((u) => u());
    }

    _render() {
        this.innerHTML = `
            <div class="sidebar-brand">
                <span class="brand-logo">χ</span>
                <span class="brand-name">chi <small>· Console v3</small></span>
                <button data-act="collapse" class="icon-btn brand-collapse" type="button" title="Collapse sidebar">
                    <i class="fa-solid fa-bars-staggered" aria-hidden="true"></i>
                </button>
            </div>

            <nav class="sidebar-scroll">
                <div class="nav-section">
                    <div class="nav-label">Workspace</div>
                    <button class="nav-item ws-item" data-view="chat" type="button">
                        <i class="fa-regular fa-comment" aria-hidden="true"></i>
                        <span>Chat</span>
                    </button>
                    <button class="nav-item ws-item" data-view="workflow" type="button">
                        <i class="fa-solid fa-diagram-project" aria-hidden="true"></i>
                        <span>Workflow</span>
                    </button>
                </div>

                <div class="nav-section" data-section="workflows">
                    <div class="nav-label">Workflows</div>
                </div>

                <div class="nav-section" data-section="agents">
                    <div class="nav-label">Agents</div>
                </div>

                <div class="nav-section" data-section="cli-tools">
                    <div class="nav-label">CLI tools</div>
                </div>

                <div class="nav-section" data-section="agent-tools">
                    <div class="nav-label">Agent tools</div>
                </div>

                <div class="nav-section" data-section="chats">
                    <div class="nav-label nav-label-row">
                        <span>Chats</span>
                        <button data-act="new-chat" class="nav-label-btn" type="button" title="New chat">
                            <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
                        </button>
                    </div>
                    <div data-slot="chat-list" class="chat-list"></div>
                </div>
            </nav>

            <div class="sidebar-bottom">
                <div class="conn-status">
                    <span data-slot="conn-dot" class="dot dot-idle"></span>
                    <span data-slot="conn-text">checking…</span>
                </div>
            </div>`;

        this._renderWorkflows();
        this._renderAgents();
        this._renderCliTools();
        this._renderAgentTools();
        this._renderChatList();
    }

    _renderWorkflows() {
        const host = this.querySelector('[data-section="workflows"]');
        for (const w of WORKFLOWS) {
            const btn = document.createElement("button");
            btn.className = "nav-item workflow-item";
            btn.dataset.workflow = w.id;
            btn.type = "button";
            btn.title = w.blurb;
            btn.innerHTML = `<i class="fa-solid fa-diagram-project" aria-hidden="true"></i><span>${escapeHtml(w.name)}</span>`;
            host.appendChild(btn);
        }
    }

    _renderAgents() {
        const host = this.querySelector('[data-section="agents"]');
        for (const a of AGENTS) {
            const btn = document.createElement("button");
            btn.className = "nav-item agent-item";
            if (a.legacy) btn.classList.add("agent-item-legacy");
            btn.dataset.agent = a.id;
            btn.type = "button";
            btn.title = a.blurb;
            btn.innerHTML = `
                <i class="fa-solid ${escapeHtml(a.icon)}" aria-hidden="true"></i>
                <span>${escapeHtml(a.title)}</span>`;
            host.appendChild(btn);
        }
    }

    _renderCliTools() {
        const host = this.querySelector('[data-section="cli-tools"]');
        for (const t of CLI_TOOLS) {
            const btn = document.createElement("button");
            btn.className = "nav-item tool-item";
            btn.dataset.tool = t.id;
            btn.type = "button";
            btn.title = t.blurb;
            btn.innerHTML = `<i class="fa-solid ${escapeHtml(t.icon)}" aria-hidden="true"></i><span>${escapeHtml(t.title)}</span>`;
            host.appendChild(btn);
        }
    }

    _renderAgentTools() {
        const host = this.querySelector('[data-section="agent-tools"]');
        for (const t of AGENT_TOOLS) {
            const row = document.createElement("div");
            row.className = "nav-item agent-tool-item";
            row.title = t.blurb;
            row.innerHTML = `
                <i class="fa-solid ${escapeHtml(t.icon)}" aria-hidden="true"></i>
                <span>${escapeHtml(t.title)}</span>
                <span class="agent-tool-meta">read-only</span>`;
            host.appendChild(row);
        }
    }

    _renderChatList() {
        const host = this.querySelector('[data-slot="chat-list"]');
        if (!host) return;
        host.innerHTML = "";
        for (const s of store.state.sessions) {
            const row = document.createElement("div");
            row.className = "chat-row" + (s.id === store.state.activeId ? " active" : "");
            row.dataset.id = s.id;
            row.innerHTML = `
                <button class="nav-item chat-row-open" type="button" title="${escapeHtml(s.title)}">
                    <i class="fa-regular fa-comment" aria-hidden="true"></i>
                    <span class="chat-row-title">${escapeHtml(s.title)}</span>
                </button>
                <button class="chat-row-del" type="button" title="Delete chat" aria-label="Delete chat">
                    <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
                </button>`;
            row.querySelector(".chat-row-open").addEventListener("click", () => {
                store.switchSession(s.id);
                store.setView("chat");
            });
            row.querySelector(".chat-row-del").addEventListener("click", (e) => {
                e.stopPropagation();
                if (confirm(`Delete “${s.title}”?`)) store.deleteSession(s.id);
            });
            host.appendChild(row);
        }
    }

    _renderConn({ kind, text }) {
        const dot = this.querySelector('[data-slot="conn-dot"]');
        const t = this.querySelector('[data-slot="conn-text"]');
        if (dot) dot.className = `dot dot-${kind}`;
        if (t) t.textContent = text;
    }

    _refreshViewActive() {
        const v = store.state.view;
        this.querySelectorAll("[data-view]").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.view === v);
        });
    }

    _refreshWorkflowActive() {
        const id = store.state.workflowId;
        this.querySelectorAll("[data-workflow]").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.workflow === id);
        });
    }

    _wire() {
        this.addEventListener("click", (e) => {
            const collapse = e.target.closest('[data-act="collapse"]');
            if (collapse) { this.classList.toggle("collapsed"); return; }

            const newChat = e.target.closest('[data-act="new-chat"]');
            if (newChat) { store.createSession(); store.setView("chat"); return; }

            const viewBtn = e.target.closest("[data-view]");
            if (viewBtn) { store.setView(viewBtn.dataset.view); return; }

            const wfBtn = e.target.closest("[data-workflow]");
            if (wfBtn) {
                store.setWorkflow(wfBtn.dataset.workflow);
                store.setView("workflow");
                return;
            }

            const toolBtn = e.target.closest("[data-tool]");
            if (toolBtn) {
                this.dispatchEvent(new CustomEvent("run-tool", {
                    detail: { name: toolBtn.dataset.tool },
                    bubbles: true,
                }));
                store.setView("chat");
                return;
            }

            const agentBtn = e.target.closest("[data-agent]");
            if (agentBtn) {
                this.dispatchEvent(new CustomEvent("start-agent", {
                    detail: { id: agentBtn.dataset.agent },
                    bubbles: true,
                }));
                store.setView("chat");
                return;
            }
        });
    }
}

customElements.define("chi-sidebar", ChiSidebar);

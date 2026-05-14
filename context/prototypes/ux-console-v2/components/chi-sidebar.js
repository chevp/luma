// <chi-sidebar> — light-DOM component. Owns the sidebar markup: brand,
// Workspace nav, Tools, Agents, Chats, and connection footer. Talks to
// the store for state and dispatches actions back through it.

import { store } from "../lib/store.js";
import { AGENTS } from "../lib/agents.js";

const TOOLS = [
    { id: "status", title: "chi status", icon: "fa-circle-info" },
    { id: "doctor", title: "chi doctor", icon: "fa-stethoscope" },
    { id: "help",   title: "chi help",   icon: "fa-circle-question" },
];

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
        ];
        this._renderConn(store.state.connection);
    }

    disconnectedCallback() {
        (this._unsubs || []).forEach((u) => u());
    }

    _render() {
        this.innerHTML = `
            <div class="sidebar-brand">
                <span class="brand-logo">χ</span>
                <span class="brand-name">chi <small>· Console v2</small></span>
                <button data-act="collapse" class="icon-btn brand-collapse" type="button" title="Collapse sidebar">
                    <i class="fa-solid fa-bars-staggered" aria-hidden="true"></i>
                </button>
            </div>

            <nav class="sidebar-scroll">
                <div class="nav-section">
                    <div class="nav-label">Workspace</div>
                    <button class="nav-item ws-item active" data-view="chat" type="button">
                        <i class="fa-regular fa-comment" aria-hidden="true"></i>
                        <span>Chat</span>
                    </button>
                </div>

                <div class="nav-section" data-section="tools">
                    <div class="nav-label">Tools</div>
                </div>

                <div class="nav-section" data-section="agents">
                    <div class="nav-label">Agents</div>
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

        const toolsHost = this.querySelector('[data-section="tools"]');
        for (const t of TOOLS) {
            const btn = document.createElement("button");
            btn.className = "nav-item tool-item";
            btn.dataset.tool = t.id;
            btn.type = "button";
            btn.innerHTML = `<i class="fa-solid ${t.icon}" aria-hidden="true"></i><span>${escapeHtml(t.title)}</span>`;
            toolsHost.appendChild(btn);
        }

        const agentsHost = this.querySelector('[data-section="agents"]');
        for (const a of AGENTS) {
            const btn = document.createElement("button");
            btn.className = "nav-item agent-item";
            btn.dataset.agent = a.id;
            btn.type = "button";
            btn.title = a.blurb;
            btn.innerHTML = `<i class="fa-solid ${a.icon}" aria-hidden="true"></i><span>${escapeHtml(a.title)}</span>`;
            agentsHost.appendChild(btn);
        }

        this._renderChatList();
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
            row.querySelector(".chat-row-open").addEventListener("click", () => store.switchSession(s.id));
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

    _wire() {
        this.addEventListener("click", (e) => {
            const collapse = e.target.closest('[data-act="collapse"]');
            if (collapse) { this.classList.toggle("collapsed"); return; }

            const newChat = e.target.closest('[data-act="new-chat"]');
            if (newChat) { store.createSession(); return; }

            const toolBtn = e.target.closest("[data-tool]");
            if (toolBtn) {
                this.dispatchEvent(new CustomEvent("run-tool", {
                    detail: { name: toolBtn.dataset.tool },
                    bubbles: true,
                }));
                return;
            }

            const agentBtn = e.target.closest("[data-agent]");
            if (agentBtn) {
                this.dispatchEvent(new CustomEvent("start-agent", {
                    detail: { id: agentBtn.dataset.agent },
                    bubbles: true,
                }));
                return;
            }
        });
    }
}

customElements.define("chi-sidebar", ChiSidebar);

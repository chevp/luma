// <chi-message role="..." model="..." name="..."> — light-DOM component.
// For assistant messages, expose .setContent(text, { streaming }) so the
// conversation can update bubbles during streaming.

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

class ChiMessage extends HTMLElement {
    static get observedAttributes() { return ["role", "model", "name"]; }

    connectedCallback() {
        if (this._mounted) return;
        this._mounted = true;
        this._render();
    }

    attributeChangedCallback() {
        if (this._mounted) this._render();
    }

    _render() {
        const role = this.getAttribute("role") || "assistant";
        const model = this.getAttribute("model") || "";
        const name = this.getAttribute("name") || "";
        const content = this._pendingContent ?? "";
        this.className = `msg msg-${role}`;

        if (role === "user") {
            this.innerHTML = `<div class="msg-bubble"></div>`;
            this.querySelector(".msg-bubble").textContent = content;
        } else if (role === "tool") {
            this.innerHTML = `<div class="msg-content"><div class="msg-tool-header">$ chi ${escapeHtml(name)}</div></div>`;
            const pre = document.createElement("div");
            pre.textContent = content;
            this.querySelector(".msg-content").appendChild(pre);
        } else if (role === "system" || role === "error") {
            this.innerHTML = `<div class="msg-content"></div>`;
            this.querySelector(".msg-content").textContent = content;
        } else {
            this.innerHTML = `
                <div class="msg-content"></div>
                <div class="msg-actions">
                    <button class="msg-action" data-act="copy" title="Copy">
                        <i class="fa-regular fa-copy" aria-hidden="true"></i>
                    </button>
                    <button class="msg-action" data-act="regen" title="Regenerate">
                        <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="msg-meta-line">${escapeHtml(model)}</div>`;
            this._renderAssistant(content, false);
            this._wireActions();
        }
    }

    _renderAssistant(content, streaming) {
        const el = this.querySelector(".msg-content");
        if (!el) return;
        el.innerHTML = renderContent(content) + (streaming ? `<span class="cursor"></span>` : "");
    }

    setContent(content, { streaming = false } = {}) {
        this._pendingContent = content;
        const role = this.getAttribute("role") || "assistant";
        if (role === "user") {
            const b = this.querySelector(".msg-bubble");
            if (b) b.textContent = content;
        } else if (role === "tool" || role === "system" || role === "error") {
            this._render();
        } else {
            this._renderAssistant(content, streaming);
        }
    }

    _wireActions() {
        this.querySelectorAll(".msg-action").forEach((btn) => {
            btn.addEventListener("click", () => {
                const act = btn.dataset.act;
                this.dispatchEvent(new CustomEvent("msg-action", {
                    detail: { action: act, content: this._pendingContent ?? "" },
                    bubbles: true,
                }));
                if (act === "copy") {
                    navigator.clipboard.writeText(this._pendingContent ?? "");
                    btn.innerHTML = `<i class="fa-solid fa-check"></i>`;
                    setTimeout(() => btn.innerHTML = `<i class="fa-regular fa-copy"></i>`, 1200);
                }
            });
        });
    }
}

customElements.define("chi-message", ChiMessage);

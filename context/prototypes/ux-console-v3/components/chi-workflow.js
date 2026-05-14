// <chi-workflow> — workflow view. Renders one workflow definition: stages
// in a stepper with gates between them, plus a card per agent showing the
// tools that agent may use. Clicking "Start agent" hands off to the chat
// view via the same `start-agent` event the sidebar uses.

import { store } from "../lib/store.js";
import { WORKFLOW_BY_ID } from "../lib/workflows.js";
import { AGENT_BY_ID, AGENTS } from "../lib/agents.js";
import { AGENT_TOOL_BY_ID } from "../lib/tools.js";

const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

class ChiWorkflow extends HTMLElement {
    connectedCallback() {
        this.classList.add("main", "workflow-main");
        if (store.state.view !== "workflow") this.classList.add("hidden");
        this._render();
        this._wire();
        this._unsubs = [
            store.on("view", (v) => this.classList.toggle("hidden", v !== "workflow")),
            store.on("workflow", () => this._render()),
        ];
    }

    disconnectedCallback() {
        (this._unsubs || []).forEach((u) => u());
    }

    _render() {
        const wf = WORKFLOW_BY_ID[store.state.workflowId] || WORKFLOW_BY_ID["chevp-ai-framework"];
        if (!wf) {
            this.innerHTML = `<div class="wf-empty">No workflow loaded.</div>`;
            return;
        }

        // Index gates by `from` stage so we can render them between stages.
        const gateByFrom = Object.fromEntries(wf.gates.map((g) => [g.from, g]));
        const finalGate = wf.gates[wf.gates.length - 1];

        const stagesHtml = wf.stages.map((s, i) => {
            const gateAfter = gateByFrom[s.id];
            return `
                <div class="wf-stage-step" data-stage="${escapeHtml(s.id)}">
                    <div class="wf-stage-pill">
                        <span class="wf-stage-index">${i + 1}</span>
                        <span><i class="fa-solid ${escapeHtml(s.icon)}" aria-hidden="true"></i> ${escapeHtml(s.name)}</span>
                    </div>
                </div>
                ${gateAfter ? this._gatePill(gateAfter) : ""}`;
        }).join("");

        const stageCardsHtml = wf.stages.map((s) => {
            const gateAfter = gateByFrom[s.id];
            return `
                <article class="wf-card">
                    <header class="wf-card-head">
                        <i class="fa-solid ${escapeHtml(s.icon)}" aria-hidden="true"></i>
                        <h3>${escapeHtml(s.name)}</h3>
                    </header>
                    <p class="wf-card-blurb">${escapeHtml(s.blurb)}</p>
                    <div class="wf-card-section-label">Artifacts</div>
                    <ul class="wf-artifact-list">
                        ${s.artifacts.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}
                    </ul>
                    ${gateAfter ? this._gateAgentRow(gateAfter) : ""}
                </article>`;
        }).join("");

        const crossAgents = wf.crossCutting.map((id) => AGENT_BY_ID[id]).filter(Boolean);
        const crossHtml = crossAgents.length === 0 ? "" : `
            <section class="wf-section">
                <h2 class="wf-section-title">Cross-cutting agents</h2>
                <div class="wf-agent-grid">
                    ${crossAgents.map((a) => this._agentCard(a)).join("")}
                </div>
            </section>`;

        this.innerHTML = `
            <header class="wf-topbar">
                <div class="wf-topbar-title">
                    <i class="fa-solid fa-diagram-project" aria-hidden="true"></i>
                    <span>${escapeHtml(wf.name)}</span>
                    <span class="topbar-eyebrow">workflow</span>
                </div>
                <div class="wf-topbar-blurb">${escapeHtml(wf.blurb)}</div>
            </header>

            <div class="wf-scroll">
                <section class="wf-section wf-stepper-section">
                    <div class="wf-stepper">${stagesHtml}${this._endPill(finalGate)}</div>
                </section>

                <section class="wf-section">
                    <h2 class="wf-section-title">Stages &amp; gates</h2>
                    <div class="wf-card-grid">${stageCardsHtml}</div>
                </section>

                ${crossHtml}

                <section class="wf-section wf-rules-section">
                    <h2 class="wf-section-title">Four rules</h2>
                    <ol class="wf-rules">
                        ${wf.rules.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
                    </ol>
                </section>
            </div>`;
    }

    _gatePill(gate) {
        return `
            <button class="wf-gate-pill" data-act="start-agent" data-agent="${escapeHtml(gate.agentId)}"
                    type="button" title="Run ${escapeHtml(gate.name)} gatekeeper in chat">
                <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
                <span>${escapeHtml(gate.name)}</span>
            </button>`;
    }

    _endPill(finalGate) {
        if (!finalGate) return "";
        return `<div class="wf-stage-step wf-stage-done">
            <div class="wf-stage-pill wf-stage-pill-done">
                <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>
                <span>Done</span>
            </div>
        </div>`;
    }

    _gateAgentRow(gate) {
        const agent = AGENT_BY_ID[gate.agentId];
        if (!agent) return "";
        return `
            <div class="wf-gate-row">
                <div class="wf-gate-row-head">
                    <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
                    <span class="wf-gate-row-name">${escapeHtml(gate.name)} — ${escapeHtml(gate.question)}</span>
                </div>
                ${this._agentCard(agent, { compact: true })}
            </div>`;
    }

    _agentCard(agent, { compact = false } = {}) {
        const tools = (agent.tools || [])
            .map((id) => AGENT_TOOL_BY_ID[id])
            .filter(Boolean);
        const toolsHtml = tools.length === 0
            ? `<span class="wf-tool-empty">no tools declared</span>`
            : tools.map((t) =>
                `<span class="wf-tool-chip" title="${escapeHtml(t.blurb)}">
                    <i class="fa-solid ${escapeHtml(t.icon)}" aria-hidden="true"></i>${escapeHtml(t.title)}
                </span>`).join("");
        return `
            <div class="wf-agent-card ${compact ? "compact" : ""}" data-agent="${escapeHtml(agent.id)}">
                <header class="wf-agent-head">
                    <span class="wf-agent-icon"><i class="fa-solid ${escapeHtml(agent.icon)}" aria-hidden="true"></i></span>
                    <div class="wf-agent-titles">
                        <div class="wf-agent-name">${escapeHtml(agent.title)}${agent.legacy ? ` <span class="wf-legacy-tag">legacy</span>` : ""}</div>
                        <div class="wf-agent-blurb">${escapeHtml(agent.blurb)}</div>
                    </div>
                </header>
                <div class="wf-agent-tools">${toolsHtml}</div>
                <div class="wf-agent-actions">
                    <button class="wf-agent-start" data-act="start-agent" data-agent="${escapeHtml(agent.id)}"
                            type="button">
                        <i class="fa-solid fa-play" aria-hidden="true"></i>
                        Start agent in chat
                    </button>
                </div>
            </div>`;
    }

    _wire() {
        this.addEventListener("click", (e) => {
            const btn = e.target.closest('[data-act="start-agent"]');
            if (!btn) return;
            const id = btn.dataset.agent;
            if (!id) return;
            this.dispatchEvent(new CustomEvent("start-agent", {
                detail: { id },
                bubbles: true,
            }));
            store.setView("chat");
        });
    }
}

customElements.define("chi-workflow", ChiWorkflow);

// Export the catalog so chi-sidebar / chi-app can derive the workflow list
// without re-importing workflows.js for trivial reasons.
export { WORKFLOWS } from "../lib/workflows.js";

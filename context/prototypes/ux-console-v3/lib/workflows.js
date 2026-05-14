// Workflows — pluggable definitions. chevp-ai-framework is the first
// concrete workflow; the data shape is generic so other workflows
// (e.g. release lifecycle, support triage) can be added next to it.

export const WORKFLOWS = [
    {
        id: "chevp-ai-framework",
        name: "chevp-ai-framework",
        blurb: "Three steps. Three checkpoints. No surprise commits.",
        rules: [
            "Context before code.",
            "A prototype is not the product.",
            "Small steps, with stops.",
            "The human decides.",
        ],
        stages: [
            {
                id: "context",
                name: "Context",
                icon: "fa-magnifying-glass",
                blurb: "Understand the task in the user's terms — not the AI's assumptions.",
                artifacts: [
                    "Context-Plan (CTX)",
                    "Uncertainty triplet (problem, hypotheses, risks)",
                    "System Spec",
                    "Software Architecture",
                    "Fundamental ADRs",
                    "Context Inventory",
                    "Scope Confirmation",
                ],
            },
            {
                id: "exploration",
                name: "Exploration",
                icon: "fa-compass-drafting",
                blurb: "Plan how to solve it. Optional UX prototype before writing real code.",
                artifacts: [
                    "Feature Plan/Spec (EXP)",
                    "exploration-mode: A or B",
                    "≥3 implementation-ready steps",
                    "Scope + NOT-in-Scope",
                    "Kill Criteria",
                    "Acceptance Criteria (≥2 verifiable)",
                    "Risks with mitigations (≥2)",
                    "UX Prototype (visually confirmed)",
                    "insights.md (hypothesis + verdict)",
                ],
            },
            {
                id: "production",
                name: "Production",
                icon: "fa-hammer",
                blurb: "Write code following the approved plan — nothing more.",
                artifacts: [
                    "Production-Plan (PRD) with implements: link",
                    "All acceptance checkboxes satisfied",
                    "Build passes, no regressions",
                    "Documentation updated (CLAUDE.md, READMEs, ADRs)",
                    "insights.md updated with Production surprises",
                    "evidence: block filled",
                    "Provenance — governance-log.md entry",
                ],
            },
        ],
        gates: [
            {
                id: "g1",
                name: "G1",
                from: "context",
                to: "exploration",
                question: "Did we understand the task?",
                agentId: "gatekeeper-g1",
            },
            {
                id: "g2",
                name: "G2",
                from: "exploration",
                to: "production",
                question: "Is the plan good?",
                agentId: "gatekeeper-g2",
            },
            {
                id: "g3",
                name: "G3",
                from: "production",
                to: "done",
                question: "Does it actually work?",
                agentId: "gatekeeper-g3",
            },
        ],
        crossCutting: ["architecture-reviewer", "governance-auditor", "lab-curator", "gate-validator"],
    },
];

export const WORKFLOW_BY_ID = Object.fromEntries(WORKFLOWS.map((w) => [w.id, w]));

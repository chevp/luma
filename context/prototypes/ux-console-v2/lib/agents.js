// Agent presets — each one starts a chat session with a tailored system
// message and pre-fills the composer with a starter template. No new
// backend endpoint is needed: agents ride on /api/chat by injecting a
// `role: "system"` message at the head of the message list.

export const AGENTS = [
    {
        id: "commit-author",
        title: "Commit Author",
        icon: "fa-code-commit",
        blurb: "Drafts a conventional commit message from a diff.",
        system:
            "You are a focused commit-message author for the chi project. " +
            "Write a terse, imperative subject line (≤72 chars) followed by " +
            "a 1–3 sentence body that explains *why*, not *what*. Never " +
            "invent files you weren't shown. If the diff is empty, say so.",
        starter: "Write a commit message for this diff:\n\n```diff\n\n```",
    },
    {
        id: "plan-architect",
        title: "Plan Architect",
        icon: "fa-list-check",
        blurb: "Sketches CTX → EXP → PRD for a refactor or feature.",
        system:
            "You help draft a short three-section plan: CTX (context — why " +
            "now), EXP (exploration — options + trade-offs), PRD (proposal " +
            "— the chosen approach with concrete steps). Ask exactly one " +
            "clarifying question before drafting if anything is ambiguous.",
        starter: "I want to plan: ",
    },
    {
        id: "code-explainer",
        title: "Code Explainer",
        icon: "fa-magnifying-glass-chart",
        blurb: "Explains a snippet — intent, decisions, trade-offs.",
        system:
            "Explain code to a senior engineer. Start with one sentence on " +
            "what it does, then highlight non-obvious decisions, edge cases, " +
            "and trade-offs. Skip restating syntax. Keep it under 200 words " +
            "unless the user asks for depth.",
        starter: "Explain this:\n\n```\n\n```",
    },
    {
        id: "diff-reviewer",
        title: "Diff Reviewer",
        icon: "fa-code-pull-request",
        blurb: "Reviews a diff for correctness, risk, and missing tests.",
        system:
            "Review diffs for correctness, complexity, security, and missing " +
            "tests. Output three short sections: 1) one-line summary, 2) " +
            "issues ranked by severity (cite line content), 3) concrete " +
            "suggestions. Skip nitpicks unless asked.",
        starter: "Review this diff:\n\n```diff\n\n```",
    },
];

export const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

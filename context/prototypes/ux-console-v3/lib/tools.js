// Tool catalog. "cli" tools are chi subcommands invoked through /api/run.
// "agent" tools mirror the framework's allowed-tools set — they are not
// executed from the console (no /api/agent-tool endpoint), but each agent
// declares which ones it may use and the sidebar exposes them so the
// human can see the surface the agents operate on.

export const CLI_TOOLS = [
    { id: "status", title: "chi status", icon: "fa-circle-info",     blurb: "Show repo + workspace status." },
    { id: "doctor", title: "chi doctor", icon: "fa-stethoscope",     blurb: "Diagnose the chi install + providers." },
    { id: "help",   title: "chi help",   icon: "fa-circle-question", blurb: "Show top-level help." },
];

export const AGENT_TOOLS = [
    { id: "Read",  title: "Read",  icon: "fa-file-lines",        blurb: "Read a file's contents." },
    { id: "Glob",  title: "Glob",  icon: "fa-asterisk",          blurb: "List files matching a pattern." },
    { id: "Grep",  title: "Grep",  icon: "fa-magnifying-glass",  blurb: "Search file contents (ripgrep-style)." },
    { id: "Bash",  title: "Bash",  icon: "fa-terminal",          blurb: "Run a shell command." },
    { id: "Write", title: "Write", icon: "fa-pen",               blurb: "Create or overwrite a file." },
    { id: "Edit",  title: "Edit",  icon: "fa-pen-to-square",     blurb: "Make a precise edit inside a file." },
];

export const CLI_TOOL_IDS = new Set(CLI_TOOLS.map((t) => t.id));
export const AGENT_TOOL_BY_ID = Object.fromEntries(AGENT_TOOLS.map((t) => [t.id, t]));

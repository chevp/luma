import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { c } from "../ui.js";
import { BIN_NAME } from "../identity.js";
import { resolveRepoRoot } from "../workspace.js";
const HELP = `${BIN_NAME} plan — scaffold and list framework plan artifacts.

Usage:
  ${BIN_NAME} plan new <CTX|EXP|PRD|PROP|ADR> "<title>"
  ${BIN_NAME} plan list [<type>]
  ${BIN_NAME} plan -h | --help

Layout:
  CTX/EXP/PRD/PROP files land in context/plans/
  ADR files land in context/adr/
`;
const PLAN_TYPES = ["CTX", "EXP", "PRD", "PROP", "ADR"];
function isPlanType(s) {
    return PLAN_TYPES.includes(s);
}
function planFolder(repoRoot, type) {
    return type === "ADR" ? join(repoRoot, "context", "adr") : join(repoRoot, "context", "plans");
}
function nextSequence(folder, type) {
    if (!existsSync(folder))
        return "001";
    const re = new RegExp(`^${type}-(\\d{3})-`);
    let max = 0;
    for (const entry of readdirSync(folder)) {
        const m = re.exec(entry);
        if (m && m[1]) {
            const n = parseInt(m[1], 10);
            if (n > max)
                max = n;
        }
    }
    return String(max + 1).padStart(3, "0");
}
function slugify(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
}
function today() {
    return new Date().toISOString().slice(0, 10);
}
function template(id, type, title) {
    return `---
id: ${id}
type: ${type}
status: proposed
proposed-by: human
proposed-at: ${today()}
supersedes: —
related: —
---

# ${id} — ${title}

## Context

(write context here)

## Decision

(write the decision here)

## Consequences

(write consequences here)
`;
}
function readStatus(file) {
    try {
        const raw = readFileSync(file, "utf8");
        const m = /^status:\s*(\S+)/m.exec(raw);
        return m && m[1] ? m[1] : "?";
    }
    catch {
        return "?";
    }
}
function planNew(args) {
    const typeArg = args[0];
    const title = args.slice(1).join(" ").trim();
    if (!typeArg || !title) {
        process.stderr.write(`${BIN_NAME} plan new: expected <type> "<title>"\n`);
        return 1;
    }
    const type = typeArg.toUpperCase();
    if (!isPlanType(type)) {
        process.stderr.write(`${BIN_NAME} plan new: unknown type '${typeArg}' (expected CTX|EXP|PRD|PROP|ADR)\n`);
        return 1;
    }
    const repoRoot = resolveRepoRoot(process.cwd());
    const folder = planFolder(repoRoot, type);
    mkdirSync(folder, { recursive: true });
    const seq = nextSequence(folder, type);
    const id = `${type}-${seq}`;
    const file = join(folder, `${id}-${slugify(title)}.md`);
    writeFileSync(file, template(id, type, title));
    process.stdout.write(`${c.green("✓")} created ${file}\n`);
    return 0;
}
function planList(args) {
    const filterArg = args[0];
    let filter;
    if (filterArg !== undefined) {
        const upper = filterArg.toUpperCase();
        if (!isPlanType(upper)) {
            process.stderr.write(`${BIN_NAME} plan list: unknown type '${filterArg}' (expected CTX|EXP|PRD|PROP|ADR)\n`);
            return 1;
        }
        filter = upper;
    }
    const repoRoot = resolveRepoRoot(process.cwd());
    // Dedup: CTX/EXP/PRD/PROP all live under context/plans/, ADR under context/adr/.
    // Iterate folders, then prefix-match the type when filtering.
    const folderToTypes = new Map();
    for (const t of PLAN_TYPES) {
        if (filter && t !== filter)
            continue;
        const folder = planFolder(repoRoot, t);
        const arr = folderToTypes.get(folder) ?? [];
        arr.push(t);
        folderToTypes.set(folder, arr);
    }
    let printed = 0;
    for (const [folder, types] of folderToTypes) {
        if (!existsSync(folder))
            continue;
        const typePrefix = new RegExp(`^(${types.join("|")})-\\d{3}-`);
        for (const entry of readdirSync(folder).sort()) {
            if (!entry.endsWith(".md") || !typePrefix.test(entry))
                continue;
            const full = join(folder, entry);
            const status = readStatus(full);
            process.stdout.write(`  ${c.dim(status.padEnd(10))} ${resolve(full)}\n`);
            printed++;
        }
    }
    if (printed === 0)
        process.stdout.write("  (no plans found)\n");
    return 0;
}
export async function run(argv) {
    const sub = argv[0];
    if (!sub || sub === "-h" || sub === "--help") {
        process.stdout.write(HELP);
        return sub ? 0 : 1;
    }
    switch (sub) {
        case "new":
            return planNew(argv.slice(1));
        case "list":
            return planList(argv.slice(1));
        default:
            process.stderr.write(`${BIN_NAME} plan: unknown subcommand '${sub}'\n`);
            process.stderr.write(HELP);
            return 1;
    }
}
//# sourceMappingURL=plan.js.map
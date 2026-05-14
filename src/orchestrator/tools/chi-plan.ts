import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * chi.plan.* tools — let the model scaffold and enumerate framework artifacts
 * (CTX/EXP/PRD/PROP/ADR) without shelling out. Mirrors `chi plan new` /
 * `chi plan list` from src/commands/plan.ts but exposed inside the
 * orchestrator's tool surface so consult sessions can create plans directly.
 */

const PLAN_TYPES = ["CTX", "EXP", "PRD", "PROP", "ADR"] as const;
type PlanType = (typeof PLAN_TYPES)[number];

const PlanTypeSchema = z.enum(PLAN_TYPES);

function planFolder(cwd: string, type: PlanType): string {
  return type === "ADR" ? join(cwd, "context", "adr") : join(cwd, "context", "plans");
}

function nextSequence(folder: string, type: PlanType): string {
  if (!existsSync(folder)) return "001";
  const re = new RegExp(`^${type}-(\\d{3})-`);
  let max = 0;
  for (const entry of readdirSync(folder)) {
    const m = re.exec(entry);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return String(max + 1).padStart(3, "0");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function frontmatter(id: string, type: PlanType, title: string): string {
  const status = type === "ADR" ? "proposed" : "proposed";
  return `---
id: ${id}
type: ${type}
status: ${status}
proposed-by: ai
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

export function makePlanCreateTool(cwd: string) {
  return tool(
    "plan_create",
    "Create a new framework plan file (CTX/EXP/PRD/PROP/ADR) under context/plans/ or context/adr/. Returns the path of the new file.",
    {
      type: PlanTypeSchema.describe("Plan type — CTX, EXP, PRD, PROP, or ADR."),
      title: z.string().min(3).describe("Short human-readable title for the plan."),
    },
    async ({ type, title }) => {
      const folder = planFolder(cwd, type);
      mkdirSync(folder, { recursive: true });
      const seq = nextSequence(folder, type);
      const id = `${type}-${seq}`;
      const filename = `${id}-${slugify(title)}.md`;
      const fullPath = join(folder, filename);
      writeFileSync(fullPath, frontmatter(id, type, title));
      return { content: [{ type: "text", text: fullPath }] };
    },
  );
}

export function makePlanListTool(cwd: string) {
  return tool(
    "plan_list",
    "List existing framework plan files under context/plans/ and context/adr/. Optionally filter by type.",
    {
      type: PlanTypeSchema.optional().describe("Optional filter by plan type."),
    },
    async ({ type }) => {
      const folders: { type: PlanType; folder: string }[] = type
        ? [{ type, folder: planFolder(cwd, type) }]
        : PLAN_TYPES.map((t) => ({ type: t, folder: planFolder(cwd, t) }));
      const lines: string[] = [];
      for (const { folder } of folders) {
        if (!existsSync(folder)) continue;
        for (const entry of readdirSync(folder).sort()) {
          if (entry.endsWith(".md") && /^[A-Z]+-\d{3}-/.test(entry)) {
            lines.push(join(folder, entry));
          }
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") || "(no plans found)" }] };
    },
  );
}

import { readFileSync } from "node:fs";
import { c } from "./ui.js";

export interface Frontmatter {
  name: string;
  status: string;
  progress: string;
}

const EMPTY: Frontmatter = { name: "", status: "", progress: "" };

/**
 * Parse the leading `---`-delimited YAML frontmatter block at the head of a
 * text. Recognized keys: name, status, progress. Inline `# ...` comments and
 * surrounding quotes are stripped from values. Trailing `\r` (Windows-edited
 * files) is removed.
 *
 * Mirrors the contract of lib/che/frontmatter.sh — anything else (e.g. body
 * markdown, multi-line values) is ignored.
 */
export function parseFrontmatter(input: string): Frontmatter {
  if (!input) return { ...EMPTY };
  const lines = input.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? "")) return { ...EMPTY };

  const block: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^---\s*$/.test(line)) break;
    block.push(line);
  }

  const out: Frontmatter = { ...EMPTY };
  for (const key of ["name", "status", "progress"] as const) {
    const re = new RegExp(`^${key}:\\s*(.*)$`);
    for (const ln of block) {
      const m = ln.match(re);
      if (!m) continue;
      let v = (m[1] ?? "").replace(/\s*#.*$/, "").trimEnd();
      v = v.replace(/\r$/, "");
      v = v.replace(/^['"]/, "").replace(/['"]$/, "");
      out[key] = v;
      break;
    }
  }
  return out;
}

export function parseFrontmatterFile(path: string): Frontmatter {
  try {
    return parseFrontmatter(readFileSync(path, "utf8"));
  } catch {
    return { ...EMPTY };
  }
}

/** Coloured one-word badge for a frontmatter status. */
export function statusBadge(status: string): string {
  switch (status) {
    case "done":
      return c.green("done");
    case "in-progress":
    case "in_progress":
    case "active":
      return c.yellow("in-progress");
    case "blocked":
      return c.red("blocked");
    case "open":
    case "":
      return c.dim("open");
    default:
      return c.dim(status);
  }
}

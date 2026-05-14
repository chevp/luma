import { readdirSync } from "node:fs";
import { join } from "node:path";
const SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".venv",
    "__pycache__",
    ".turbo",
    ".next",
]);
const HARD_CAP = 10000;
/**
 * BFS-walk `root` to `maxDepth` (inclusive of root at depth 0). A directory
 * containing a `.git` entry (file or dir) is treated as a repo leaf — we do
 * not descend into it. Symlinks are not followed. The skip list keeps the
 * walker out of well-known build/dependency directories without needing a
 * full glob/ignore parser.
 */
export function discover(root, maxDepth = 3) {
    const repos = [];
    const stack = [{ path: root, depth: 0 }];
    let visited = 0;
    let capped = false;
    while (stack.length > 0) {
        const top = stack.pop();
        visited++;
        if (visited > HARD_CAP) {
            capped = true;
            break;
        }
        let entries;
        try {
            entries = readdirSync(top.path, { withFileTypes: true });
        }
        catch {
            continue;
        }
        let isRepo = false;
        for (const e of entries) {
            if (e.name === ".git") {
                isRepo = true;
                break;
            }
        }
        if (isRepo) {
            repos.push({ absPath: top.path });
            continue;
        }
        if (top.depth >= maxDepth)
            continue;
        for (const e of entries) {
            if (e.isSymbolicLink())
                continue;
            if (!e.isDirectory())
                continue;
            if (SKIP.has(e.name))
                continue;
            stack.push({ path: join(top.path, e.name), depth: top.depth + 1 });
        }
    }
    return { repos, visited, capped };
}
//# sourceMappingURL=discover.js.map
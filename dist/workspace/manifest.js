import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export const MANIFEST_FILENAME = ".chi-workspace";
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function isValidSubpath(p) {
    if (p.length === 0)
        return false;
    if (p.startsWith("/"))
        return false;
    const parts = p.split("/");
    for (const part of parts) {
        if (part === "" || part === "." || part === "..")
            return false;
    }
    return true;
}
export function parseManifest(text) {
    const entries = [];
    const errors = [];
    const bySlug = new Map();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const lineNo = i + 1;
        const raw = lines[i] ?? "";
        const stripped = raw.replace(/#.*$/, "").trim();
        if (stripped.length === 0)
            continue;
        const eq = stripped.indexOf("=");
        if (eq < 0) {
            errors.push({ line: lineNo, message: "missing '=' separator", raw });
            continue;
        }
        const slug = stripped.slice(0, eq).trim();
        const subpath = stripped.slice(eq + 1).trim();
        if (!SLUG_RE.test(slug)) {
            errors.push({ line: lineNo, message: `invalid slug '${slug}' (expected '<owner>/<name>')`, raw });
            continue;
        }
        if (!isValidSubpath(subpath)) {
            errors.push({
                line: lineNo,
                message: `invalid subpath '${subpath}' (must be relative, no '..' or '/' prefix)`,
                raw,
            });
            continue;
        }
        if (bySlug.has(slug)) {
            errors.push({ line: lineNo, message: `duplicate slug '${slug}'`, raw });
            continue;
        }
        const entry = { slug, subpath, line: lineNo };
        entries.push(entry);
        bySlug.set(slug, entry);
    }
    return { entries, errors, bySlug };
}
export function readManifest(workspaceRoot) {
    const path = join(workspaceRoot, MANIFEST_FILENAME);
    if (!existsSync(path))
        return null;
    const text = readFileSync(path, "utf8");
    return parseManifest(text);
}
export function manifestPath(workspaceRoot) {
    return join(workspaceRoot, MANIFEST_FILENAME);
}
//# sourceMappingURL=manifest.js.map
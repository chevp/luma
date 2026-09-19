import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { git } from "../git/index.js";
import { commandExists, execSync } from "../spawn.js";
const FILE_ORDER = ["tauri.conf.json", "Cargo.toml", "package.json"];
const JSON_VERSION_RE = /("version"\s*:\s*")([^"]+)(")/;
function locateJson(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed.version !== "string")
        return null;
    // Only trust the regex match when it is the top-level field.
    const m = JSON_VERSION_RE.exec(raw);
    return m && m[2] === parsed.version ? { version: parsed.version } : null;
}
/** Line index and value of `version = "…"` in [package] or [workspace.package]. */
function locateCargo(raw) {
    const lines = raw.split("\n");
    let inSection = false;
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i] ?? "";
        const header = /^\s*\[([^\]]+)\]/.exec(ln);
        if (header) {
            inSection = header[1] === "package" || header[1] === "workspace.package";
            continue;
        }
        if (!inSection)
            continue;
        const m = /^\s*version\s*=\s*"([^"]+)"/.exec(ln);
        if (m?.[1])
            return { line: i, version: m[1] };
    }
    return null;
}
function readFile(root, path) {
    try {
        return readFileSync(join(root, path), "utf8");
    }
    catch {
        return null;
    }
}
/** Tracked package.json / Cargo.toml / tauri.conf.json files that carry a literal version. */
export function listVersionFiles(root) {
    const tracked = git(["ls-files"], root);
    if (!tracked.ok)
        return [];
    const out = [];
    for (const path of tracked.stdout.split("\n").map((p) => p.trim()).filter(Boolean)) {
        const name = basename(path);
        if (!FILE_ORDER.includes(name))
            continue;
        const raw = readFile(root, path);
        if (raw === null)
            continue;
        if (name === "Cargo.toml") {
            const loc = locateCargo(raw);
            if (loc)
                out.push({ path, kind: "cargo", version: loc.version });
        }
        else {
            const loc = locateJson(raw);
            if (loc)
                out.push({ path, kind: "json", version: loc.version });
        }
    }
    const rank = (f) => FILE_ORDER.indexOf(basename(f.path));
    return out.sort((a, b) => rank(a) - rank(b) || a.path.split("/").length - b.path.split("/").length);
}
/** The version most of the shallowest files agree on, so nested example crates can't outvote the root; ties go to the earlier file in FILE_ORDER. */
export function primaryVersion(files) {
    const depth = (f) => f.path.split("/").length;
    const shallowest = Math.min(...files.map(depth));
    const top = files.filter((f) => depth(f) === shallowest);
    const counts = new Map();
    for (const f of top)
        counts.set(f.version, (counts.get(f.version) ?? 0) + 1);
    let best = null;
    for (const f of top) {
        if (best === null || (counts.get(f.version) ?? 0) > (counts.get(best) ?? 0))
            best = f.version;
    }
    return best;
}
/** Writes `to` into every file currently at `from`; files at another version are left alone. */
export function writeVersions(root, files, from, to) {
    const changed = [];
    const skipped = [];
    for (const f of files) {
        if (f.version !== from) {
            skipped.push(f);
            continue;
        }
        const raw = readFile(root, f.path);
        if (raw === null)
            continue;
        let next;
        if (f.kind === "cargo") {
            const loc = locateCargo(raw);
            if (!loc)
                continue;
            const lines = raw.split("\n");
            lines[loc.line] = (lines[loc.line] ?? "").replace(/("[^"]*")/, `"${to}"`);
            next = lines.join("\n");
        }
        else {
            next = raw.replace(JSON_VERSION_RE, (_m, a, _v, b) => `${a}${to}${b}`);
        }
        writeFileSync(join(root, f.path), next);
        changed.push(f.path);
    }
    return { changed, skipped };
}
/** Keeps Cargo.lock's workspace-member versions in step; returns true when the file changed. */
export function syncCargoLock(root) {
    if (!existsSync(join(root, "Cargo.lock")) || !commandExists("cargo"))
        return false;
    const tracked = git(["ls-files", "--error-unmatch", "Cargo.lock"], root);
    if (!tracked.ok)
        return false;
    execSync("cargo", ["update", "--workspace", "--offline"], { cwd: root });
    return git(["diff", "--quiet", "--", "Cargo.lock"], root).status === 1;
}
//# sourceMappingURL=versions.js.map
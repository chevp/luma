import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { c } from "./ui.js";
import { BIN_NAME } from "./identity.js";
const CACHE_DIR = join(homedir(), ".luma");
const CACHE_FILE = join(CACHE_DIR, "version-check.json");
const LATEST_URL = "https://api.github.com/repos/chevp/luma/releases/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
function findPackageRoot(start) {
    let dir = start;
    while (true) {
        if (existsSync(join(dir, "package.json")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
export function getCurrentVersion() {
    const invokedBin = process.argv[1];
    if (!invokedBin)
        return null;
    let realBin;
    try {
        realBin = realpathSync(invokedBin);
    }
    catch {
        return null;
    }
    const root = findPackageRoot(dirname(realBin));
    if (!root)
        return null;
    try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        if (pkg.name !== "luma")
            return null;
        return typeof pkg.version === "string" ? pkg.version : null;
    }
    catch {
        return null;
    }
}
function readCache() {
    if (!existsSync(CACHE_FILE))
        return null;
    try {
        const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
        if (typeof raw.checkedAt !== "string" || typeof raw.latest !== "string")
            return null;
        return raw;
    }
    catch {
        return null;
    }
}
function writeCache(cache) {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache));
    }
    catch {
        // best-effort — a missing cache just means we'll re-check next run
    }
}
function isCacheFresh(cache) {
    if (!cache)
        return false;
    const checked = Date.parse(cache.checkedAt);
    if (Number.isNaN(checked))
        return false;
    return Date.now() - checked < CACHE_TTL_MS;
}
async function fetchLatestVersion() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(LATEST_URL, {
            signal: ctrl.signal,
            headers: {
                "User-Agent": "luma-cli",
                Accept: "application/vnd.github+json",
            },
        });
        if (!res.ok)
            return null;
        const json = (await res.json());
        if (typeof json.tag_name !== "string")
            return null;
        return json.tag_name.replace(/^v/, "");
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/** -1 if a<b, 0 if equal, 1 if a>b. Tolerates v-prefix and pre-release suffixes. */
export function compareVersions(a, b) {
    const parse = (v) => v
        .replace(/^v/, "")
        .split(/[.-]/)
        .slice(0, 3)
        .map((p) => Number.parseInt(p, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < 3; i++) {
        const av = pa[i] ?? 0;
        const bv = pb[i] ?? 0;
        if (av < bv)
            return -1;
        if (av > bv)
            return 1;
    }
    return 0;
}
/**
 * Print a "new release available" notice when the cached GitHub latest is
 * newer than the running version. Refreshes the cache (24h TTL) opportunistically.
 *
 * Best-effort: any network/file/parse failure silently degrades to no notice.
 * Set LUMA_NO_VERSION_CHECK=1 to disable.
 */
export async function maybePrintUpdateNotice() {
    if (process.env.LUMA_NO_VERSION_CHECK === "1")
        return;
    const current = getCurrentVersion();
    if (!current)
        return;
    let cache = readCache();
    if (!isCacheFresh(cache)) {
        const latest = await fetchLatestVersion();
        if (latest) {
            cache = { checkedAt: new Date().toISOString(), latest };
            writeCache(cache);
        }
    }
    if (!cache)
        return;
    if (compareVersions(cache.latest, current) <= 0)
        return;
    process.stdout.write(`\n${c.yellow(`A new release of ${BIN_NAME} is available:`)} ${c.dim(current)} → ${c.green(cache.latest)}\n` +
        `${c.dim(`To upgrade, run: ${BIN_NAME} update`)}\n` +
        `${c.dim(`https://github.com/chevp/luma/releases/tag/v${cache.latest}`)}\n`);
}
//# sourceMappingURL=version-check.js.map
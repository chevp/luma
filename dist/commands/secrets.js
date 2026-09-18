import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { commandExists, execAsync, execSync } from "../spawn.js";
import { c, sym } from "../ui.js";
import { BIN_NAME } from "../identity.js";
import { readLine } from "../prompt.js";
import { pool } from "../concurrency.js";
import { resolveWorkspaceRoot } from "../workspace.js";
import { readManifest, manifestPath } from "../workspace/manifest.js";
import { DRY_ENV, isDry, dryNote } from "../dry.js";
const HELP = `${BIN_NAME} secrets — push a dotenv file as GitHub Actions secrets, across the repos in .chi-workspace.

Usage: ${BIN_NAME} secrets [options]

Runs 'gh secret set -f <file> --repo <slug>' once per target repo. Every
key in the file becomes (or overwrites) a same-named repository secret —
there is no org-level secret involved, this just fans the same file out to
each repo's own secret store.

Options:
  --file <path>   dotenv file to push (default: <workspace-root>/.env)
  --repos <list>  comma-separated '<owner>/<repo>' slugs from .chi-workspace
                  (default: every entry in the manifest)
  --dry, --dry-run  print what would run, push nothing
  --yes           skip the confirmation prompt
  -h, --help      show this help
`;
function ok(msg) {
    process.stdout.write(`  ${sym.ok} ${msg}\n`);
}
function fail(msg) {
    process.stdout.write(`  ${sym.err} ${c.red(msg)}\n`);
}
async function confirm(question, autoYes) {
    if (autoYes)
        return true;
    if (!process.stdin.isTTY) {
        fail("not a TTY — pass --yes to run non-interactively");
        return false;
    }
    const ans = await readLine(`${question} [y/N] `);
    return ans?.trim().toLowerCase() === "y";
}
export async function run(argv) {
    if (argv.includes("-h") || argv.includes("--help")) {
        process.stdout.write(HELP);
        return 0;
    }
    if (argv.includes("--dry") || argv.includes("--dry-run")) {
        process.env[DRY_ENV] = "1";
    }
    const dry = isDry();
    const autoYes = argv.includes("--yes");
    const fileIdx = argv.indexOf("--file");
    const fileArg = fileIdx >= 0 ? argv[fileIdx + 1] : undefined;
    const reposIdx = argv.indexOf("--repos");
    const reposArg = reposIdx >= 0 ? argv[reposIdx + 1] : undefined;
    if (!commandExists("gh")) {
        fail("gh not installed — required to push secrets (https://cli.github.com)");
        return 1;
    }
    if (!execSync("gh", ["auth", "status"]).ok) {
        fail("gh not authenticated — run: gh auth login");
        return 1;
    }
    const { mode, root } = resolveWorkspaceRoot();
    if (mode !== "workspace") {
        fail(`not a workspace root (no CLAUDE.md with 'Workspace Mode' + sub-repos found from ${process.cwd()})`);
        return 1;
    }
    const manifest = readManifest(root);
    if (!manifest) {
        fail(`no manifest at ${manifestPath(root)} — see ADR-004 for the '<slug> = <subpath>' format`);
        return 1;
    }
    for (const e of manifest.errors) {
        process.stdout.write(`  ${sym.warn} ${c.yellow(`${manifestPath(root)}:${e.line}`)} ${e.message}\n`);
    }
    if (manifest.entries.length === 0) {
        fail("manifest has no valid entries — nothing to target");
        return 1;
    }
    let targetSlugs;
    if (reposArg) {
        targetSlugs = reposArg.split(",").map((s) => s.trim()).filter(Boolean);
        const unknown = targetSlugs.filter((s) => !manifest.bySlug.has(s));
        if (unknown.length > 0) {
            fail(`not in ${manifestPath(root)}: ${unknown.join(", ")}`);
            process.stdout.write(`  ${c.dim(`known: ${[...manifest.bySlug.keys()].join(", ")}`)}\n`);
            return 1;
        }
    }
    else {
        targetSlugs = manifest.entries.map((e) => e.slug);
    }
    const envFile = resolve(fileArg ?? join(root, ".env"));
    if (!existsSync(envFile)) {
        fail(`no dotenv file at ${envFile.replace(/\\/g, "/")}`);
        return 1;
    }
    process.stdout.write(`${c.bold("file:")}  ${c.cyan(envFile.replace(/\\/g, "/"))}\n`);
    process.stdout.write(`${c.bold("repos:")} ${targetSlugs.length}\n`);
    for (const s of targetSlugs)
        process.stdout.write(`  ${sym.bullet} ${s}\n`);
    process.stdout.write("\n");
    if (!dry) {
        const proceed = await confirm(`about to overwrite matching secrets on ${targetSlugs.length} repo(s) — continue?`, autoYes);
        if (!proceed) {
            fail("aborted");
            return 1;
        }
    }
    const concurrency = Number.parseInt(process.env.CHI_WORKSPACE_PARALLEL ?? "8", 10);
    const results = await pool(targetSlugs, async (slug) => {
        if (dry) {
            dryNote(`would run: gh secret set -f ${envFile.replace(/\\/g, "/")} --repo ${slug}`);
            return { slug, ok: true, detail: "" };
        }
        const r = await execAsync("gh", ["secret", "set", "-f", envFile, "--repo", slug]);
        return { slug, ok: r.ok, detail: r.ok ? "" : r.stderr.trim().split(/\r?\n/)[0] ?? "" };
    }, Math.max(1, concurrency));
    process.stdout.write(`\n${c.bold("result:")}\n`);
    let failed = 0;
    for (const r of results) {
        if (r.ok)
            ok(r.slug);
        else {
            failed++;
            fail(`${r.slug} — ${r.detail}`);
        }
    }
    const okCount = results.length - failed;
    process.stdout.write(`\n  ${sym.ok} ${c.green(`${okCount}/${results.length} ok`)}${failed > 0 ? `,  ${sym.err} ${c.red(`${failed} failed`)}` : ""}\n`);
    return failed > 0 ? 1 : 0;
}
//# sourceMappingURL=secrets.js.map
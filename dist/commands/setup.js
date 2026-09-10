import { BIN_NAME } from "../identity.js";
import { CHI_OS } from "../platform.js";
import { c, section } from "../ui.js";
import { ok, fail, warn, info } from "../installers/report.js";
import { INSTALLERS } from "../installers/registry.js";
import { loadToolchainConfig, selectEntries } from "../toolchain.js";
const HELP = `${BIN_NAME} setup — converge this machine to the toolchain declared in .luma/toolchain.yml.

Usage: ${BIN_NAME} setup [tool...] [options]

Arguments:
  tool          one or more tool ids from .luma/toolchain.yml (default: all)

Options:
  --dry-run     report what would be installed/upgraded without changing anything
  -h, --help    show this help

Manifest is read from <workspace-root>/.luma/toolchain.yml
(override the path with LUMA_TOOLCHAIN_FILE). Run "${BIN_NAME} doctor" to see
current state, "${BIN_NAME} fix" to repair only what's missing without forcing
version upgrades on already-installed tools.
`;
export async function run(argv) {
    if (argv.includes("-h") || argv.includes("--help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const dryRun = argv.includes("--dry-run");
    const names = argv.filter((a) => a !== "--dry-run");
    let config;
    try {
        config = loadToolchainConfig();
    }
    catch (err) {
        process.stderr.write(`${BIN_NAME} setup: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
    let entries;
    try {
        entries = selectEntries(config.entries, names);
    }
    catch (err) {
        process.stderr.write(`${BIN_NAME} setup: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
    section(`== setup (${config.configPath}) ==`);
    let hadFailure = false;
    for (const entry of entries) {
        const installer = INSTALLERS[entry.id];
        const desiredLabel = entry.desired === true ? "latest" : entry.desired;
        if (!installer) {
            warn(`'${entry.id}' has no installer module yet — skipping`);
            continue;
        }
        const before = await installer.check(entry.desired);
        if (before.satisfies) {
            ok(`${installer.label}: ${before.detail} (satisfies ${desiredLabel})`);
            continue;
        }
        if (dryRun) {
            info(`${installer.label}: would install/upgrade to ${desiredLabel} (currently: ${before.detail})`);
            continue;
        }
        process.stdout.write(`${c.bold(installer.label)}: installing (want ${desiredLabel})...\n`);
        const installed = await installer.install(entry.desired);
        if (!installed) {
            fail(`${installer.label}: automated install did not complete`);
            for (const line of installer.hint(CHI_OS))
                info(line);
            hadFailure = true;
            continue;
        }
        const after = await installer.check(entry.desired);
        if (after.satisfies) {
            ok(`${installer.label}: ${after.detail}`);
        }
        else {
            warn(`${installer.label}: installed but ${after.detail} does not satisfy ${desiredLabel}`);
            hadFailure = true;
        }
    }
    return hadFailure ? 1 : 0;
}
//# sourceMappingURL=setup.js.map
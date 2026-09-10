import { BIN_NAME } from "../identity.js";
import { CHI_OS } from "../platform.js";
import { c, section } from "../ui.js";
import { ok, fail, info } from "../installers/report.js";
import { INSTALLERS } from "../installers/registry.js";
import { loadToolchainConfig, selectEntries } from "../toolchain.js";
const HELP = `${BIN_NAME} fix — repair missing/broken tools from .luma/toolchain.yml.

Usage: ${BIN_NAME} fix [tool...]

Arguments:
  tool          one or more tool ids from .luma/toolchain.yml (default: all)

Unlike "${BIN_NAME} setup" (which converges every declared tool to its exact
desired version), "${BIN_NAME} fix" only touches tools that are entirely
missing or broken — it never forces a version upgrade on a tool that's
already installed, even if it doesn't match the manifest's declared version.
Run "${BIN_NAME} setup" for that.

Manifest is read from <workspace-root>/.luma/toolchain.yml
(override the path with LUMA_TOOLCHAIN_FILE).
`;
export async function run(argv) {
    if (argv.includes("-h") || argv.includes("--help")) {
        process.stdout.write(HELP);
        return 0;
    }
    let config;
    try {
        config = loadToolchainConfig();
    }
    catch (err) {
        process.stderr.write(`${BIN_NAME} fix: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
    let entries;
    try {
        entries = selectEntries(config.entries, argv);
    }
    catch (err) {
        process.stderr.write(`${BIN_NAME} fix: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
    section(`== fix (${config.configPath}) ==`);
    let hadFailure = false;
    let fixedAny = false;
    for (const entry of entries) {
        const installer = INSTALLERS[entry.id];
        if (!installer)
            continue;
        const before = await installer.check(entry.desired);
        if (before.installed) {
            ok(`${installer.label}: ${before.detail} (already installed, not touching version)`);
            continue;
        }
        fixedAny = true;
        process.stdout.write(`${c.bold(installer.label)}: repairing...\n`);
        const fixFn = installer.fix ?? installer.install;
        const fixed = await fixFn(entry.desired);
        if (!fixed) {
            fail(`${installer.label}: automated fix did not complete`);
            for (const line of installer.hint(CHI_OS))
                info(line);
            hadFailure = true;
            continue;
        }
        const after = await installer.check(entry.desired);
        if (after.installed) {
            ok(`${installer.label}: ${after.detail}`);
        }
        else {
            fail(`${installer.label}: still not detected after install`);
            hadFailure = true;
        }
    }
    if (!fixedAny && !hadFailure) {
        ok("nothing to fix — every declared tool is installed");
    }
    return hadFailure ? 1 : 0;
}
//# sourceMappingURL=fix.js.map
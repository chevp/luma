import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHI_OS } from "../platform.js";
import { commandExists, execInherit } from "../spawn.js";
import { git, isInsideRepo } from "../git/index.js";
const HELP = `chi reinstall — re-run the current repo's reinstall script.

Usage: chi reinstall [--] [args...]

Looks for the repo-local reinstall script. On Windows, the .ps1 form is
preferred. Elsewhere, the .sh form is preferred.

  windows: scripts/reinstall.ps1 → scripts/reinstall.sh
  other:   scripts/reinstall.sh  → scripts/reinstall.ps1

Both are searched in the cwd first, then at the git root.
Any extra args are forwarded to the chosen script.
`;
export async function run(argv) {
    let args = argv;
    if (args[0] === "-h" || args[0] === "--help") {
        process.stdout.write(HELP);
        return 0;
    }
    if (args[0] === "--")
        args = args.slice(1);
    let gitRoot = "";
    if (isInsideRepo()) {
        gitRoot = git(["rev-parse", "--show-toplevel"]).stdout.trim();
    }
    const sh = "scripts/reinstall.sh";
    const ps1 = "scripts/reinstall.ps1";
    const candidates = CHI_OS === "windows"
        ? [
            join(process.cwd(), ps1),
            gitRoot ? join(gitRoot, ps1) : "",
            join(process.cwd(), sh),
            gitRoot ? join(gitRoot, sh) : "",
        ]
        : [
            join(process.cwd(), sh),
            gitRoot ? join(gitRoot, sh) : "",
            join(process.cwd(), ps1),
            gitRoot ? join(gitRoot, ps1) : "",
        ];
    for (const path of candidates) {
        if (!path || !existsSync(path))
            continue;
        if (path.endsWith(".ps1")) {
            const psh = commandExists("pwsh") ? "pwsh" : commandExists("powershell") ? "powershell" : "";
            if (!psh) {
                process.stderr.write(`chi reinstall: found ${path} but no PowerShell available\n` +
                    "  install pwsh: winget install Microsoft.PowerShell\n");
                return 1;
            }
            return execInherit(psh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path, ...args]);
        }
        return execInherit("bash", [path, ...args]);
    }
    process.stderr.write(`chi reinstall: no scripts/reinstall.sh found in ${process.cwd()}${gitRoot ? ` or ${gitRoot}` : ""}\n` +
        "Convention: each repo provides its own scripts/reinstall.sh.\n");
    return 1;
}
//# sourceMappingURL=reinstall.js.map
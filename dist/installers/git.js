import { CHI_OS } from "../platform.js";
import { commandExists, execSync } from "../spawn.js";
import { satisfiesDesired } from "./types.js";
import { installViaApt, installViaBrew, installViaWinget } from "./pkgmanagers.js";
async function check(desired) {
    if (!commandExists("git")) {
        return { installed: false, satisfies: false, detail: "git not installed" };
    }
    const version = execSync("git", ["--version"]).stdout.trim().split(/\s+/)[2] ?? "?";
    return { installed: true, version, satisfies: satisfiesDesired(desired, version), detail: `git ${version}` };
}
async function install() {
    switch (CHI_OS) {
        case "windows":
            return installViaWinget("Git.Git");
        case "darwin":
            return installViaBrew("git");
        case "wsl":
        case "linux":
            return installViaApt(["git"]);
        default:
            return false;
    }
}
function hint(os) {
    switch (os) {
        case "darwin":
            return ["install: brew install git"];
        case "windows":
            return ["install: https://git-scm.com/download/win"];
        case "wsl":
        case "linux":
            return ["install: sudo apt-get install git  (or your distro equivalent)"];
        default:
            return ["install: https://git-scm.com/downloads"];
    }
}
export const gitInstaller = { id: "git", label: "git", check, install, hint };
//# sourceMappingURL=git.js.map
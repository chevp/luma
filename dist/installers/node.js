import { CHI_OS } from "../platform.js";
import { commandExists, execSync } from "../spawn.js";
import { satisfiesDesired } from "./types.js";
import { installViaApt, installViaBrew, installViaWinget } from "./pkgmanagers.js";
async function check(desired) {
    if (!commandExists("node")) {
        return { installed: false, satisfies: false, detail: "node not installed" };
    }
    const raw = execSync("node", ["--version"]).stdout.trim();
    const version = raw.replace(/^v/, "");
    return { installed: true, version, satisfies: satisfiesDesired(desired, version), detail: `node ${raw}` };
}
async function install() {
    switch (CHI_OS) {
        case "windows":
            return installViaWinget("OpenJS.NodeJS.LTS");
        case "darwin":
            return installViaBrew("node");
        case "wsl":
        case "linux":
            return installViaApt(["nodejs", "npm"]);
        default:
            return false;
    }
}
function hint(os) {
    switch (os) {
        case "darwin":
            return ["install: brew install node"];
        case "windows":
            return ["install: winget install OpenJS.NodeJS.LTS"];
        case "wsl":
        case "linux":
            return [
                "install: sudo apt-get install nodejs npm",
                "or use nodesource for a current LTS: https://github.com/nodesource/distributions",
            ];
        default:
            return ["install: https://nodejs.org/en/download"];
    }
}
export const nodeInstaller = { id: "node", label: "Node.js", check, install, hint };
//# sourceMappingURL=node.js.map
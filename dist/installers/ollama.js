import { CHI_OS } from "../platform.js";
import { commandExists, execSync } from "../spawn.js";
import { satisfiesDesired } from "./types.js";
import { installViaBrew, installViaWinget } from "./pkgmanagers.js";
import { info } from "./report.js";
async function check(desired) {
    if (!commandExists("ollama")) {
        return { installed: false, satisfies: false, detail: "ollama not installed" };
    }
    const version = execSync("ollama", ["--version"]).stdout.trim() || "?";
    return { installed: true, version, satisfies: satisfiesDesired(desired, version), detail: version };
}
async function install() {
    switch (CHI_OS) {
        case "windows":
            return installViaWinget("Ollama.Ollama");
        case "darwin":
            return installViaBrew("ollama", true);
        case "wsl":
        case "linux":
            info("run: curl -fsSL https://ollama.com/install.sh | sh");
            return false;
        default:
            return false;
    }
}
function hint(os) {
    switch (os) {
        case "darwin":
            return ["install: brew install --cask ollama"];
        case "windows":
            return ["install: winget install Ollama.Ollama"];
        case "wsl":
        case "linux":
            return ["install: curl -fsSL https://ollama.com/install.sh | sh"];
        default:
            return ["install: https://ollama.com/download"];
    }
}
export const ollamaInstaller = { id: "ollama", label: "Ollama", check, install, hint };
//# sourceMappingURL=ollama.js.map
import { CHI_OS } from "../platform.js";
import { commandExists } from "../spawn.js";
import { installViaBrew, installViaWinget } from "./pkgmanagers.js";
import { info } from "./report.js";
async function check() {
    const installed = commandExists("code");
    return {
        installed,
        satisfies: installed,
        detail: installed ? "vscode (code) on PATH" : "vscode not installed (or 'code' not on PATH)",
    };
}
async function install() {
    switch (CHI_OS) {
        case "windows":
            return installViaWinget("Microsoft.VisualStudioCode");
        case "darwin":
            return installViaBrew("visual-studio-code", true);
        case "wsl":
        case "linux":
            info("no reliable apt package — install from https://code.visualstudio.com/download");
            return false;
        default:
            return false;
    }
}
function hint(os) {
    switch (os) {
        case "darwin":
            return ["install: brew install --cask visual-studio-code"];
        case "windows":
            return ["install: winget install Microsoft.VisualStudioCode"];
        default:
            return ["install: https://code.visualstudio.com/download"];
    }
}
export const vscodeInstaller = { id: "vscode", label: "VS Code", check, install, hint };
//# sourceMappingURL=vscode.js.map
import { commandExists, execInherit } from "../spawn.js";
import { info } from "./report.js";
/** `winget install --id <id> -e --accept-package-agreements --accept-source-agreements` */
export async function installViaWinget(id) {
    if (!commandExists("winget")) {
        info("winget not found — install it from the Microsoft Store (App Installer)");
        return false;
    }
    const rc = await execInherit("winget", [
        "install",
        "--id",
        id,
        "-e",
        "--accept-package-agreements",
        "--accept-source-agreements",
    ]);
    return rc === 0;
}
/** `brew install [--cask] <id>` */
export async function installViaBrew(id, cask = false) {
    if (!commandExists("brew")) {
        info("Homebrew not found — install it from https://brew.sh");
        return false;
    }
    const args = cask ? ["install", "--cask", id] : ["install", id];
    const rc = await execInherit("brew", args);
    return rc === 0;
}
/** `sudo apt-get install -y <pkgs...>` — best-effort, apt/dpkg based distros only. */
export async function installViaApt(pkgs) {
    if (!commandExists("apt-get")) {
        info("apt-get not found — install manually for your distro");
        return false;
    }
    const rc = await execInherit("sudo", ["apt-get", "install", "-y", ...pkgs]);
    return rc === 0;
}
//# sourceMappingURL=pkgmanagers.js.map
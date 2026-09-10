/**
 * check: full — install: best-effort.
 *
 * winget/brew have straightforward Blender packages; apt distros generally
 * need snap (classic confinement) or the official tarball, so linux install()
 * prints manual steps instead of guessing at a snap dependency.
 */
import { CHI_OS } from "../platform.js";
import { commandExists, execSync } from "../spawn.js";
import { satisfiesDesired } from "./types.js";
import { installViaBrew, installViaWinget } from "./pkgmanagers.js";
import { info } from "./report.js";
async function check(desired) {
    if (!commandExists("blender")) {
        return { installed: false, satisfies: false, detail: "blender not installed" };
    }
    const out = execSync("blender", ["--version"]).stdout.trim().split(/\r?\n/)[0] ?? "";
    const m = out.match(/Blender\s+([\d.]+)/i);
    const version = m?.[1] ?? "?";
    return { installed: true, version, satisfies: satisfiesDesired(desired, version), detail: out || `blender ${version}` };
}
async function install() {
    switch (CHI_OS) {
        case "windows":
            return installViaWinget("BlenderFoundation.Blender");
        case "darwin":
            return installViaBrew("blender", true);
        case "wsl":
        case "linux":
            info("run: sudo snap install blender --classic");
            info("or download the tarball from https://www.blender.org/download/");
            return false;
        default:
            return false;
    }
}
function hint(os) {
    switch (os) {
        case "darwin":
            return ["install: brew install --cask blender"];
        case "windows":
            return ["install: winget install BlenderFoundation.Blender"];
        case "wsl":
        case "linux":
            return ["install: sudo snap install blender --classic", "or https://www.blender.org/download/"];
        default:
            return ["download from https://www.blender.org/download/"];
    }
}
export const blenderInstaller = { id: "blender", label: "Blender", check, install, hint };
//# sourceMappingURL=blender.js.map
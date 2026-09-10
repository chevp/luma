import { CHI_OS } from "../platform.js";
import { commandExists, execSync } from "../spawn.js";
import { satisfiesDesired } from "./types.js";
import { installViaApt, installViaBrew, installViaWinget } from "./pkgmanagers.js";
async function check(desired) {
    if (!commandExists("cmake")) {
        return { installed: false, satisfies: false, detail: "cmake not installed" };
    }
    const firstLine = execSync("cmake", ["--version"]).stdout.trim().split(/\r?\n/)[0] ?? "";
    const version = firstLine.split(/\s+/).pop() ?? "?";
    return { installed: true, version, satisfies: satisfiesDesired(desired, version), detail: `cmake ${version}` };
}
async function install() {
    switch (CHI_OS) {
        case "windows":
            return installViaWinget("Kitware.CMake");
        case "darwin":
            return installViaBrew("cmake");
        case "wsl":
        case "linux":
            return installViaApt(["cmake"]);
        default:
            return false;
    }
}
function hint(os) {
    switch (os) {
        case "darwin":
            return ["install: brew install cmake"];
        case "windows":
            return ["install: winget install Kitware.CMake"];
        case "wsl":
        case "linux":
            return ["install: sudo apt-get install cmake"];
        default:
            return ["install: https://cmake.org/download/"];
    }
}
export const cmakeInstaller = { id: "cmake", label: "CMake", check, install, hint };
//# sourceMappingURL=cmake.js.map
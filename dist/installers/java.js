import { CHI_OS } from "../platform.js";
import { commandExists, execSync } from "../spawn.js";
import { satisfiesDesired } from "./types.js";
import { installViaApt, installViaBrew, installViaWinget } from "./pkgmanagers.js";
const DEFAULT_MAJOR = "21";
function majorVersion(desired) {
    if (desired === true)
        return DEFAULT_MAJOR;
    const m = desired.match(/^\d+/);
    return m ? m[0] : DEFAULT_MAJOR;
}
async function check(desired) {
    if (!commandExists("java")) {
        return { installed: false, satisfies: false, detail: "java not installed" };
    }
    // `java -version` prints to stderr, e.g. `openjdk version "21.0.4" ...`
    const out = execSync("java", ["-version"]).stderr;
    const m = out.match(/version "(\d+(?:\.\d+)*)/);
    const version = m?.[1] ?? "?";
    return { installed: true, version, satisfies: satisfiesDesired(desired, version), detail: `java ${version}` };
}
async function install(desired) {
    const major = majorVersion(desired);
    switch (CHI_OS) {
        case "windows":
            return installViaWinget(`EclipseAdoptium.Temurin.${major}.JDK`);
        case "darwin":
            return installViaBrew(`openjdk@${major}`);
        case "wsl":
        case "linux":
            return installViaApt([`openjdk-${major}-jdk`]);
        default:
            return false;
    }
}
function hint(os) {
    switch (os) {
        case "darwin":
            return ["install: brew install openjdk@21  (or the major version you need)"];
        case "windows":
            return ["install: winget install EclipseAdoptium.Temurin.21.JDK"];
        case "wsl":
        case "linux":
            return ["install: sudo apt-get install openjdk-21-jdk"];
        default:
            return ["install: https://adoptium.net/"];
    }
}
export const javaInstaller = { id: "java", label: "Java", check, install, hint };
//# sourceMappingURL=java.js.map
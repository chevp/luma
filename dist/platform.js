import { platform, release } from "node:os";
import { existsSync, readFileSync } from "node:fs";
export function detectPlatform() {
    switch (platform()) {
        case "darwin":
            return "darwin";
        case "win32":
            return "windows";
        case "linux":
            if (process.env.WSL_DISTRO_NAME)
                return "wsl";
            try {
                if (existsSync("/proc/version")) {
                    const v = readFileSync("/proc/version", "utf8");
                    if (/microsoft/i.test(v))
                        return "wsl";
                }
            }
            catch {
                // ignore
            }
            return "linux";
        default:
            return "unknown";
    }
}
export const CHI_OS = detectPlatform();
export const _release = release;
//# sourceMappingURL=platform.js.map
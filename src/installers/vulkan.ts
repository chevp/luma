/**
 * check: full — install: best-effort.
 *
 * The Vulkan SDK has no reliable package-manager id on macOS and only ships a
 * runtime (not the full SDK: headers, validation layers, glslc, ...) via apt.
 * `install()` uses winget on Windows where a real SDK package exists; on
 * darwin/linux it prints manual steps and returns false rather than claiming
 * a fake success.
 */
import { CHI_OS, type ChiOS } from "../platform.js";
import { commandExists, execSync } from "../spawn.js";
import type { CheckResult, Installer } from "./types.js";
import { satisfiesDesired } from "./types.js";
import { installViaApt, installViaWinget } from "./pkgmanagers.js";
import { info } from "./report.js";

async function check(desired: string | true): Promise<CheckResult> {
  const sdkEnv = process.env.VULKAN_SDK;
  if (commandExists("vulkaninfo")) {
    const out = execSync("vulkaninfo", ["--summary"]).stdout;
    const m = out.match(/Vulkan Instance Version:\s*([\d.]+)/i);
    const version = m?.[1] ?? sdkEnv ?? "?";
    return { installed: true, version, satisfies: satisfiesDesired(desired, version), detail: `vulkan ${version}` };
  }
  if (sdkEnv) {
    return { installed: true, version: sdkEnv, satisfies: true, detail: `VULKAN_SDK=${sdkEnv}` };
  }
  return { installed: false, satisfies: false, detail: "Vulkan SDK not found (no vulkaninfo, no VULKAN_SDK)" };
}

async function install(): Promise<boolean> {
  switch (CHI_OS) {
    case "windows": {
      const ok = await installViaWinget("KhronosGroup.VulkanSDK");
      info("after install, restart your shell so VULKAN_SDK / PATH are picked up");
      return ok;
    }
    case "wsl":
    case "linux":
      await installViaApt(["libvulkan-dev", "vulkan-tools"]);
      info("that installs the runtime + tools only — for the full SDK (headers, glslc, validation layers)");
      info("download from https://vulkan.lunarg.com/sdk/home#linux and follow the install script");
      return false;
    case "darwin":
      info("download the macOS installer (MoltenVK-based) from https://vulkan.lunarg.com/sdk/home#mac");
      return false;
    default:
      return false;
  }
}

function hint(os: ChiOS): string[] {
  switch (os) {
    case "windows":
      return ["install: winget install KhronosGroup.VulkanSDK", "or download from https://vulkan.lunarg.com/sdk/home#windows"];
    case "darwin":
      return ["download the macOS installer from https://vulkan.lunarg.com/sdk/home#mac"];
    case "wsl":
    case "linux":
      return [
        "runtime only: sudo apt-get install libvulkan-dev vulkan-tools",
        "full SDK: https://vulkan.lunarg.com/sdk/home#linux",
      ];
    default:
      return ["download from https://vulkan.lunarg.com/sdk/home"];
  }
}

export const vulkanInstaller: Installer = { id: "vulkan", label: "Vulkan SDK", check, install, hint };

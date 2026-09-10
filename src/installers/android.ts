/**
 * check: full — install: best-effort.
 *
 * There is no single package that gives you a working Android SDK + NDK:
 * even after installing Android Studio (or the standalone command-line
 * tools), `sdkmanager` needs an interactive license acceptance and an
 * explicit list of packages to fetch. `install()` gets the IDE/CLI tools
 * bundle onto the machine where a package id exists, then always prints the
 * `sdkmanager` follow-up commands instead of pretending the SDK is ready.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHI_OS, type ChiOS } from "../platform.js";
import { commandExists, execSync } from "../spawn.js";
import type { CheckResult, Installer } from "./types.js";
import { installViaBrew, installViaWinget } from "./pkgmanagers.js";
import { info } from "./report.js";

function androidHome(): string | undefined {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
}

async function check(): Promise<CheckResult> {
  const home = androidHome();
  const hasCli = commandExists("sdkmanager") || commandExists("adb");
  if (!home && !hasCli) {
    return {
      installed: false,
      satisfies: false,
      detail: "Android SDK not found (no ANDROID_HOME/ANDROID_SDK_ROOT, no sdkmanager/adb on PATH)",
    };
  }

  const parts: string[] = [];
  if (home) parts.push(`ANDROID_HOME=${home}`);

  let sdkVersion = "?";
  const r = execSync("sdkmanager", ["--version"]);
  if (r.ok) sdkVersion = r.stdout.trim();

  const ndkPresent = home ? existsSync(join(home, "ndk")) : false;
  parts.push(`sdkmanager ${sdkVersion}`, ndkPresent ? "ndk: present" : "ndk: missing");

  return {
    installed: true,
    version: sdkVersion,
    satisfies: ndkPresent,
    detail: parts.join(", "),
  };
}

async function install(): Promise<boolean> {
  let bundleInstalled = false;
  switch (CHI_OS) {
    case "windows":
      bundleInstalled = await installViaWinget("Google.AndroidStudio");
      break;
    case "darwin":
      bundleInstalled = await installViaBrew("android-studio", true);
      break;
    case "wsl":
    case "linux":
      info("no reliable apt package — download Android Studio from https://developer.android.com/studio");
      break;
    default:
      break;
  }
  info("after Android Studio's setup wizard finishes, install the SDK + NDK from the command line:");
  info("  sdkmanager --licenses");
  info('  sdkmanager "platform-tools" "platforms;android-34" "ndk;26.1.10909125"');
  return bundleInstalled;
}

function hint(os: ChiOS): string[] {
  const lines = [
    "set ANDROID_HOME to your SDK path",
    "sdkmanager --licenses",
    'sdkmanager "platform-tools" "platforms;android-34" "ndk;26.1.10909125"',
  ];
  switch (os) {
    case "windows":
      return ["install: winget install Google.AndroidStudio", ...lines];
    case "darwin":
      return ["install: brew install --cask android-studio", ...lines];
    default:
      return ["download Android Studio from https://developer.android.com/studio", ...lines];
  }
}

export const androidInstaller: Installer = { id: "android", label: "Android SDK/NDK", check, install, hint };

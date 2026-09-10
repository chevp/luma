import { CHI_OS, type ChiOS } from "../platform.js";
import { commandExists } from "../spawn.js";
import type { CheckResult, Installer } from "./types.js";
import { installViaBrew, installViaWinget } from "./pkgmanagers.js";
import { info } from "./report.js";

async function check(): Promise<CheckResult> {
  const installed = commandExists("code");
  return {
    installed,
    satisfies: installed,
    detail: installed ? "vscode (code) on PATH" : "vscode not installed (or 'code' not on PATH)",
  };
}

async function install(): Promise<boolean> {
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

function hint(os: ChiOS): string[] {
  switch (os) {
    case "darwin":
      return ["install: brew install --cask visual-studio-code"];
    case "windows":
      return ["install: winget install Microsoft.VisualStudioCode"];
    default:
      return ["install: https://code.visualstudio.com/download"];
  }
}

export const vscodeInstaller: Installer = { id: "vscode", label: "VS Code", check, install, hint };

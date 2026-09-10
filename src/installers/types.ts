import type { ChiOS } from "../platform.js";

export interface CheckResult {
  installed: boolean;
  /** Detected version string, if any (e.g. "3.31.0"). */
  version?: string;
  /** Whether the installed state satisfies `desired`. */
  satisfies: boolean;
  /** One-line human-readable status for doctor/setup output. */
  detail: string;
}

export interface Installer {
  id: string;
  label: string;
  /**
   * `check: full` for every tool; `install: best-effort` for the tools noted
   * in each module's header comment (android/vulkan/blender) — those attempt
   * an automated install where a package id exists, then always print manual
   * follow-up steps rather than claiming full automation.
   */
  check(desired: string | true): Promise<CheckResult>;
  install(desired: string | true): Promise<boolean>;
  /** Repairs a missing/broken install. Defaults to `install()` when absent. */
  fix?(desired: string | true): Promise<boolean>;
  /** Manual install instructions, one line per entry. */
  hint(os: ChiOS): string[];
}

/** `true`/"latest" always satisfies an installed tool; otherwise prefix-match. */
export function satisfiesDesired(desired: string | true, version: string | undefined): boolean {
  if (!version) return false;
  if (desired === true) return true;
  return version.trim().startsWith(desired.trim());
}

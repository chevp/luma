import { basename } from "node:path";

/**
 * Display name for the running binary. Drives error prefixes, help text, and
 * the status-section header so that wrappers (`jan`, `che`, …) present as
 * themselves rather than as `chi`.
 *
 * Resolution order: `CHI_INVOKED_AS` env var, then basename(argv[1]) with any
 * .cmd/.exe extension stripped, falling back to `"chi"`.
 */
function deriveBinName(): string {
  const env = process.env.CHI_INVOKED_AS?.trim();
  if (env) return env;
  const argv1 = process.argv[1];
  if (!argv1) return "chi";
  let name = basename(argv1);
  if (name.endsWith(".cmd")) name = name.slice(0, -4);
  if (name.endsWith(".exe")) name = name.slice(0, -4);
  return name || "chi";
}

export const BIN_NAME = deriveBinName();
export const BIN_TAG = `${BIN_NAME}-cli`;

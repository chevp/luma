import { c } from "./ui.js";
import { BIN_NAME } from "./identity.js";
/**
 * Dry-run / training mode: print what would happen, write nothing. Carried in
 * an env var (not a flag) so it propagates automatically into nested ship
 * invocations — submodules and the workspace fan-out.
 */
export const DRY_ENV = "__LUMA_DRY";
export function isDry() {
    return process.env[DRY_ENV] === "1";
}
/** Print a `[DRY] … ship: <msg>` line describing an action that was skipped. */
export function dryNote(msg) {
    process.stdout.write(`${c.yellow("[DRY]")} ${c.dim(`${BIN_NAME} ship:`)} ${msg}\n`);
}
//# sourceMappingURL=dry.js.map
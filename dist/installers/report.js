import { c, sym } from "../ui.js";
export function ok(msg) {
    process.stdout.write(`  ${sym.ok} ${msg}\n`);
}
export function fail(msg) {
    process.stdout.write(`  ${sym.err} ${c.red("error:")} ${msg}\n`);
}
export function warn(msg) {
    process.stdout.write(`  ${sym.warn} ${c.yellow("warn:")} ${msg}\n`);
}
export function info(msg) {
    process.stdout.write(`  ${c.dim("hint:")} ${c.dim(msg)}\n`);
}
export async function runSection(name, fn) {
    process.stdout.write(`${name}:\n`);
    try {
        await fn();
    }
    catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
}
//# sourceMappingURL=report.js.map
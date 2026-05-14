import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { getPath, lengthOf, parseYaml } from "../yaml.js";
/**
 * Path to chi's install root (the directory containing chi's own `.che/`).
 *
 * Both compiled (`<root>/dist/workflow/loader.js`) and dev (`<root>/src/workflow/loader.ts`
 * via tsx) layouts place this file two directories below the install root.
 */
export function bundleRoot() {
    return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}
/**
 * Look up `<name>.yml|yaml` inside chi's bundled `.che/workflows/`.
 * Returns null when chi was not installed with its `.che/` (e.g. partial
 * checkout) or the named workflow is not bundled.
 */
function findBuiltin(name) {
    const root = bundleRoot();
    const dir = join(root, ".che", "workflows");
    if (!existsSync(dir) || !statSync(dir).isDirectory())
        return null;
    for (const ext of ["yml", "yaml"]) {
        const file = join(dir, `${name}.${ext}`);
        if (existsSync(file))
            return { root, dir, file };
    }
    return null;
}
export class WorkflowError extends Error {
}
/** Walk up from `cwd` looking for `.che/workflows`. Returns null if not found. */
export function findWorkflowsDir(cwd = process.cwd()) {
    let dir = cwd;
    for (;;) {
        const candidate = join(dir, ".che", "workflows");
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return { root: dir, dir: candidate };
        }
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
export function loadFile(file) {
    return parseYaml(readFileSync(file, "utf8"));
}
/**
 * Resolve <name> to a workflow yml/yaml file, parsed and validated.
 *
 * Resolution order:
 *   1. Per-repo override — walk up from cwd looking for `.che/workflows/<name>`.
 *   2. Bundled fallback — chi's own `.che/workflows/<name>` shipped with the CLI.
 *
 * Per-repo always wins, so users can override any built-in workflow by dropping
 * a same-named file into their repo's `.che/workflows/`.
 */
export function resolveWorkflow(name, cwd = process.cwd()) {
    if (!name)
        throw new WorkflowError("missing workflow name");
    const where = findWorkflowsDir(cwd);
    if (where) {
        for (const ext of ["yml", "yaml"]) {
            const file = join(where.dir, `${name}.${ext}`);
            if (existsSync(file)) {
                const doc = loadFile(file);
                return { root: where.root, dir: where.dir, file, doc, builtin: false };
            }
        }
    }
    const builtin = findBuiltin(name);
    if (builtin) {
        const doc = loadFile(builtin.file);
        return { root: builtin.root, dir: builtin.dir, file: builtin.file, doc, builtin: true };
    }
    if (!where)
        throw new WorkflowError(`no .che/workflows/ found above ${cwd}`);
    throw new WorkflowError(`workflow not found: ${name} (looked in ${where.dir} or chi's bundled workflows)`);
}
/** Validate the top-level shape: name + non-empty steps with `script:` each. */
export function validate(doc, file) {
    const name = getPath(doc, ".name");
    if (typeof name !== "string" || name.length === 0) {
        throw new WorkflowError(`${file}: missing 'name'`);
    }
    const steps = getPath(doc, ".steps");
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new WorkflowError(`${file}: 'steps' must be a non-empty list`);
    }
    for (let i = 0; i < steps.length; i++) {
        const script = getPath(doc, `.steps[${i}].script`);
        if (typeof script !== "string" || script.length === 0) {
            throw new WorkflowError(`${file}: steps[${i}] is missing 'script' (no inline bash allowed)`);
        }
    }
}
export function createInputs() {
    const map = new Map();
    return {
        set(k, v) {
            map.set(k, v);
        },
        get(k) {
            return map.get(k);
        },
        has(k) {
            return map.has(k);
        },
        substitute(s) {
            let out = s;
            for (const [k, v] of map) {
                out = out.split(`\${${k}}`).join(v);
            }
            return out;
        },
    };
}
export function inputDecls(doc) {
    const list = getPath(doc, ".inputs");
    if (!Array.isArray(list))
        return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const name = getPath(doc, `.inputs[${i}].name`);
        if (typeof name !== "string" || !name)
            continue;
        const req = getPath(doc, `.inputs[${i}].required`);
        const desc = getPath(doc, `.inputs[${i}].description`);
        out.push({
            name,
            required: req === true || req === "true",
            description: typeof desc === "string" ? desc : "",
        });
    }
    return out;
}
export function planSteps(doc, inputs) {
    const steps = getPath(doc, ".steps");
    if (!Array.isArray(steps))
        return [];
    const out = [];
    for (let i = 0; i < steps.length; i++) {
        const rawName = getPath(doc, `.steps[${i}].name`);
        const rawScript = getPath(doc, `.steps[${i}].script`);
        const argsLen = lengthOf(getPath(doc, `.steps[${i}].args`));
        const args = [];
        for (let j = 0; j < argsLen; j++) {
            const v = getPath(doc, `.steps[${i}].args[${j}]`);
            args.push(inputs.substitute(stringify(v)));
        }
        const name = typeof rawName === "string" && rawName ? rawName : `step ${i + 1}`;
        const script = typeof rawScript === "string" ? inputs.substitute(rawScript) : "";
        out.push({ name, script, args });
    }
    return out;
}
function stringify(v) {
    if (v === null || v === undefined)
        return "";
    if (typeof v === "string")
        return v;
    if (typeof v === "number" || typeof v === "boolean")
        return String(v);
    return JSON.stringify(v);
}
export function resolveTrigger(trigger, cwd = process.cwd()) {
    if (!trigger)
        return { kind: "none" };
    const where = findWorkflowsDir(cwd);
    if (!where)
        return { kind: "none" };
    const matches = [];
    for (const entry of readdirSync(where.dir)) {
        if (!/\.(ya?ml)$/.test(entry))
            continue;
        const file = join(where.dir, entry);
        let doc;
        try {
            doc = loadFile(file);
        }
        catch {
            continue;
        }
        const t = getPath(doc, ".trigger");
        if (Array.isArray(t)) {
            if (t.some((v) => v === trigger))
                matches.push({ file, doc });
        }
        else if (typeof t === "string") {
            if (t === trigger)
                matches.push({ file, doc });
        }
    }
    if (matches.length === 0)
        return { kind: "none" };
    if (matches.length > 1)
        return { kind: "ambiguous", files: matches.map((m) => m.file) };
    const m = matches[0];
    const stem = parse(m.file).name;
    return {
        kind: "match",
        resolved: { root: where.root, dir: where.dir, file: m.file, doc: m.doc, builtin: false },
        stem,
    };
}
//# sourceMappingURL=loader.js.map
import { readdirSync } from "node:fs";
import { basename, isAbsolute, join, parse } from "node:path";
import { c } from "../ui.js";
import {
  createInputs,
  findWorkflowsDir,
  inputDecls,
  loadFile,
  planSteps,
  resolveWorkflow,
  validate,
  WorkflowError,
} from "../workflow/loader.js";
import { getPath } from "../yaml.js";
import { execInherit } from "../spawn.js";
import { existsSync } from "node:fs";
import { BIN_NAME } from "../identity.js";

const HELP = `${BIN_NAME} workflow — manage and run scripted workflows from .che/workflows/*.yml

Usage: ${BIN_NAME} workflow <subcommand> [args]

Subcommands:
  list                       list workflows in the current repo
  show <name>                print the parsed plan of a workflow
  run  <name> [--k=v ...]    execute a workflow (also: ${BIN_NAME} run <name>)

A workflow is a YAML manifest that references existing scripts. Each step
declares 'script:' (an executable path relative to the workflow root) and
optional 'args:' with \${input} substitution. No inline bash.
`;

function cmdList(): number {
  const where = findWorkflowsDir();
  if (!where) {
    process.stderr.write(`${BIN_NAME} workflow: no .che/workflows/ found above ${process.cwd()}\n`);
    return 1;
  }
  const entries = readdirSync(where.dir).filter((e) => /\.(ya?ml)$/.test(e));
  if (entries.length === 0) {
    process.stderr.write(`no workflows in ${where.dir}\n`);
    return 0;
  }
  process.stdout.write(`${where.dir}\n`);
  for (const entry of entries) {
    const stem = parse(entry).name;
    let desc = "";
    let trig = "";
    try {
      const doc = loadFile(`${where.dir}/${entry}`);
      const d = getPath(doc, ".description");
      if (typeof d === "string") desc = d;
      const t = getPath(doc, ".trigger");
      if (Array.isArray(t)) {
        trig = t.filter((v) => typeof v === "string").join(" | chi ");
      } else if (typeof t === "string") {
        trig = t;
      }
    } catch (err) {
      process.stderr.write(`  (skipping ${entry}: ${(err as Error).message})\n`);
      continue;
    }
    let line = `  ${c.bold(stem)}`;
    if (desc) line += ` — ${desc}`;
    if (trig) line += `  ${c.dim(`(chi ${trig})`)}`;
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

function cmdShow(argv: string[]): number {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(`Usage: chi workflow show <name>\n`);
    return argv.length === 0 ? 1 : 0;
  }
  const name = argv[0]!;
  if (argv.length > 1) {
    process.stderr.write(`${BIN_NAME} workflow show: unexpected extra arguments\n`);
    return 1;
  }
  let resolved;
  try {
    resolved = resolveWorkflow(name);
    validate(resolved.doc, resolved.file);
  } catch (err) {
    process.stderr.write(`${BIN_NAME} workflow: ${(err as Error).message}\n`);
    return 1;
  }
  const { doc, file, root } = resolved;
  const get = (e: string): string => {
    const v = getPath(doc, e);
    return typeof v === "string" ? v : v == null ? "" : String(v);
  };

  process.stdout.write(`${c.bold("name")}        ${get(".name")}\n`);
  const desc = get(".description");
  if (desc) process.stdout.write(`${c.bold("description")} ${desc}\n`);
  const t = getPath(doc, ".trigger");
  if (Array.isArray(t)) {
    const list = t.filter((v) => typeof v === "string").join(" | chi ");
    process.stdout.write(`${c.bold("trigger")}     chi ${list}\n`);
  } else if (typeof t === "string") {
    process.stdout.write(`${c.bold("trigger")}     chi ${t}\n`);
  }
  process.stdout.write(`${c.bold("file")}        ${file}\n`);
  process.stdout.write(`${c.bold("root")}        ${root}\n`);

  const inputs = inputDecls(doc);
  if (inputs.length > 0) {
    process.stdout.write(`\n${c.bold("inputs")}\n`);
    for (const inp of inputs) {
      const tag = inp.required ? "required" : "optional";
      if (inp.description) {
        process.stdout.write(`  - ${inp.name}  (${tag})  ${c.dim(inp.description)}\n`);
      } else {
        process.stdout.write(`  - ${inp.name}  (${tag})\n`);
      }
    }
  }

  const plan = planSteps(doc, createInputs());
  process.stdout.write(`\n${c.bold("steps")}\n`);
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i]!;
    process.stdout.write(`  ${i + 1}. ${s.name}\n`);
    process.stdout.write(`     ${c.dim("script")} ${s.script}\n`);
    if (s.args.length > 0) {
      process.stdout.write(`     ${c.dim("args")}   ${s.args.join(" ")}\n`);
    }
  }
  return 0;
}

interface RunOpts {
  name: string;
  dry: boolean;
  inputs: Array<[string, string]>;
}

function parseRun(argv: string[]): RunOpts | { help: true } | { error: string } {
  const o: RunOpts = { name: "", dry: false, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--dry-run") {
      o.dry = true;
      continue;
    }
    if (a.startsWith("--") && a.includes("=")) {
      const kv = a.slice(2);
      const eq = kv.indexOf("=");
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (!k) return { error: `empty --key in '${a}'` };
      o.inputs.push([k, v]);
      continue;
    }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[++i];
      if (v === undefined) return { error: `missing value for --${k}` };
      o.inputs.push([k, v]);
      continue;
    }
    if (a.startsWith("-")) return { error: `unknown option '${a}'` };
    if (o.name) {
      return { error: `only one workflow name accepted (got '${o.name}' and '${a}')` };
    }
    o.name = a;
  }
  return o;
}

async function cmdRun(argv: string[]): Promise<number> {
  const parsed = parseRun(argv);
  if ("help" in parsed) {
    process.stdout.write(
      `chi workflow run — execute a workflow's steps.

Usage:
  chi workflow run <name> [--key=value ...]
  chi run <name> [--key=value ...]      (alias)

Options:
  --dry-run    print the step plan with substituted args; do not exec
  -h, --help   show this help
`,
    );
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`${BIN_NAME} workflow: ${parsed.error}\n`);
    return 1;
  }
  if (!parsed.name) {
    process.stderr.write(`${BIN_NAME} workflow run: missing workflow name\n`);
    return 1;
  }

  let resolved;
  try {
    resolved = resolveWorkflow(parsed.name);
    validate(resolved.doc, resolved.file);
  } catch (err) {
    process.stderr.write(`${BIN_NAME} workflow: ${(err as Error).message}\n`);
    return 1;
  }
  const inputs = createInputs();
  for (const [k, v] of parsed.inputs) inputs.set(k, v);

  // Verify required inputs.
  const missing: string[] = [];
  for (const decl of inputDecls(resolved.doc)) {
    if (decl.required && !inputs.has(decl.name)) missing.push(decl.name);
  }
  if (missing.length > 0) {
    process.stderr.write(`${BIN_NAME} workflow: missing required input(s): ${missing.join(" ")}\n`);
    process.stderr.write(`  pass them as --${missing[0]}=value\n`);
    return 1;
  }

  const plan = planSteps(resolved.doc, inputs);
  const wfName = (() => {
    const n = getPath(resolved.doc, ".name");
    return typeof n === "string" ? n : parsed.name;
  })();

  process.stdout.write(`${c.bold(`── workflow: ${wfName} ──`)}\n`);
  process.stdout.write(`${c.dim("root")} ${resolved.root}${resolved.builtin ? c.dim("  (built-in)") : ""}\n`);

  // Per-repo workflows expect to run from their root (script paths are relative
  // to .che/). Built-in fallbacks must NOT chdir — the script (e.g. issue-fix.sh)
  // calls `chi flow` which has to operate on the user's repo, not chi's bundle.
  if (!resolved.builtin) {
    process.chdir(resolved.root);
  }

  for (let i = 0; i < plan.length; i++) {
    const s = plan[i]!;
    const scriptPath = resolved.builtin && !isAbsolute(s.script)
      ? join(resolved.root, s.script)
      : s.script;
    process.stdout.write(`\n${c.bold(`▶ [${i + 1}/${plan.length}] ${s.name}`)}\n`);
    process.stdout.write(`${c.dim(`  ${scriptPath}${s.args.length ? " " + s.args.map(quoteArg).join(" ") : ""}`)}\n`);
    if (parsed.dry) continue;
    if (!existsSync(scriptPath)) {
      process.stderr.write(`${c.red(`  ✗ script not found: ${scriptPath}`)}\n`);
      return 1;
    }
    const code = await execInherit("bash", [scriptPath, ...s.args]);
    if (code !== 0) {
      process.stderr.write(`${c.red(`  ✗ ${s.name} (exit ${code})`)}\n`);
      return code;
    }
    process.stdout.write(`${c.green(`  ✓ ${s.name}`)}\n`);
  }

  process.stdout.write(`\n${c.bold("── done ──")}\n`);
  return 0;
}

/** Best-effort shell-quote for display only. */
function quoteArg(a: string): string {
  if (a === "") return "''";
  if (/^[A-Za-z0-9_./@:=+-]+$/.test(a)) return a;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

// Hide unused
void basename;

export async function run(argv: string[]): Promise<number> {
  const sub = argv[0] ?? "";
  switch (sub) {
    case "list":
      return cmdList();
    case "show":
      return cmdShow(argv.slice(1));
    case "run":
      return cmdRun(argv.slice(1));
    case "":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return sub === "" ? 1 : 0;
    default:
      process.stderr.write(`${BIN_NAME} workflow: unknown subcommand '${sub}'\n`);
      process.stderr.write(HELP);
      return 1;
  }
}

/** Public entry for the top-level `chi run <name>` alias. */
export async function runAlias(argv: string[]): Promise<number> {
  return cmdRun(argv);
}

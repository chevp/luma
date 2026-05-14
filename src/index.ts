import { loadPersistedConfig } from "./config.js";
import { BIN_NAME } from "./identity.js";
import * as helpCmd from "./commands/help.js";
import * as statusCmd from "./commands/status.js";
import * as commitCmd from "./commands/commit.js";
import * as shipCmd from "./commands/ship.js";
import * as flowCmd from "./commands/flow.js";
import * as doneCmd from "./commands/done.js";
import * as issueCmd from "./commands/issue.js";
import * as explainCmd from "./commands/explain.js";
import * as initCmd from "./commands/init.js";
import * as updateCmd from "./commands/update.js";
import * as configCmd from "./commands/config.js";
import * as doctorCmd from "./commands/doctor.js";
import * as workflowCmd from "./commands/workflow.js";
import * as workCmd from "./commands/work.js";
import * as releaseCmd from "./commands/release.js";
import * as consultCmd from "./commands/consult.js";
import * as planCmd from "./commands/plan.js";
import * as serveCmd from "./commands/serve.js";
import { resolveTrigger } from "./workflow/loader.js";

type CommandRunner = (argv: string[]) => Promise<number>;

const COMMANDS: Record<string, CommandRunner> = {
  status: statusCmd.run,
  commit: commitCmd.run,
  ship: shipCmd.run,
  flow: flowCmd.run,
  done: doneCmd.run,
  issue: issueCmd.run,
  explain: explainCmd.run,
  init: initCmd.run,
  update: updateCmd.run,
  config: configCmd.run,
  doctor: doctorCmd.run,
  workflow: workflowCmd.run,
  run: workflowCmd.runAlias,
  work: workCmd.run,
  release: releaseCmd.run,
  consult: consultCmd.run,
  plan: planCmd.run,
  serve: serveCmd.run,

  help: helpCmd.run,
  "-h": helpCmd.run,
  "--help": helpCmd.run,
};

/**
 * Reserved commands skip the trigger lookup so workflows stay manageable even
 * if a user authors a `trigger: workflow` (footgun guard).
 */
const RESERVED_FOR_TRIGGER = new Set(["help", "-h", "--help", "workflow", "run"]);

async function main(): Promise<number> {
  loadPersistedConfig();

  const [, , cmd = "help", ...rest] = process.argv;

  // Workflow triggers shadow built-ins. A `.che/workflows/*.yml` declaring
  // `trigger: <cmd>` takes precedence over the dispatch table below.
  if (!RESERVED_FOR_TRIGGER.has(cmd)) {
    try {
      const lookup = resolveTrigger(cmd);
      if (lookup.kind === "match") {
        return await workflowCmd.runAlias([lookup.stem, ...rest]);
      }
      if (lookup.kind === "ambiguous") {
        process.stderr.write(`${BIN_NAME}: trigger '${cmd}' is declared by multiple workflows:\n`);
        for (const f of lookup.files) process.stderr.write(`  - ${f}\n`);
        return 2;
      }
    } catch {
      // Fall through to built-in dispatch on any loader hiccup.
    }
  }

  const runner = COMMANDS[cmd];
  if (!runner) {
    process.stderr.write(`${BIN_NAME}: unknown command '${cmd}'\n`);
    await helpCmd.run([]);
    return 1;
  }

  try {
    return await runner(rest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${BIN_NAME} ${cmd}: ${msg}\n`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${BIN_NAME}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);

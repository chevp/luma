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
import * as workCmd from "./commands/work.js";
import * as releaseCmd from "./commands/release.js";
import * as serveCmd from "./commands/serve.js";
import * as repoCmd from "./commands/repo.js";
import * as inspectCmd from "./commands/inspect.js";
import * as upCmd from "./commands/up.js";
import * as setupCmd from "./commands/setup.js";
import * as fixCmd from "./commands/fix.js";
import * as loginCmd from "./commands/login.js";
import * as secretsCmd from "./commands/secrets.js";
import { getCurrentVersion } from "./version-check.js";

type CommandRunner = (argv: string[]) => Promise<number>;

/** Print `<bin> <version>` (from package.json), or `(unknown)` if unresolved. */
async function printVersion(): Promise<number> {
  process.stdout.write(`${BIN_NAME} ${getCurrentVersion() ?? "(unknown)"}\n`);
  return 0;
}

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
  work: workCmd.run,
  release: releaseCmd.run,
  serve: serveCmd.run,
  repo: repoCmd.run,
  inspect: inspectCmd.run,
  up: upCmd.run,
  down: upCmd.down,
  setup: setupCmd.run,
  fix: fixCmd.run,
  login: loginCmd.run,
  secrets: secretsCmd.run,

  help: helpCmd.run,
  "-h": helpCmd.run,
  "--help": helpCmd.run,
  version: printVersion,
  "-v": printVersion,
  "--version": printVersion,
};

async function main(): Promise<number> {
  loadPersistedConfig();

  const [, , cmd = "help", ...rest] = process.argv;

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

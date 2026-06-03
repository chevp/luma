import { join } from "node:path";
import { existsSync } from "node:fs";
import { commandExists, execInherit } from "../spawn.js";
import { c, sym } from "../ui.js";
import { BIN_NAME } from "../identity.js";
import { discoverRepos, repoLabel } from "../workspace.js";
import { DRY_ENV, isDry, dryNote } from "../dry.js";

/**
 * Workspace-root mode: discover repos under cwd and ship each.
 *
 * Before iterating, attempts to clone any repos listed in repo-map.json
 * via chevp-setup's clone-all.py (if both python and the script are
 * available). Failures in individual repos do not abort the rest.
 *
 * `selfBin` is the path used to re-invoke ship in each repo (process.argv[1]
 * from the entrypoint).
 */
export async function globalShip(argv: string[], selfBin: string): Promise<number> {
  const cwd = process.cwd();
  const cwdFwd = cwd.replace(/\\/g, "/");
  const skipClone = argv.includes("--no-clone");

  // ---- 1. Optionally sync the workspace via chevp-setup ------------------
  const cloneScript = join(cwd, "misc", "chevp-setup", "clone-all.py");
  if (!skipClone && existsSync(cloneScript)) {
    process.stdout.write(`${c.bold(c.magenta("== sync workspace =="))}\n`);
    process.stdout.write(`  ${sym.arrow} ${c.dim(cloneScript.replace(/\\/g, "/"))}\n`);
    if (isDry()) {
      dryNote(`would run ${c.cyan(cloneScript.replace(/\\/g, "/"))}`);
    } else {
      const py = commandExists("python")
        ? "python"
        : commandExists("python3")
          ? "python3"
          : "";
      if (!py) {
        process.stdout.write(
          `  ${c.yellow("python not on PATH — skipping clone-all (re-run with python installed to fetch missing repos)")}\n`,
        );
      } else {
        const rc = await execInherit(py, [cloneScript], { cwd });
        if (rc !== 0) {
          process.stdout.write(
            `  ${c.yellow(`clone-all exited ${rc} — continuing with locally available repos`)}\n`,
          );
        }
      }
    }
  } else if (!skipClone) {
    process.stdout.write(
      `  ${c.dim(`(no misc/chevp-setup/clone-all.py under ${cwdFwd} — skipping repo sync)`)}\n`,
    );
  }

  // ---- 2. Discover repos (after clone-all so newly cloned ones count) ----
  const repos = discoverRepos(cwd);
  if (repos.length === 0) {
    process.stderr.write(
      `${BIN_NAME} ship: no git repositories found under ${cwdFwd}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `\n${c.bold(c.magenta(`== ship ${repos.length} repos ==`))}\n`,
  );

  const failures: string[] = [];
  let shipped = 0;
  for (const info of repos) {
    const label = repoLabel(info);
    process.stdout.write(`\n${c.bold(c.cyan(`── ${label} ──`))}\n`);
    const rc = await execInherit(process.execPath, [selfBin, "ship"], {
      cwd: info.path,
      env: {
        ...process.env,
        __CHI_NESTED: "1",
        ...(isDry() ? { [DRY_ENV]: "1" } : {}),
      },
    });
    if (rc !== 0) {
      failures.push(label);
    } else {
      shipped++;
    }
  }

  process.stdout.write(`\n${c.bold(c.magenta("== summary =="))}\n`);
  const okPart = `${sym.ok} ${c.green(`${shipped}/${repos.length} ok`)}`;
  if (failures.length > 0) {
    process.stdout.write(
      `  ${okPart}${c.dim(",")}  ${sym.err} ${c.red(`${failures.length} failed`)}\n`,
    );
    for (const f of failures) {
      process.stdout.write(`    ${c.red("✗")} ${f}\n`);
    }
    return 1;
  }
  process.stdout.write(`  ${okPart}\n\n`);
  return 0;
}

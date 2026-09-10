import { existsSync } from "node:fs";
import { c } from "../ui.js";
import { CHI_OS } from "../platform.js";
import {
  activeProviderName,
  getProvider,
  providerEnsureRunning,
} from "../provider/index.js";
import { commandExists, execSync } from "../spawn.js";
import { ollamaProvider, isEmbedModel } from "../provider/ollama.js";
import { claudeProvider } from "../provider/claude.js";
import { BIN_NAME } from "../identity.js";
import { ok, fail, warn, info, runSection } from "../installers/report.js";
import { INSTALLERS } from "../installers/registry.js";
import { loadToolchainConfig, toolchainConfigPath } from "../toolchain.js";
import { resolveWorkspaceRoot } from "../workspace.js";

const TOOLCHAIN_TARGETS = ["cmake", "vulkan", "java", "android", "blender", "node", "vscode"] as const;

const HELP = `${BIN_NAME} doctor — verify dependencies and external services.

Usage: ${BIN_NAME} doctor [target]

Targets:
  all          run all checks (default)
  git          git installation
  ollama       local ollama endpoint reachability + available models
  claude       GitHub Copilot auth + Claude model reachability (see '${BIN_NAME} login claude')
  workflow     prerequisites for ${BIN_NAME} workflow / ${BIN_NAME} run (none — built-in)
  provider     summary of the active provider (ollama or claude)
  cmake, vulkan, java, android, blender, node, vscode
               individual toolchain checks (see .luma/toolchain.yml, ${BIN_NAME} setup)
`;

function formatProviderSummary(): string {
  const name = activeProviderName();
  const model = getProvider().activeModel();
  const modelLabel = isEmbedModel(model) ? c.red(model) : c.green(model);
  return `${c.bold("active provider:")} ${c.cyan(name)} ${c.dim("(model:")} ${modelLabel}${c.dim(")")}`;
}

function gitInstallHint(): void {
  switch (CHI_OS) {
    case "darwin":
      info("install: brew install git");
      break;
    case "windows":
      info("install: https://git-scm.com/download/win");
      break;
    case "wsl":
    case "linux":
      info("install: sudo apt-get install git  (or your distro equivalent)");
      break;
    default:
      info("install: https://git-scm.com/downloads");
  }
}

function ghInstallHint(): void {
  switch (CHI_OS) {
    case "darwin":
      info("install: brew install gh");
      break;
    case "windows":
      info("install: winget install --id GitHub.cli");
      break;
    case "wsl":
    case "linux":
      info("install: see https://github.com/cli/cli/blob/trunk/docs/install_linux.md");
      break;
    default:
      info("install: https://cli.github.com/");
  }
  info("docs:    https://cli.github.com/manual/");
}

async function gitCheck(): Promise<boolean> {
  let okAll = true;
  const gitResult = await INSTALLERS.git!.check(true);
  if (gitResult.installed) {
    ok(gitResult.detail);
  } else {
    fail(gitResult.detail);
    gitInstallHint();
    okAll = false;
  }
  if (commandExists("gh")) {
    const ver =
      execSync("gh", ["--version"]).stdout.split(/\r?\n/)[0]?.split(/\s+/)[2] ?? "?";
    ok(`gh ${ver}  (required for chi flow / chi done)`);
    if (execSync("gh", ["auth", "status"]).ok) {
      ok("gh authenticated");
    } else {
      fail("gh not authenticated");
      info("run: gh auth login");
      okAll = false;
    }
  } else {
    fail("gh not installed  (required for chi flow / chi done)");
    ghInstallHint();
    okAll = false;
  }
  return okAll;
}

async function ollamaCheck(): Promise<boolean> {
  const url = process.env.CHI_OLLAMA_URL ?? "http://localhost:11434";
  const reachable = await ollamaProvider.ping();
  if (!reachable) {
    // ping() also returns false when only embedding models are installed.
    // Probe directly so we can tell the user *which* failure they hit.
    if (await ollamaProvider.hasModel()) {
      fail("only embedding models available — they cannot generate text");
      info("pull a generation model: ollama pull llama3.2");
      info("or pin one explicitly: export CHI_OLLAMA_MODEL=<model>");
      return false;
    }
    fail(`endpoint not reachable at ${url}`);
    info("start ollama with: ollama serve");
    info("or set CHI_OLLAMA_URL to point at a remote ollama");
    return false;
  }
  ok(`endpoint responding at ${url}`);
  const model = ollamaProvider.activeModel();
  if (model && model !== "(detecting)") {
    const pinned = process.env.CHI_OLLAMA_MODEL?.trim();
    const sourceLabel = pinned ? "from CHI_OLLAMA_MODEL" : "auto-selected (skips embedding models)";
    ok(`model selected: ${c.cyan(model)}  ${c.dim(`(${sourceLabel})`)}`);
  } else {
    fail("no models available — pull one with: ollama pull <model>");
    return false;
  }
  return true;
}

async function claudeCheck(): Promise<boolean> {
  const hasToken = Boolean(process.env.CHI_GITHUB_COPILOT_TOKEN?.trim());
  if (!hasToken) {
    info(`not configured — run: ${BIN_NAME} login claude`);
    return true; // optional backend — absence is not a failure
  }
  if (!(await claudeProvider.ping())) {
    fail("authenticated, but no Claude model reachable via GitHub Copilot");
    info("check your Copilot subscription/model access, or re-run: " + `${BIN_NAME} login claude`);
    return false;
  }
  ok(`reachable — model: ${c.cyan(claudeProvider.activeModel())}`);
  return true;
}

function workflowCheck(): boolean {
  ok("workflow loader (built-in YAML parser, no extra deps)");
  return true;
}

async function toolchainCheck(id: string): Promise<boolean> {
  const installer = INSTALLERS[id];
  if (!installer) return false;
  const result = await installer.check(true);
  if (result.installed) {
    ok(result.detail);
  } else {
    fail(result.detail);
    for (const line of installer.hint(CHI_OS)) info(line);
  }
  return result.installed;
}

/** Manifest-driven drift check for `doctor all` — optional, silent if no manifest exists. */
async function toolchainManifestSection(): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot().root;
  if (!existsSync(toolchainConfigPath(workspaceRoot))) return;

  let config;
  try {
    config = loadToolchainConfig();
  } catch (err) {
    await runSection("toolchain manifest", () => {
      fail(err instanceof Error ? err.message : String(err));
      return false;
    });
    return;
  }

  await runSection(`toolchain (${config.configPath})`, async () => {
    let allOk = true;
    for (const entry of config.entries) {
      const installer = INSTALLERS[entry.id];
      if (!installer) {
        warn(`'${entry.id}' has no installer module yet`);
        continue;
      }
      const result = await installer.check(entry.desired);
      if (!result.installed) {
        fail(result.detail);
        allOk = false;
      } else if (!result.satisfies) {
        warn(`${result.detail} (manifest wants ${entry.desired === true ? "latest" : entry.desired})`);
      } else {
        ok(result.detail);
      }
    }
    return allOk;
  });
}

export async function run(argv: string[]): Promise<number> {
  const target = argv[0] ?? "all";
  switch (target) {
    case "git":
      await runSection("git", gitCheck);
      return 0;
    case "ollama":
      await runSection("ollama", ollamaCheck);
      return 0;
    case "claude":
      await runSection("claude", claudeCheck);
      return 0;
    case "cmake":
    case "vulkan":
    case "java":
    case "android":
    case "blender":
    case "node":
    case "vscode":
      await runSection(target, () => toolchainCheck(target));
      return 0;
    case "provider": {
      await providerEnsureRunning().catch(() => false);
      const model = getProvider().activeModel();
      process.stdout.write(`${formatProviderSummary()}\n`);
      if (isEmbedModel(model)) {
        warn(
          `'${model}' is an embedding model — /api/generate will return HTTP 400`,
        );
        info("pull a generation model: ollama pull llama3.2");
        info("or pin one explicitly: export CHI_OLLAMA_MODEL=<model>");
      }
      return 0;
    }
    case "workflow":
      await runSection("workflow", workflowCheck);
      return 0;
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return 0;
    case "all":
    case "":
    case undefined: {
      process.stdout.write(`${c.bold("platform:")} ${c.cyan(CHI_OS)}\n`);
      await providerEnsureRunning().catch(() => false);
      const model = getProvider().activeModel();
      process.stdout.write(`${formatProviderSummary()}\n`);
      if (isEmbedModel(model)) {
        warn(
          `'${model}' is an embedding model — /api/generate will return HTTP 400`,
        );
        info("pull a generation model: ollama pull llama3.2");
        info("or pin one explicitly: export CHI_OLLAMA_MODEL=<model>");
      }
      process.stdout.write("\n");
      await runSection("git", gitCheck);
      await runSection("ollama", ollamaCheck);
      await runSection("claude", claudeCheck);
      await runSection("workflow", workflowCheck);
      process.stdout.write(`${c.bold("shell deps:")}\n`);
      for (const bin of ["curl", "bash"]) {
        if (commandExists(bin)) ok(bin);
        else fail(`${bin} missing`);
      }
      await toolchainManifestSection();
      return 0;
    }
    default:
      process.stderr.write(`${BIN_NAME} doctor: unknown target '${target}'\n`);
      process.stderr.write(`valid: all, git, ollama, claude, workflow, provider, ${TOOLCHAIN_TARGETS.join(", ")}\n`);
      return 1;
  }
}

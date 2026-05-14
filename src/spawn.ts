import {
  spawn,
  spawnSync,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type StdioOptions,
} from "node:child_process";
import { isAbsolute } from "node:path";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

// Node's child_process.spawn on Windows does not consult PATHEXT, so a bare
// command name like "claude" only matches claude.exe — never claude.cmd /
// claude.bat. Resolve via `where` once per binary and pass the absolute path
// to spawn. Additionally, Node 18+ refuses to spawn .cmd/.bat without
// shell:true (CVE-2024-27980), so for those we route through cmd.exe with
// pre-quoted args. macOS/Linux are unaffected.
const winBinaryCache = new Map<string, string>();

function resolveBinary(cmd: string): string {
  if (process.platform !== "win32") return cmd;
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) return cmd;
  const cached = winBinaryCache.get(cmd);
  if (cached !== undefined) return cached;
  const r = spawnSync("where", [cmd], { encoding: "utf8", windowsHide: true });
  let resolved = cmd;
  if (r.status === 0) {
    const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    // Prefer entries with a Windows-executable extension. npm installs e.g.
    // "claude" (bash shim, no extension) alongside "claude.cmd" in the same
    // directory; `where` lists the bare-name shim first, but Node's spawn
    // can only run the .cmd/.exe variant.
    const exe = lines.find((p) => /\.(exe|cmd|bat|com)$/i.test(p));
    resolved = exe ?? lines[0] ?? cmd;
  }
  winBinaryCache.set(cmd, resolved);
  return resolved;
}

function quoteForCmd(s: string): string {
  if (s.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(s)) return s;
  // cmd.exe parsing: wrap in "..." and double any embedded double-quotes.
  return `"${s.replace(/"/g, '""')}"`;
}

interface AdaptedSpawn {
  cmd: string;
  args: string[];
  shell: boolean;
}

function adaptSpawn(cmd: string, args: string[]): AdaptedSpawn {
  if (process.platform !== "win32") return { cmd, args, shell: false };
  const resolved = resolveBinary(cmd);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    // shell:true on Windows runs `cmd.exe /d /s /c <joined-string>` and does
    // NOT escape args — it just joins them with spaces. So we pre-quote.
    const joined = [resolved, ...args].map(quoteForCmd).join(" ");
    return { cmd: joined, args: [], shell: true };
  }
  return { cmd: resolved, args, shell: false };
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** When true, capture stderr separately. When false, merge into stdout. */
  separateStderr?: boolean;
}

export function execSync(cmd: string, args: string[], opts: ExecOptions = {}): ExecResult {
  const a = adaptSpawn(cmd, args);
  const o: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    timeout: opts.timeoutMs,
    windowsHide: true,
    shell: a.shell,
  };
  const r = spawnSync(a.cmd, a.args, o);
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
    status: r.status,
  };
}

export interface ExecAsyncOptions extends ExecOptions {
  /** Inherit stdio (interactive). */
  inherit?: boolean;
}

/**
 * Async spawn with optional stdin input. Resolves with captured stdout/stderr
 * unless `inherit` is true, in which case both streams pipe to the parent.
 */
export function execAsync(
  cmd: string,
  args: string[],
  opts: ExecAsyncOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const stdio: StdioOptions = opts.inherit
      ? "inherit"
      : ["pipe", "pipe", "pipe"];
    const a = adaptSpawn(cmd, args);
    const o: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio,
      shell: a.shell,
    };
    const child = spawn(a.cmd, a.args, o);

    let stdout = "";
    let stderr = "";
    if (!opts.inherit) {
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      if (opts.input !== undefined) {
        child.stdin?.write(opts.input);
        child.stdin?.end();
      } else {
        child.stdin?.end();
      }
    }

    // Some children (e.g. `docker info` blocked on a stuck daemon socket)
    // ignore SIGTERM, so escalate to SIGKILL after a short grace period.
    let timer: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        killer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 500);
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolve({ ok: false, stdout, stderr: stderr || String(err), status: null });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolve({ ok: code === 0, stdout, stderr, status: code });
    });
  });
}

/** True if the named binary is on PATH. */
export function commandExists(bin: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [bin], { stdio: "ignore", windowsHide: true });
  return r.status === 0;
}

/** Inherit-stdio spawn that resolves with the exit code. Used when chi
 *  shells out to interactive tools (git commit -e, $EDITOR). */
export function execInherit(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const a = adaptSpawn(cmd, args);
    const child = spawn(a.cmd, a.args, {
      stdio: "inherit",
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      shell: a.shell,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

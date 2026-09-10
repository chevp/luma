import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BIN_NAME } from "../identity.js";

const STATIC_EXT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const TOOLS = new Set(["status", "doctor", "help", "config"]);

const OLLAMA_DEFAULT_URL = "http://localhost:11434";

type ProviderName = "ollama";

interface ModelEntry {
  id: string;
  provider: ProviderName;
  name: string;
}

const EMBED_RE = /(?:^|[-/_:])embed(?:ding)?(?:[-_/:]|$)/i;

interface Args {
  host: string;
  port: number;
  open: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { host: "127.0.0.1", port: 7777, open: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--no-open") args.open = false;
    else if (a === "--host") args.host = argv[++i] ?? args.host;
    else if (a === "--port" || a === "-p") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) args.port = n;
    }
  }
  return args;
}

function helpText(): string {
  return `${BIN_NAME} serve — start a local web console (chat UI over local ollama)

Usage: ${BIN_NAME} serve [--port <n>] [--host <h>] [--no-open]

Options:
  --port, -p <n>    port to listen on (default 7777)
  --host <h>        bind address (default 127.0.0.1)
  --no-open         do not open a browser
  --help, -h        show this message

Environment:
  CHI_OLLAMA_URL    ollama base URL (default http://localhost:11434)
  CHI_OLLAMA_MODEL  pin a default ollama model (optional)

Routes (same-origin):
  GET  /             → static console UI
  GET  /api/health   → { providers: { ollama }, default }
  GET  /api/models   → { models: ModelEntry[], active: string }
  POST /api/chat     → NDJSON stream from local ollama
                      body: { model: "ollama/<name>", messages, stream }
  POST /api/run      → run a chi tool (status | doctor | help | config)
`;
}

/** Resolve the static-assets directory, regardless of where chi runs from. */
function staticRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fallback = resolve(here, "..", "..", "context", "prototypes", "ux-console-v3");
  const candidates = [
    fallback,
    resolve(here, "..", "..", "..", "context", "prototypes", "ux-console-v3"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return fallback;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const MAX = 2 * 1024 * 1024;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX) {
        rejectBody(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function ollamaUrlBase(): string {
  return (process.env.CHI_OLLAMA_URL ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 4000, ...rest } = init;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function listOllamaModels(): Promise<string[]> {
  try {
    const r = await fetchWithTimeout(`${ollamaUrlBase()}/api/tags`, { timeoutMs: 1500 });
    if (!r.ok) return [];
    const data = (await r.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m.name ?? "")
      .filter((n) => n.length > 0 && !EMBED_RE.test(n))
      .sort();
  } catch {
    return [];
  }
}

function parseModelId(id: string): { provider: ProviderName; name: string } | null {
  const slash = id.indexOf("/");
  if (slash < 0) return null;
  const provider = id.slice(0, slash);
  const name = id.slice(slash + 1);
  if (provider !== "ollama" || !name) return null;
  return { provider, name };
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ollamaModels = await listOllamaModels();
  const ollamaOk = ollamaModels.length > 0;
  sendJson(res, 200, {
    ok: ollamaOk,
    default: "ollama" as ProviderName,
    providers: {
      ollama: { ok: ollamaOk, url: ollamaUrlBase(), models: ollamaModels.length },
    },
  });
}

async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ollamaModels = await listOllamaModels();
  const models: ModelEntry[] = ollamaModels.map<ModelEntry>((name) => ({
    id: `ollama/${name}`,
    provider: "ollama",
    name,
  }));

  let active: string | null = null;
  if (ollamaModels.length > 0) {
    const pinned = process.env.CHI_OLLAMA_MODEL?.trim();
    const match = pinned && ollamaModels.find((n) => n === pinned || n.startsWith(`${pinned}:`));
    active = `ollama/${match ?? ollamaModels[0]}`;
  }

  sendJson(res, 200, { models, active });
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    stream?: boolean;
    provider?: ProviderName;
  };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const stream = payload.stream !== false;

  let modelName: string;
  const parsed = payload.model ? parseModelId(payload.model) : null;
  if (parsed) {
    modelName = parsed.name;
  } else {
    modelName = payload.model ?? "";
  }
  if (!modelName) {
    sendJson(res, 400, { error: "missing model name" });
    return;
  }

  const provider: ProviderName = "ollama";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const url = `${ollamaUrlBase()}/api/chat`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: modelName, messages, stream }),
    });
  } catch (e) {
    sendJson(res, 502, {
      error: `${provider} unreachable: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    sendJson(res, upstream.status, {
      error: `${provider} HTTP ${upstream.status}`,
      detail: text.slice(0, 500),
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": stream ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  req.on("close", () => {
    reader.cancel().catch(() => {});
  });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch {
    /* client disconnected */
  } finally {
    res.end();
  }
}

const runLock = { busy: false };

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: { name?: string; args?: string[] };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const name = (payload.name ?? "").trim();
  if (!TOOLS.has(name)) {
    sendJson(res, 400, { error: `tool not allowed: ${name}` });
    return;
  }
  if (runLock.busy) {
    sendJson(res, 429, { error: "another tool is running" });
    return;
  }
  runLock.busy = true;

  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawn(process.execPath, [entry, name, ...(payload.args ?? [])], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
  child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
  child.on("close", (code) => {
    runLock.busy = false;
    sendJson(res, 200, { stdout, stderr, code: code ?? 0 });
  });
  child.on("error", (e) => {
    runLock.busy = false;
    sendJson(res, 500, { error: e.message });
  });
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const url = req.url ?? "/";
  let pathname = decodeURIComponent(url.split("?")[0] ?? "/");
  if (pathname === "/") pathname = "/index.html";

  // Reject URI-encoded traversal or absolute paths up front.
  if (pathname.includes("\0") || pathname.includes("..") || !pathname.startsWith("/")) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }

  const dot = pathname.lastIndexOf(".");
  const ext = dot >= 0 ? pathname.slice(dot).toLowerCase() : "";
  const contentType = STATIC_EXT_TYPES[ext];
  if (!contentType) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  const rootResolved = resolve(root);
  const target = normalize(join(rootResolved, pathname));
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`missing static asset: ${pathname.replace(/^\//, "")}`);
  }
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" :
    "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best effort */
  }
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(helpText());
    return 0;
  }

  const root = staticRoot();
  if (!existsSync(join(root, "index.html"))) {
    process.stderr.write(
      `${BIN_NAME} serve: static assets not found at ${root}\n` +
        "Reinstall chi or check that context/prototypes/ux-console-v3/ ships in the package.\n",
    );
    return 1;
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && url === "/api/health") return await handleHealth(req, res);
      if (method === "GET" && url === "/api/models") return await handleModels(req, res);
      if (method === "POST" && url === "/api/chat") return await handleChat(req, res);
      if (method === "POST" && url === "/api/run") return await handleRun(req, res);
      if (method === "GET") return await handleStatic(req, res, root);
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(msg);
      } else {
        res.end();
      }
    }
  });

  return await new Promise<number>((resolveExit) => {
    server.on("error", (err) => {
      process.stderr.write(`${BIN_NAME} serve: ${err.message}\n`);
      resolveExit(1);
    });
    server.listen(args.port, args.host, () => {
      const url = `http://${args.host}:${args.port}/`;
      process.stdout.write(`${BIN_NAME} console → ${url}\n`);
      process.stdout.write("press Ctrl+C to stop\n");
      if (args.open) openInBrowser(url);
    });

    const stop = (signal: NodeJS.Signals) => {
      process.stdout.write(`\n${BIN_NAME} serve: ${signal} received, shutting down\n`);
      server.close(() => resolveExit(0));
      setTimeout(() => resolveExit(0), 1500).unref();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
}

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BIN_NAME } from "../identity.js";
const STATIC_EXT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".map": "application/json; charset=utf-8",
};
const TOOLS = new Set(["status", "doctor", "help", "config"]);
const OLLAMA_DEFAULT_URL = "http://localhost:11434";
const EMBED_RE = /(?:^|[-/_:])embed(?:ding)?(?:[-_/:]|$)/i;
function parseArgs(argv) {
    const args = { host: "127.0.0.1", port: 7777, open: true, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--help" || a === "-h")
            args.help = true;
        else if (a === "--no-open")
            args.open = false;
        else if (a === "--host")
            args.host = argv[++i] ?? args.host;
        else if (a === "--port" || a === "-p") {
            const n = Number.parseInt(argv[++i] ?? "", 10);
            if (Number.isFinite(n) && n > 0)
                args.port = n;
        }
    }
    return args;
}
function helpText() {
    return `${BIN_NAME} serve — start a local web console (chat UI over local ollama; remote cura is opt-in)

Usage: ${BIN_NAME} serve [--port <n>] [--host <h>] [--no-open]

Options:
  --port, -p <n>    port to listen on (default 7777)
  --host <h>        bind address (default 127.0.0.1)
  --no-open         do not open a browser
  --help, -h        show this message

Environment:
  CHI_OLLAMA_URL    ollama base URL (default http://localhost:11434)
  CHI_OLLAMA_MODEL  pin a default ollama model (optional)
  CHI_LLM_URL       remote provider base URL — set to enable cura
  CHI_LLM_MODEL     pin a default remote model (optional)
  BASIC_AUTH_USER   basic-auth user for the remote provider
  BASIC_AUTH_PASSWORD  basic-auth password for the remote provider

Routes (same-origin):
  GET  /             → static console UI
  GET  /api/health   → { providers: { ollama, cura }, default }
  GET  /api/models   → { models: ModelEntry[], active: string }
  POST /api/chat     → NDJSON stream from the chosen backend
                      body: { model: "ollama/<name>" | "cura/<name>", messages, stream }
  POST /api/run      → run a chi tool (status | doctor | help | config)
`;
}
/** Resolve the static-assets directory, regardless of where chi runs from. */
function staticRoot() {
    const here = dirname(fileURLToPath(import.meta.url));
    const fallback = resolve(here, "..", "..", "context", "prototypes", "ux-console-v3");
    const candidates = [
        fallback,
        resolve(here, "..", "..", "..", "context", "prototypes", "ux-console-v3"),
    ];
    for (const c of candidates) {
        if (existsSync(join(c, "index.html")))
            return c;
    }
    return fallback;
}
function readBody(req) {
    return new Promise((resolveBody, rejectBody) => {
        const chunks = [];
        let bytes = 0;
        const MAX = 2 * 1024 * 1024;
        req.on("data", (chunk) => {
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
function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}
// Cura is an opt-in remote provider — there is no built-in default URL or
// model. Setting CHI_LLM_URL (and BASIC_AUTH_USER/PASSWORD) activates it.
function curaUrlBase() {
    const raw = process.env.CHI_LLM_URL?.trim();
    if (!raw)
        return null;
    return raw.replace(/\/+$/, "");
}
function curaModel() {
    return process.env.CHI_LLM_MODEL?.trim() ?? "";
}
function ollamaUrlBase() {
    return (process.env.CHI_OLLAMA_URL ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
}
function basicAuthHeader() {
    const user = process.env.BASIC_AUTH_USER;
    const password = process.env.BASIC_AUTH_PASSWORD;
    if (!user || !password)
        return null;
    return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}
async function fetchWithTimeout(url, init = {}) {
    const { timeoutMs = 4000, ...rest } = init;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        return await fetch(url, { ...rest, signal: ac.signal });
    }
    finally {
        clearTimeout(t);
    }
}
async function listOllamaModels() {
    try {
        const r = await fetchWithTimeout(`${ollamaUrlBase()}/api/tags`, { timeoutMs: 1500 });
        if (!r.ok)
            return [];
        const data = (await r.json());
        return (data.models ?? [])
            .map((m) => m.name ?? "")
            .filter((n) => n.length > 0 && !EMBED_RE.test(n))
            .sort();
    }
    catch {
        return [];
    }
}
async function listCuraModels() {
    const url = curaUrlBase();
    const auth = basicAuthHeader();
    if (!url || !auth)
        return [];
    try {
        const r = await fetchWithTimeout(`${url}/api/tags`, {
            headers: { Authorization: auth },
            timeoutMs: 5000,
        });
        if (!r.ok)
            return [];
        const data = (await r.json());
        return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean).sort();
    }
    catch {
        return [];
    }
}
function parseModelId(id) {
    const slash = id.indexOf("/");
    if (slash < 0)
        return null;
    const provider = id.slice(0, slash);
    const name = id.slice(slash + 1);
    if ((provider !== "ollama" && provider !== "cura") || !name)
        return null;
    return { provider, name };
}
async function handleHealth(_req, res) {
    const [ollamaModels, curaModels] = await Promise.all([listOllamaModels(), listCuraModels()]);
    const ollamaOk = ollamaModels.length > 0;
    const curaOk = curaModels.length > 0;
    const def = curaOk && !ollamaOk ? "cura" : "ollama";
    sendJson(res, 200, {
        ok: ollamaOk || curaOk,
        default: def,
        providers: {
            ollama: { ok: ollamaOk, url: ollamaUrlBase(), models: ollamaModels.length },
            cura: {
                ok: curaOk,
                url: curaUrlBase() ?? null,
                configured: curaUrlBase() !== null,
                models: curaModels.length,
                auth: basicAuthHeader() !== null,
            },
        },
    });
}
async function handleModels(_req, res) {
    const [ollamaModels, curaModels] = await Promise.all([listOllamaModels(), listCuraModels()]);
    const models = [
        ...ollamaModels.map((name) => ({ id: `ollama/${name}`, provider: "ollama", name })),
        ...curaModels.map((name) => ({ id: `cura/${name}`, provider: "cura", name })),
    ];
    let active = null;
    if (ollamaModels.length > 0) {
        const pinned = process.env.CHI_OLLAMA_MODEL?.trim();
        const match = pinned && ollamaModels.find((n) => n === pinned || n.startsWith(`${pinned}:`));
        active = `ollama/${match ?? ollamaModels[0]}`;
    }
    else if (curaModels.length > 0) {
        const want = curaModel();
        const match = curaModels.find((n) => n === want || n.startsWith(`${want}:`)) ?? curaModels[0];
        active = `cura/${match}`;
    }
    sendJson(res, 200, { models, active });
}
async function handleChat(req, res) {
    let payload;
    try {
        payload = JSON.parse(await readBody(req));
    }
    catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const stream = payload.stream !== false;
    let provider;
    let modelName;
    const parsed = payload.model ? parseModelId(payload.model) : null;
    if (parsed) {
        provider = parsed.provider;
        modelName = parsed.name;
    }
    else if (payload.provider === "ollama" || payload.provider === "cura") {
        provider = payload.provider;
        modelName = payload.model ?? "";
    }
    else {
        provider = "ollama";
        modelName = payload.model ?? "";
    }
    if (!modelName) {
        sendJson(res, 400, { error: "missing model name" });
        return;
    }
    let url;
    const headers = { "Content-Type": "application/json" };
    if (provider === "cura") {
        const base = curaUrlBase();
        if (!base) {
            sendJson(res, 412, {
                error: "CHI_LLM_URL not set — cura provider is opt-in; export CHI_LLM_URL to enable it",
            });
            return;
        }
        const auth = basicAuthHeader();
        if (!auth) {
            sendJson(res, 412, {
                error: "BASIC_AUTH_USER / BASIC_AUTH_PASSWORD not set — run `chi init` first",
            });
            return;
        }
        headers["Authorization"] = auth;
        url = `${base}/api/chat`;
    }
    else {
        url = `${ollamaUrlBase()}/api/chat`;
    }
    let upstream;
    try {
        upstream = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: modelName, messages, stream }),
        });
    }
    catch (e) {
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
        reader.cancel().catch(() => { });
    });
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            if (value)
                res.write(Buffer.from(value));
        }
    }
    catch {
        /* client disconnected */
    }
    finally {
        res.end();
    }
}
const runLock = { busy: false };
async function handleRun(req, res) {
    let payload;
    try {
        payload = JSON.parse(await readBody(req));
    }
    catch {
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
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("close", (code) => {
        runLock.busy = false;
        sendJson(res, 200, { stdout, stderr, code: code ?? 0 });
    });
    child.on("error", (e) => {
        runLock.busy = false;
        sendJson(res, 500, { error: e.message });
    });
}
async function handleStatic(req, res, root) {
    const url = req.url ?? "/";
    let pathname = decodeURIComponent(url.split("?")[0] ?? "/");
    if (pathname === "/")
        pathname = "/index.html";
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
    }
    catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`missing static asset: ${pathname.replace(/^\//, "")}`);
    }
}
function openInBrowser(url) {
    const cmd = process.platform === "darwin" ? "open" :
        process.platform === "win32" ? "cmd" :
            "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    }
    catch {
        /* best effort */
    }
}
export async function run(argv) {
    const args = parseArgs(argv);
    if (args.help) {
        process.stdout.write(helpText());
        return 0;
    }
    const root = staticRoot();
    if (!existsSync(join(root, "index.html"))) {
        process.stderr.write(`${BIN_NAME} serve: static assets not found at ${root}\n` +
            "Reinstall chi or check that context/prototypes/ux-console-v3/ ships in the package.\n");
        return 1;
    }
    const server = createServer(async (req, res) => {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";
        try {
            if (method === "GET" && url === "/api/health")
                return await handleHealth(req, res);
            if (method === "GET" && url === "/api/models")
                return await handleModels(req, res);
            if (method === "POST" && url === "/api/chat")
                return await handleChat(req, res);
            if (method === "POST" && url === "/api/run")
                return await handleRun(req, res);
            if (method === "GET")
                return await handleStatic(req, res, root);
            res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("method not allowed");
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(msg);
            }
            else {
                res.end();
            }
        }
    });
    return await new Promise((resolveExit) => {
        server.on("error", (err) => {
            process.stderr.write(`${BIN_NAME} serve: ${err.message}\n`);
            resolveExit(1);
        });
        server.listen(args.port, args.host, () => {
            const url = `http://${args.host}:${args.port}/`;
            process.stdout.write(`${BIN_NAME} console → ${url}\n`);
            process.stdout.write("press Ctrl+C to stop\n");
            if (args.open)
                openInBrowser(url);
        });
        const stop = (signal) => {
            process.stdout.write(`\n${BIN_NAME} serve: ${signal} received, shutting down\n`);
            server.close(() => resolveExit(0));
            setTimeout(() => resolveExit(0), 1500).unref();
        };
        process.once("SIGINT", () => stop("SIGINT"));
        process.once("SIGTERM", () => stop("SIGTERM"));
    });
}
//# sourceMappingURL=serve.js.map
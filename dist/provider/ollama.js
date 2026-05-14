const DEFAULT_URL = "http://localhost:11434";
const URL_BASE = () => (process.env.CHI_OLLAMA_URL ?? DEFAULT_URL).replace(/\/+$/, "");
// Embedding models (e.g. mxbai-embed-large, nomic-embed-text, all-minilm)
// reject /api/generate with HTTP 400. Skip them when auto-selecting so we
// don't strand commit/explain flows on a model that physically cannot
// generate text.
const EMBED_RE = /(?:^|[-/_:])embed(?:ding)?(?:[-_/:]|$)/i;
export function isEmbedModel(name) {
    return EMBED_RE.test(name);
}
function pickGenerateModel(models) {
    const usable = models.find((n) => !isEmbedModel(n));
    return usable ?? null;
}
let cachedModel = null;
async function fetchWithTimeout(url, init = {}) {
    const { timeoutMs = 1500, ...rest } = init;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        return await fetch(url, { ...rest, signal: ac.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function listModels(timeoutMs = 1500) {
    const r = await fetchWithTimeout(`${URL_BASE()}/api/tags`, { timeoutMs });
    if (!r.ok)
        return [];
    const data = (await r.json());
    return (data.models ?? []).map((m) => m.name ?? "").filter((n) => n.length > 0);
}
export const ollamaProvider = {
    name: "ollama",
    activeModel() {
        return cachedModel ?? "(detecting)";
    },
    async ping() {
        try {
            const models = await listModels();
            if (models.length === 0)
                return false;
            const pinned = process.env.CHI_OLLAMA_MODEL?.trim();
            if (pinned) {
                const match = models.find((n) => n === pinned || n.startsWith(`${pinned}:`));
                cachedModel = match ?? pinned;
            }
            else {
                cachedModel = pickGenerateModel(models);
            }
            // If only embedding models exist and the user hasn't pinned one,
            // refuse to claim "reachable" so detection falls back to cura.
            return cachedModel !== null;
        }
        catch {
            return false;
        }
    },
    async hasModel(model) {
        try {
            const models = await listModels();
            if (model === undefined)
                return models.length > 0;
            return models.some((n) => n.startsWith(model));
        }
        catch {
            return false;
        }
    },
    async generate(prompt) {
        if (!cachedModel) {
            const models = await listModels(5000);
            if (models.length === 0) {
                throw new Error("ollama: no models available at /api/tags");
            }
            const pinned = process.env.CHI_OLLAMA_MODEL?.trim();
            if (pinned) {
                const match = models.find((n) => n === pinned || n.startsWith(`${pinned}:`));
                cachedModel = match ?? pinned;
            }
            else {
                cachedModel = pickGenerateModel(models);
            }
            if (!cachedModel) {
                throw new Error("ollama: only embedding models are installed — pull a generation model (e.g. 'ollama pull llama3.2') or set CHI_OLLAMA_MODEL to override");
            }
        }
        const r = await fetch(`${URL_BASE()}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: cachedModel, prompt, stream: false }),
        });
        if (!r.ok) {
            const body = await r.text().catch(() => "");
            throw new Error(`ollama generate failed: HTTP ${r.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
        }
        const data = (await r.json());
        return data.response ?? "";
    },
};
//# sourceMappingURL=ollama.js.map
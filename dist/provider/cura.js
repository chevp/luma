import { BIN_NAME } from "../identity.js";
const DEFAULT_URL = "https://cura-llm-3j2fyuwcdq-oa.a.run.app";
const DEFAULT_MODEL = "smollm2:135m";
const URL_BASE = () => (process.env.CHI_LLM_URL ?? DEFAULT_URL).replace(/\/+$/, "");
const MODEL = () => process.env.CHI_LLM_MODEL ?? DEFAULT_MODEL;
function basicAuthHeader() {
    const user = process.env.BASIC_AUTH_USER;
    const password = process.env.BASIC_AUTH_PASSWORD;
    if (!user || !password) {
        throw new Error(`${BIN_NAME}: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set ` +
            "(cura-llm requires HTTP basic auth)");
    }
    return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}
async function fetchWithTimeout(url, init = {}) {
    const { timeoutMs = 5000, ...rest } = init;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        return await fetch(url, { ...rest, signal: ac.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Strip HTML markup and collapse whitespace so a 401 error page from a proxy
 * (Google IAP, nginx, etc.) doesn't dump raw <html> into the terminal.
 */
function sanitizeBody(body, max = 120) {
    const looksLikeHtml = /<\/?[a-z][^>]*>/i.test(body);
    let cleaned = looksLikeHtml
        ? body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")
        : body;
    cleaned = cleaned.replace(/\s+/g, " ").trim();
    return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
export const curaProvider = {
    name: "cura",
    activeModel() {
        return MODEL();
    },
    async ping() {
        try {
            const r = await fetchWithTimeout(`${URL_BASE()}/api/tags`, {
                timeoutMs: 5000,
                headers: { Authorization: basicAuthHeader() },
            });
            return r.ok;
        }
        catch {
            return false;
        }
    },
    async hasModel(model = MODEL()) {
        try {
            const r = await fetchWithTimeout(`${URL_BASE()}/api/tags`, {
                timeoutMs: 5000,
                headers: { Authorization: basicAuthHeader() },
            });
            if (!r.ok)
                return false;
            const data = (await r.json());
            const list = data.models ?? [];
            return list.some((m) => (m.name ?? "").startsWith(model));
        }
        catch {
            return false;
        }
    },
    async generate(prompt) {
        const payload = JSON.stringify({ model: MODEL(), prompt, stream: false });
        const r = await fetch(`${URL_BASE()}/api/generate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: basicAuthHeader(),
            },
            body: payload,
        });
        if (!r.ok) {
            const body = await r.text().catch(() => "");
            const detail = sanitizeBody(body);
            const hint = r.status === 401 || r.status === 403
                ? " (check BASIC_AUTH_USER / BASIC_AUTH_PASSWORD)"
                : "";
            throw new Error(`cura generate failed: HTTP ${r.status}${hint}${detail ? ` — ${detail}` : ""}`);
        }
        const data = (await r.json());
        return data.response ?? "";
    },
};
//# sourceMappingURL=cura.js.map
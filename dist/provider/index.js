import { ollamaProvider } from "./ollama.js";
import { claudeProvider } from "./claude.js";
class Semaphore {
    slots;
    waiters = [];
    constructor(n) {
        this.slots = n;
    }
    async acquire() {
        if (this.slots > 0) {
            this.slots -= 1;
            return;
        }
        await new Promise((resolve) => this.waiters.push(resolve));
    }
    release() {
        const w = this.waiters.shift();
        if (w)
            w();
        else
            this.slots += 1;
    }
}
let providerSem = null;
function providerSemaphore() {
    if (providerSem)
        return providerSem;
    const raw = process.env.CHI_PROVIDER_PARALLEL ?? "1";
    const n = Number.parseInt(raw, 10);
    const slots = Number.isFinite(n) && n > 0 ? n : 1;
    providerSem = new Semaphore(slots);
    return providerSem;
}
/**
 * luma picks a generation backend via CHI_PROVIDER (persisted as `provider`
 * in ~/.chi/config): "ollama" (default, local daemon) or "claude" (Claude
 * models via a GitHub Copilot subscription — see `luma login claude`).
 */
function resolveProviderName() {
    return process.env.CHI_PROVIDER?.trim().toLowerCase() === "claude" ? "claude" : "ollama";
}
function providerFor(name) {
    return name === "claude" ? claudeProvider : ollamaProvider;
}
export function activeProviderName() {
    return resolveProviderName();
}
export function getProvider(name) {
    return providerFor(name ?? resolveProviderName());
}
/** Pings the active provider; caches the selected model on success. */
export async function providerEnsureRunning() {
    return getProvider().ping();
}
export async function providerSmartGenerate(prompt, _opts = {}) {
    const sem = providerSemaphore();
    await sem.acquire();
    try {
        return await getProvider().generate(prompt);
    }
    finally {
        sem.release();
    }
}
//# sourceMappingURL=index.js.map
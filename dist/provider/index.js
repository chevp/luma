import { ollamaProvider } from "./ollama.js";
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
 * luma has a single generation backend: the local ollama daemon. These helpers
 * stay as thin wrappers so call sites don't hard-code the provider (and a
 * second backend could be reintroduced without touching every caller).
 */
export function activeProviderName() {
    return ollamaProvider.name;
}
export function getProvider(_name) {
    return ollamaProvider;
}
/** Pings the local ollama daemon; caches the selected model on success. */
export async function providerEnsureRunning() {
    return ollamaProvider.ping();
}
export async function providerSmartGenerate(prompt, _opts = {}) {
    const sem = providerSemaphore();
    await sem.acquire();
    try {
        return await ollamaProvider.generate(prompt);
    }
    finally {
        sem.release();
    }
}
//# sourceMappingURL=index.js.map
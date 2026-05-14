// chi · Console v3 — entry module. Imports register custom elements; the
// only top-level work is loading health + models so the UI can light up.

import { store } from "./lib/store.js";
import { apiHealth, apiModels, friendlyFetchError } from "./lib/api.js";
import "./components/chi-sidebar.js";
import "./components/chi-conversation.js";
import "./components/chi-workflow.js";

async function bootstrap() {
    store.setConnection("idle", "checking…");
    try {
        const health = await apiHealth();
        const ollamaOk = health.providers?.ollama?.ok;
        const curaOk = health.providers?.cura?.ok;
        if (ollamaOk && curaOk) store.setConnection("ok", "ollama + cura ready");
        else if (ollamaOk) store.setConnection("ok", "local ollama ready");
        else if (curaOk) store.setConnection("ok", "cura ready");
        else { store.setConnection("warn", "no provider reachable"); return; }
    } catch (e) {
        store.setConnection("err", "chi serve down");
        console.warn("apiHealth:", friendlyFetchError(e));
        return;
    }
    try {
        const data = await apiModels();
        store.setModels(data.models || [], data.active || "");
    } catch (e) {
        console.warn("apiModels:", friendlyFetchError(e));
        store.setModels([], "");
    }
}

document.addEventListener("DOMContentLoaded", bootstrap);

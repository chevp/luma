// Thin wrapper around the `chi serve` endpoints. Returns plain values;
// callers handle UI feedback.

const SERVE_HINT = "is `chi serve` running? start it with: chi serve";

export function friendlyFetchError(e) {
    const msg = e && e.message ? e.message : String(e);
    if (e && (e.name === "TypeError" || /failed to fetch|networkerror/i.test(msg))) {
        return `${msg} — ${SERVE_HINT}`;
    }
    return msg;
}

export async function apiHealth() {
    const r = await fetch("/api/health");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
}

export async function apiModels() {
    const r = await fetch("/api/models");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
}

export async function apiRun(name) {
    const r = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

// Streams chat as NDJSON. Invokes onDelta(fullSoFar) for each chunk, then
// resolves with { content, eval_count, latency_ms } on done.
export async function apiChatStream({ model, messages, signal, onDelta }) {
    const t0 = performance.now();
    const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: true }),
        signal,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let finalMeta = null;

    const eat = (line) => {
        if (!line) return;
        let chunk;
        try { chunk = JSON.parse(line); } catch { return; }
        const delta = chunk.message && chunk.message.content;
        if (delta) {
            full += delta;
            if (onDelta) onDelta(full);
        }
        if (chunk.done) finalMeta = chunk;
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
            eat(buf.slice(0, idx).trim());
            buf = buf.slice(idx + 1);
        }
    }
    if (buf.trim()) eat(buf.trim());

    return {
        content: full,
        eval_count: (finalMeta && finalMeta.eval_count) || 0,
        latency_ms: (performance.now() - t0).toFixed(0),
    };
}

/**
 * Bounded async pool: keep `concurrency` workers in flight until `items` is
 * drained. Preserves input order in the returned array. A worker rejection
 * propagates as a rejected promise; siblings continue. Call sites that need
 * settled-style aggregation should wrap the worker themselves.
 */
export async function pool(items, worker, concurrency) {
    const n = items.length;
    const out = new Array(n);
    let next = 0;
    const advance = async () => {
        while (true) {
            const i = next++;
            if (i >= n)
                return;
            out[i] = await worker(items[i], i);
        }
    };
    const k = Math.max(1, Math.min(concurrency, n));
    await Promise.all(Array.from({ length: k }, () => advance()));
    return out;
}
//# sourceMappingURL=concurrency.js.map
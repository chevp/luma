import type { Provider, ProviderName } from "./types.js";
import { ollamaProvider } from "./ollama.js";

class Semaphore {
  private slots: number;
  private waiters: Array<() => void> = [];
  constructor(n: number) {
    this.slots = n;
  }
  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) w();
    else this.slots += 1;
  }
}

let providerSem: Semaphore | null = null;
function providerSemaphore(): Semaphore {
  if (providerSem) return providerSem;
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
export function activeProviderName(): ProviderName {
  return ollamaProvider.name;
}

export function getProvider(_name?: ProviderName): Provider {
  return ollamaProvider;
}

/** Pings the local ollama daemon; caches the selected model on success. */
export async function providerEnsureRunning(): Promise<boolean> {
  return ollamaProvider.ping();
}

export interface SmartGenerateOptions {
  /** Marks the request as complex. Retained for API compatibility; ignored. */
  complex?: boolean;
}

export async function providerSmartGenerate(
  prompt: string,
  _opts: SmartGenerateOptions = {},
): Promise<string> {
  const sem = providerSemaphore();
  await sem.acquire();
  try {
    return await ollamaProvider.generate(prompt);
  } finally {
    sem.release();
  }
}

export type { Provider, ProviderName };

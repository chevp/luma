import type { Provider, ProviderName } from "./types.js";
import { ollamaProvider } from "./ollama.js";
import { claudeProvider } from "./claude.js";

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
 * luma picks a generation backend via CHI_PROVIDER (persisted as `provider`
 * in ~/.chi/config): "ollama" (default, local daemon) or "claude" (Claude
 * models via a GitHub Copilot subscription — see `luma login claude`).
 */
function resolveProviderName(): ProviderName {
  return process.env.CHI_PROVIDER?.trim().toLowerCase() === "claude" ? "claude" : "ollama";
}

function providerFor(name: ProviderName): Provider {
  return name === "claude" ? claudeProvider : ollamaProvider;
}

export function activeProviderName(): ProviderName {
  return resolveProviderName();
}

export function getProvider(name?: ProviderName): Provider {
  return providerFor(name ?? resolveProviderName());
}

/** Pings the active provider; caches the selected model on success. */
export async function providerEnsureRunning(): Promise<boolean> {
  return getProvider().ping();
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
    return await getProvider().generate(prompt);
  } finally {
    sem.release();
  }
}

export type { Provider, ProviderName };

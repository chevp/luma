import type { Provider, ProviderName } from "./types.js";
import { curaProvider } from "./cura.js";
import { ollamaProvider } from "./ollama.js";
import { commandExists } from "../spawn.js";
import { c } from "../ui.js";
import { BIN_NAME } from "../identity.js";

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

let selected: Provider | null = null;
let detection: Promise<Provider> | null = null;

/**
 * Picks the first reachable provider in priority order: local ollama → cura.
 * Cached for the lifetime of the process; concurrent callers share the same
 * in-flight detection promise.
 */
async function detect(): Promise<Provider> {
  if (selected) return selected;
  if (detection) return detection;
  detection = (async () => {
    if (await ollamaProvider.ping()) {
      selected = ollamaProvider;
    } else {
      if (commandExists("ollama")) {
        process.stderr.write(
          c.dim(
            `${BIN_NAME}: ollama installed but not running — start it with 'ollama serve' (falling back to cura)\n`,
          ),
        );
      }
      selected = curaProvider;
    }
    return selected;
  })();
  return detection;
}

export function activeProviderName(): ProviderName {
  return selected?.name ?? "cura";
}

export function getProvider(name?: ProviderName): Provider {
  if (name === "ollama") return ollamaProvider;
  if (name === "cura") return curaProvider;
  return selected ?? curaProvider;
}

/**
 * Selects the active provider (local ollama if reachable, otherwise cura)
 * and pings it. The selection is cached for the rest of the process.
 */
export async function providerEnsureRunning(): Promise<boolean> {
  const p = await detect();
  return p.ping();
}

export interface SmartGenerateOptions {
  /**
   * Marks the request as complex. Retained for API compatibility; ignored
   * because both backends expose a single small model.
   */
  complex?: boolean;
}

export async function providerSmartGenerate(
  prompt: string,
  _opts: SmartGenerateOptions = {},
): Promise<string> {
  const p = await detect();
  const sem = providerSemaphore();
  await sem.acquire();
  try {
    return await p.generate(prompt);
  } finally {
    sem.release();
  }
}

export type { Provider, ProviderName };

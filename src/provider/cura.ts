import type { Provider } from "./types.js";
import { BIN_NAME } from "../identity.js";

const DEFAULT_URL = "https://cura-llm-3j2fyuwcdq-oa.a.run.app";
const DEFAULT_MODEL = "smollm2:135m";

const URL_BASE = (): string =>
  (process.env.CHI_LLM_URL ?? DEFAULT_URL).replace(/\/+$/, "");
const MODEL = (): string => process.env.CHI_LLM_MODEL ?? DEFAULT_MODEL;

function basicAuthHeader(): string {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!user || !password) {
    throw new Error(
      `${BIN_NAME}: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set ` +
        "(cura-llm requires HTTP basic auth)",
    );
  }
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 5000, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const curaProvider: Provider = {
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
    } catch {
      return false;
    }
  },

  async hasModel(model = MODEL()) {
    try {
      const r = await fetchWithTimeout(`${URL_BASE()}/api/tags`, {
        timeoutMs: 5000,
        headers: { Authorization: basicAuthHeader() },
      });
      if (!r.ok) return false;
      const data = (await r.json()) as { models?: Array<{ name?: string }> };
      const list = data.models ?? [];
      return list.some((m) => (m.name ?? "").startsWith(model));
    } catch {
      return false;
    }
  },

  async generate(prompt: string): Promise<string> {
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
      throw new Error(
        `cura generate failed: HTTP ${r.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      );
    }
    const data = (await r.json()) as { response?: string };
    return data.response ?? "";
  },
};

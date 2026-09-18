import type { Provider } from "./types.js";
import { getCopilotApiToken } from "./github-copilot-auth.js";

const API_BASE = "https://api.githubcopilot.com";
const EDITOR_VERSION = "Neovim/0.9.0";
const EDITOR_PLUGIN_VERSION = "copilot.vim/1.16.0";
const INTEGRATION_ID = "vscode-chat";

interface CopilotModel {
  id?: string;
  vendor?: string;
}

let cachedModel: string | null = null;

function pinnedModel(): string | undefined {
  return process.env.CHI_CLAUDE_MODEL?.trim() || undefined;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 1500, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await getCopilotApiToken();
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": INTEGRATION_ID,
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
  };
}

// Copilot's model catalog changes over time — auto-detect Claude models
// instead of hard-coding an id that may be renamed or retired.
async function listClaudeModels(timeoutMs = 1500): Promise<string[]> {
  const headers = await authHeaders();
  if (!headers) return [];
  const r = await fetchWithTimeout(`${API_BASE}/models`, { headers, timeoutMs });
  if (!r.ok) return [];
  const data = (await r.json()) as { data?: CopilotModel[] };
  return (data.data ?? [])
    .filter((m) => m.vendor === "Anthropic" || /^claude/i.test(m.id ?? ""))
    .map((m) => m.id ?? "")
    .filter((id) => id.length > 0);
}

function pickModel(models: string[]): string | null {
  if (models.length === 0) return null;
  return models.find((m) => /sonnet/i.test(m)) ?? models[0] ?? null;
}

export const claudeProvider: Provider = {
  name: "claude",

  activeModel() {
    return cachedModel ?? "(detecting)";
  },

  async ping() {
    try {
      const models = await listClaudeModels();
      if (models.length === 0) return false;
      const pinned = pinnedModel();
      cachedModel = pinned
        ? (models.find((m) => m === pinned) ?? pickModel(models))
        : pickModel(models);
      return cachedModel !== null;
    } catch {
      return false;
    }
  },

  async hasModel(model?: string) {
    try {
      const models = await listClaudeModels();
      if (model === undefined) return models.length > 0;
      return models.some((m) => m === model || m.startsWith(model));
    } catch {
      return false;
    }
  },

  async generate(prompt: string): Promise<string> {
    const headers = await authHeaders();
    if (!headers) {
      throw new Error("claude: not authenticated — run 'luma login claude'");
    }
    if (!cachedModel) {
      const models = await listClaudeModels(5000);
      if (models.length === 0) {
        throw new Error(
          "claude: no Claude model available via GitHub Copilot (check your Copilot plan/model access)",
        );
      }
      const pinned = pinnedModel();
      cachedModel = pinned
        ? (models.find((m) => m === pinned) ?? pickModel(models))
        : pickModel(models);
    }

    const r = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cachedModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(
        `claude generate failed: HTTP ${r.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      );
    }
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  },
};

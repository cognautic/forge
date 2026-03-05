import type { ForgeState, ProviderConfig, ProviderKind } from "../types";

export const PROVIDERS: ProviderKind[] = [
  "openai",
  "nim",
  "google",
  "anthropic",
  "openrouter",
  "groq",
  "cerebras",
  "ollama",
  "custom"
];

export function setProvider(state: ForgeState, provider: ProviderConfig): ForgeState {
  return { ...state, provider };
}

export function setApiKeyInConfig(state: ForgeState, provider: ProviderKind, key: string): ForgeState {
  return {
    ...state,
    apiKeys: {
      ...state.apiKeys,
      [provider]: key
    }
  };
}

export function getApiKeyFromConfig(state: ForgeState, provider: ProviderKind): string {
  const key = state.apiKeys[provider];
  if (!key) throw new Error(`Missing API key for ${provider}. Use /apikey ${provider} <key>`);
  return key;
}

export async function fetchModels(state: ForgeState, provider: ProviderKind): Promise<string[]> {
  const key = provider === "ollama" ? "" : getApiKeyFromConfig(state, provider);
  if (provider === "openai") {
    const json = await getJson("https://api.openai.com/v1/models", {
      Authorization: `Bearer ${key}`
    });
    return normalizeIds(json.data?.map((m: { id: string }) => m.id) || []);
  }

  if (provider === "nim") {
    const json = await getJson("https://integrate.api.nvidia.com/v1/models", {
      Authorization: `Bearer ${key}`
    });
    return normalizeIds(json.data?.map((m: { id: string }) => m.id) || []);
  }

  if (provider === "openrouter") {
    const json = await getJson("https://openrouter.ai/api/v1/models", {
      Authorization: `Bearer ${key}`
    });
    return normalizeIds(json.data?.map((m: { id: string }) => m.id) || []);
  }

  if (provider === "groq") {
    const json = await getJson("https://api.groq.com/openai/v1/models", {
      Authorization: `Bearer ${key}`
    });
    return normalizeIds(json.data?.map((m: { id: string }) => m.id) || []);
  }

  if (provider === "cerebras") {
    const json = await getJson("https://api.cerebras.ai/v1/models", {
      Authorization: `Bearer ${key}`
    });
    return normalizeIds(json.data?.map((m: { id: string }) => m.id) || []);
  }

  if (provider === "anthropic") {
    const json = await getJson("https://api.anthropic.com/v1/models", {
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    });
    return normalizeIds(json.data?.map((m: { id: string }) => m.id) || []);
  }

  if (provider === "google") {
    const json = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    return normalizeIds(
      (json.models || [])
        .map((m: { name: string }) => String(m.name || "").replace("models/", ""))
        .filter(Boolean)
    );
  }

  if (provider === "custom") {
    const endpoint = state.provider.endpoint;
    if (!endpoint) throw new Error("Custom provider endpoint missing. Use /endpoint <url>");
    const url = endpoint.endsWith("/") ? `${endpoint}models` : `${endpoint}/models`;
    const json = await getJson(url, { Authorization: `Bearer ${key}` });
    return normalizeIds(json.data?.map((m: { id: string }) => m.id) || []);
  }

  if (provider === "ollama") {
    const endpoint = state.provider.endpoint || "http://127.0.0.1:11434";
    const url = endpoint.endsWith("/") ? `${endpoint}api/tags` : `${endpoint}/api/tags`;
    const json = await getJson(url);
    return normalizeIds((json.models || []).map((m: { name: string }) => m.name));
  }

  return [];
}

function normalizeIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 180)}`);
  }
  return res.json();
}

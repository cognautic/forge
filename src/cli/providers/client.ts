import type { ForgeState } from "../types";
import { getApiKeyFromConfig } from "./manager";

export async function streamCompletion(
  state: ForgeState,
  prompt: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const p = state.provider;
  const key = p.provider === "ollama" ? "" : getApiKeyFromConfig(state, p.provider);

  if (p.provider === "openai" || p.provider === "openrouter" || p.provider === "groq" || p.provider === "cerebras" || p.provider === "custom") {
    const url = resolveOpenAICompatUrl(state);
    await streamOpenAICompat(url, key, p.model, prompt, onChunk, signal);
    return;
  }

  if (p.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: p.model,
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await ensureJson(res);
    onChunk(data.content?.[0]?.text || "[empty response]");
    return;
  }

  if (p.provider === "google") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    });
    const data = await ensureJson(res);
    onChunk(data.candidates?.[0]?.content?.parts?.[0]?.text || "[empty response]");
    return;
  }

  if (p.provider === "ollama") {
    const endpoint = p.endpoint || "http://127.0.0.1:11434";
    const url = endpoint.endsWith("/") ? `${endpoint}api/chat` : `${endpoint}/api/chat`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: p.model,
        stream: true,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 220)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          const piece = j.message?.content;
          if (piece) onChunk(String(piece));
        } catch {
          // Ignore malformed chunks.
        }
      }
    }
    return;
  }
}

export async function completeText(state: ForgeState, prompt: string, signal?: AbortSignal): Promise<string> {
  const p = state.provider;
  const key = p.provider === "ollama" ? "" : getApiKeyFromConfig(state, p.provider);

  if (p.provider === "openai" || p.provider === "openrouter" || p.provider === "groq" || p.provider === "cerebras" || p.provider === "custom") {
    const url = resolveOpenAICompatUrl(state);
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: p.model,
        stream: false,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await ensureJson(res);
    return data.choices?.[0]?.message?.content || "";
  }

  if (p.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: p.model,
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await ensureJson(res);
    return data.content?.[0]?.text || "";
  }

  if (p.provider === "google") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    });
    const data = await ensureJson(res);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  if (p.provider === "ollama") {
    const endpoint = p.endpoint || "http://127.0.0.1:11434";
    const url = endpoint.endsWith("/") ? `${endpoint}api/chat` : `${endpoint}/api/chat`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: p.model,
        stream: false,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await ensureJson(res);
    return data.message?.content || "";
  }

  return "";
}

function resolveOpenAICompatUrl(state: ForgeState): string {
  const provider = state.provider.provider;
  if (provider === "openai") return "https://api.openai.com/v1/chat/completions";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1/chat/completions";
  if (provider === "groq") return "https://api.groq.com/openai/v1/chat/completions";
  if (provider === "cerebras") return "https://api.cerebras.ai/v1/chat/completions";
  const endpoint = state.provider.endpoint;
  if (!endpoint) throw new Error("Custom endpoint missing. Use /endpoint <url>");
  return endpoint.endsWith("/") ? `${endpoint}chat/completions` : `${endpoint}/chat/completions`;
}

async function streamOpenAICompat(
  url: string,
  key: string,
  model: string,
  prompt: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 220)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const data = JSON.parse(payload);
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
      } catch {
        // Ignore malformed stream chunks.
      }
    }
  }
}

async function ensureJson(res: Response): Promise<any> {
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 240)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  return data;
}

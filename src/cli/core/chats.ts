import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ChatTurn {
  ts: string;
  role: "user" | "assistant";
  content: string;
}

export interface ChatSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  turns: ChatTurn[];
}

const chatsPath = join(homedir(), ".config", "cognautic-forge", "chats.json");

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(
    d.getHours()
  ).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  return `chat-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function loadChats(): Promise<ChatSession[]> {
  try {
    const raw = await readFile(chatsPath, "utf-8");
    const parsed = JSON.parse(raw) as ChatSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveChats(chats: ChatSession[]): Promise<void> {
  await mkdir(dirname(chatsPath), { recursive: true });
  await writeFile(chatsPath, JSON.stringify(chats, null, 2), "utf-8");
}

export async function createChat(name?: string): Promise<ChatSession> {
  const id = newId();
  const ts = nowIso();
  const chat: ChatSession = {
    id,
    name: (name || id).trim(),
    createdAt: ts,
    updatedAt: ts,
    turns: []
  };
  const chats = await loadChats();
  chats.push(chat);
  await saveChats(chats);
  return chat;
}

export async function resolveChat(selector: string): Promise<ChatSession | null> {
  const chats = await loadChats();
  const q = selector.trim();
  const byId = chats.find((c) => c.id === q);
  if (byId) return byId;
  const byName = chats.filter((c) => c.name === q);
  if (!byName.length) return null;
  return byName.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

export async function upsertChat(chat: ChatSession): Promise<void> {
  const chats = await loadChats();
  const idx = chats.findIndex((c) => c.id === chat.id);
  const next = { ...chat, updatedAt: nowIso() };
  if (idx >= 0) chats[idx] = next;
  else chats.push(next);
  await saveChats(chats);
}

export async function appendTurn(chatId: string, role: "user" | "assistant", content: string): Promise<void> {
  const chats = await loadChats();
  const idx = chats.findIndex((c) => c.id === chatId);
  if (idx < 0) return;
  chats[idx] = {
    ...chats[idx],
    updatedAt: nowIso(),
    turns: [...chats[idx].turns, { ts: nowIso(), role, content }]
  };
  await saveChats(chats);
}

export async function renameChat(chatId: string, name: string): Promise<ChatSession | null> {
  const chats = await loadChats();
  const idx = chats.findIndex((c) => c.id === chatId);
  if (idx < 0) return null;
  chats[idx] = { ...chats[idx], name: name.trim(), updatedAt: nowIso() };
  await saveChats(chats);
  return chats[idx];
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import type { Credentials } from "google-auth-library";

interface StoredTokenEnvelope {
  iv: string;
  tag: string;
  payload: string;
}

interface StoredTokenPayload {
  tokens: Credentials;
  grantedScopes: string[];
  updatedAt: string;
}

export interface GoogleStoredTokens {
  tokens: Credentials;
  grantedScopes: string[];
  updatedAt: string;
}

function getTokenPath(userId: string): string {
  return join(process.cwd(), ".forge", "google-tokens", `${sanitizeUserId(userId)}.json`);
}

function sanitizeUserId(userId: string): string {
  return String(userId || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getEncryptionKey(): Buffer {
  const secret = process.env.FORGE_ENCRYPTION_KEY || "";
  if (!secret) {
    throw new Error("FORGE_ENCRYPTION_KEY is required for Google token encryption");
  }
  return createHash("sha256")
    .update([secret, hostname(), homedir(), platform()].join("|"))
    .digest();
}

function encryptPayload(payload: StoredTokenPayload): StoredTokenEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const content = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    payload: content.toString("base64")
  };
}

function decryptPayload(envelope: StoredTokenEnvelope): StoredTokenPayload {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const content = Buffer.concat([
    decipher.update(Buffer.from(envelope.payload, "base64")),
    decipher.final()
  ]);
  return JSON.parse(content.toString("utf8")) as StoredTokenPayload;
}

/**
 * Saves Google OAuth tokens for a Forge user.
 */
export async function saveTokens(userId: string, tokens: Credentials, grantedScopes: string[] = []): Promise<void> {
  const filePath = getTokenPath(userId);
  const next: StoredTokenPayload = {
    tokens,
    grantedScopes: [...new Set(grantedScopes)].sort(),
    updatedAt: new Date().toISOString()
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(encryptPayload(next), null, 2), "utf8");
}

/**
 * Loads previously saved Google OAuth tokens for a Forge user.
 */
export async function loadTokens(userId: string): Promise<GoogleStoredTokens | null> {
  try {
    const raw = await readFile(getTokenPath(userId), "utf8");
    return decryptPayload(JSON.parse(raw) as StoredTokenEnvelope);
  } catch {
    return null;
  }
}

/**
 * Deletes the saved token file for a Forge user.
 */
export async function deleteTokens(userId: string): Promise<void> {
  await rm(getTokenPath(userId), { force: true });
}

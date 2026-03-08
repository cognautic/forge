import { spawn } from "node:child_process";
import { google } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";
import { getRedirectUri, startCallbackServer } from "./callback-server";
import { deleteTokens, loadTokens, saveTokens } from "./tokens";
import { SCOPES } from "./scopes";

const DEFAULT_CONVEX_GOOGLE_AUTH_URL = "https://limitless-eel-242.convex.site/google/auth";
const DEFAULT_CONVEX_GOOGLE_EXCHANGE_URL = "https://limitless-eel-242.convex.site/google/exchange";
const DEFAULT_CONVEX_GOOGLE_LOGOUT_URL = "https://limitless-eel-242.convex.site/google/logout";
const DEFAULT_CONVEX_GOOGLE_REFRESH_URL = "https://limitless-eel-242.convex.site/google/refresh";

function requiredEnv(name: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Creates a Google OAuth2 client for the supplied redirect URI.
 */
export function createOAuthClient(redirectUri: string): OAuth2Client {
  return new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri
  );
}

/**
 * Creates a Google OAuth consent URL for the requested scopes.
 */
export function getAuthUrl(scopes: string[], redirectUri: string): string {
  const client = createOAuthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...new Set(scopes)]
  });
}

/**
 * Exchanges an OAuth authorization code for Google tokens.
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<Credentials> {
  const client = createOAuthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Loads a ready-to-use authenticated Google OAuth client for a Forge user.
 */
export async function getAuthenticatedClient(userId: string): Promise<OAuth2Client | null> {
  const stored = await loadTokens(userId);
  if (!stored) return null;
  const redirectUri = getRedirectUri(Number(process.env.GOOGLE_REDIRECT_PORT || 3747));
  const client = createRuntimeOAuthClient(redirectUri);
  const nextTokens = await ensureFreshTokens(stored.tokens);
  client.setCredentials(nextTokens);
  client.on("tokens", async (tokens) => {
    const merged = {
      ...nextTokens,
      ...tokens,
      refresh_token: tokens.refresh_token || nextTokens.refresh_token
    };
    await saveTokens(userId, merged, stored.grantedScopes);
  });
  return client;
}

/**
 * Ensures the user has granted the requested Google scopes and returns an authenticated client.
 */
export async function ensureGoogleClient(userId: string, scopes: string[]): Promise<OAuth2Client> {
  const requiredScopes = new Set([...SCOPES.base, ...scopes]);
  const stored = await loadTokens(userId);
  const missing = [...requiredScopes].filter((scope) => !stored?.grantedScopes?.includes(scope));
  if (!stored || missing.length > 0) {
    const result = await connectGoogle(userId, [...requiredScopes]);
    if (!result.success) {
      throw new Error(result.error);
    }
  }
  const client = await getAuthenticatedClient(userId);
  if (!client) throw new Error("Google client not connected");
  await client.getAccessToken();
  return client;
}

/**
 * Starts the Google OAuth flow, opens the browser, exchanges the returned code, and stores tokens.
 */
export async function connectGoogle(
  userId: string,
  scopes: string[]
): Promise<{ success: true; email: string } | { success: false; error: string }> {
  try {
    const requiredScopes = [...new Set([...SCOPES.base, ...scopes])];
    const existing = await loadTokens(userId);
    const alreadyGranted = existing
      ? requiredScopes.every((scope) => existing.grantedScopes.includes(scope))
      : false;
    if (existing && alreadyGranted) {
      const client = await getAuthenticatedClient(userId);
      if (client) {
        try {
          await client.getAccessToken();
          const oauth2 = google.oauth2({ auth: client, version: "v2" });
          const me = await oauth2.userinfo.get();
          return { success: true, email: me.data.email || "unknown" };
        } catch {
          // Fall through to a fresh auth flow if stored auth is no longer usable.
        }
      }
    }

    const handle = await startCallbackServer();
    const redirectUri = getRedirectUri(handle.port);
    const authUrl = getServerAuthUrl(userId, requiredScopes, redirectUri) || getAuthUrl(requiredScopes, redirectUri);
    await openUrl(authUrl);
    const code = await handle.waitForCode;
    const serverExchange = getServerExchangeUrl();
    const exchanged = serverExchange
      ? await exchangeCodeViaServer(code, redirectUri, userId)
      : await exchangeCodeLocally(code, redirectUri);
    const me = exchanged.email;
    const latestStored = await loadTokens(userId);
    const grantedScopes = [...new Set([...(latestStored?.grantedScopes || []), ...requiredScopes])];
    const merged = {
      ...(latestStored?.tokens || {}),
      ...exchanged.tokens,
      refresh_token: exchanged.tokens.refresh_token || latestStored?.tokens.refresh_token
    };
    await saveTokens(userId, merged, grantedScopes);
    return { success: true, email: me || "unknown" };
  } catch (error) {
    return { success: false, error: formatError(error) };
  }
}

/**
 * Logs out a Google user locally and optionally via a configured server endpoint.
 */
export async function disconnectGoogle(userId: string): Promise<{ success: true } | { success: false; error: string }> {
  let remoteError: string | null = null;
  try {
    const logoutUrl = process.env.CONVEX_GOOGLE_LOGOUT_URL || DEFAULT_CONVEX_GOOGLE_LOGOUT_URL;
    if (logoutUrl) {
      const res = await fetch(logoutUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId })
      });
      if (!res.ok) {
        remoteError = `Server logout failed: HTTP ${res.status}`;
      }
    }
  } catch (error) {
    remoteError = formatError(error);
  }

  try {
    await deleteTokens(userId);
    if (remoteError) {
      return { success: false, error: `Local tokens deleted, but remote logout failed: ${remoteError}` };
    }
    return { success: true };
  } catch (error) {
    if (remoteError) {
      return { success: false, error: `Remote logout failed: ${remoteError}; local cleanup also failed: ${formatError(error)}` };
    }
    return { success: false, error: formatError(error) };
  }
}

async function openUrl(url: string): Promise<void> {
  const bunRuntime = (globalThis as any).Bun as undefined | { spawn?: (cmd: string[], opts?: Record<string, unknown>) => unknown };
  const opener = getOpenCommand(url);
  if (bunRuntime && typeof bunRuntime.spawn === "function") {
    bunRuntime.spawn([opener.command, ...opener.args], { stdio: ["ignore", "ignore", "ignore"] });
    return;
  }
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
    shell: false
  });
  child.unref();
}

function getOpenCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

function getServerAuthUrl(userId: string, scopes: string[], redirectUri: string): string | null {
  const base = process.env.CONVEX_GOOGLE_AUTH_URL || DEFAULT_CONVEX_GOOGLE_AUTH_URL;
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set("userId", userId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("scopes", JSON.stringify([...new Set(scopes)]));
  return url.toString();
}

function getServerExchangeUrl(): string | null {
  return process.env.CONVEX_GOOGLE_EXCHANGE_URL || DEFAULT_CONVEX_GOOGLE_EXCHANGE_URL;
}

function getServerRefreshUrl(): string | null {
  return process.env.CONVEX_GOOGLE_REFRESH_URL || DEFAULT_CONVEX_GOOGLE_REFRESH_URL;
}

async function exchangeCodeLocally(
  code: string,
  redirectUri: string
): Promise<{ tokens: Credentials; email: string }> {
  const tokens = await exchangeCode(code, redirectUri);
  const client = createOAuthClient(redirectUri);
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ auth: client, version: "v2" });
  const me = await oauth2.userinfo.get();
  return { tokens, email: me.data.email || "unknown" };
}

async function exchangeCodeViaServer(
  code: string,
  redirectUri: string,
  userId: string
): Promise<{ tokens: Credentials; email: string }> {
  const endpoint = getServerExchangeUrl();
  if (!endpoint) throw new Error("Convex Google exchange URL is not configured");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirectUri, userId })
  });
  if (!res.ok) throw new Error(`Server exchange failed: HTTP ${res.status}`);
  const body = (await res.json()) as { tokens?: Credentials; email?: string; error?: string };
  if (body.error) throw new Error(body.error);
  if (!body.tokens) throw new Error("Server exchange response missing tokens");
  return { tokens: body.tokens, email: body.email || "unknown" };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRuntimeOAuthClient(redirectUri: string): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }
  return new google.auth.OAuth2(undefined, undefined, redirectUri);
}

async function ensureFreshTokens(tokens: Credentials): Promise<Credentials> {
  const refreshToken = tokens.refresh_token;
  const expiry = Number(tokens.expiry_date || 0);
  if (!refreshToken || !expiry || expiry - Date.now() > 60_000) {
    return tokens;
  }
  const refreshUrl = getServerRefreshUrl();
  if (!refreshUrl) {
    return tokens;
  }
  const res = await fetch(refreshUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken })
  });
  if (!res.ok) {
    throw new Error(`Server refresh failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { tokens?: Credentials; error?: string };
  if (body.error) throw new Error(body.error);
  return {
    ...tokens,
    ...(body.tokens || {}),
    refresh_token: body.tokens?.refresh_token || refreshToken
  };
}

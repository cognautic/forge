import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const CALLBACK_PATH = "/auth/google/callback";
const SUCCESS_HTML =
  "<html><body style='font-family:sans-serif;text-align:center;padding:60px'><h2>✅ Connected to Google!</h2><p>You can close this tab and return to Forge.</p></body></html>";

export interface CallbackServerHandle {
  port: number;
  waitForCode: Promise<string>;
}

/**
 * Returns the configured Google OAuth localhost redirect URI.
 */
export function getRedirectUri(port: number): string {
  return `http://localhost:${port}${CALLBACK_PATH}`;
}

/**
 * Starts a one-time localhost callback server and resolves with the Google auth code.
 */
export async function startCallbackServer(): Promise<CallbackServerHandle> {
  const preferredPort = Number(process.env.GOOGLE_REDIRECT_PORT || 3747);
  const bunRuntime = (globalThis as any).Bun as undefined | { serve?: (options: any) => { port: number; stop: (force?: boolean) => void } };
  if (bunRuntime && typeof bunRuntime.serve === "function") {
    return await startBunCallbackServer(preferredPort, bunRuntime as { serve: (options: any) => { port: number; stop: (force?: boolean) => void } });
  }
  return await startNodeCallbackServer(preferredPort);
}

async function startBunCallbackServer(
  preferredPort: number,
  bunRuntime: { serve: (options: any) => { port: number; stop: (force?: boolean) => void } }
): Promise<CallbackServerHandle> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let settled = false;
  const server = bunRuntime.serve({
    port: preferredPort,
    fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname !== CALLBACK_PATH) return new Response("Not found", { status: 404 });
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error && !settled) {
        settled = true;
        rejectCode(new Error(`Google OAuth denied: ${error}`));
      }
      if (code && !settled) {
        settled = true;
        resolveCode(code);
      }
      queueMicrotask(() => server.stop(true));
      return new Response(SUCCESS_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
  });
  return { port: server.port, waitForCode };
}

async function startNodeCallbackServer(preferredPort: number): Promise<CallbackServerHandle> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let settled = false;
  const server = createServer((req, res) => {
    void handleNodeRequest(req, res, (code) => {
      if (settled) return;
      settled = true;
      resolveCode(code);
    }, (error) => {
      if (settled) return;
      settled = true;
      rejectCode(error);
    }, () => server.close());
  });
  const port = await listen(server, preferredPort);
  return { port, waitForCode };
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  onCode: (code: string) => void,
  onError: (error: Error) => void,
  onFinish: () => void
): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== CALLBACK_PATH) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(SUCCESS_HTML, () => onFinish());
  if (error) {
    onError(new Error(`Google OAuth denied: ${error}`));
    return;
  }
  if (!code) {
    onError(new Error("Google OAuth callback missing code parameter"));
    return;
  }
  onCode(code);
}

function listen(server: ReturnType<typeof createServer>, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && preferredPort !== 0) {
        server.off("error", onError);
        listen(server, 0).then(resolve, reject);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(preferredPort, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine callback server port"));
        return;
      }
      resolve(address.port);
    });
  });
}

import { createHash, randomBytes } from "node:crypto";
import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { exchangeAuthorizationCode } from "./gcal";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_AUTHORIZATION_VERSION = 1;
const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
];
/** How long the loopback listener waits for Google before giving up. */
export const AUTHORIZATION_TIMEOUT_MS = 2 * 60 * 1000;
export const AUTHORIZATION_CANCELLED_MESSAGE = "Google authorization was cancelled";

export interface GoogleAuthorizationDependencies {
  openExternal(url: string): void;
  exchangeCode(input: Parameters<typeof exchangeAuthorizationCode>[0]): Promise<string>;
}

const DEFAULT_DEPENDENCIES: GoogleAuthorizationDependencies = {
  openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  exchangeCode: exchangeAuthorizationCode,
};

export async function authorizeGoogle(
  input: {
    clientId: string;
    clientSecret?: string;
    /** Abort to stop waiting and close the loopback listener straight away. */
    signal?: AbortSignal;
  },
  dependencies: GoogleAuthorizationDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const { signal, ...credentials } = input;
  if (signal?.aborted) throw new Error(AUTHORIZATION_CANCELLED_MESSAGE);

  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const server = createServer();

  try {
    const port = await listen(server);
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
    authorizationUrl.search = new URLSearchParams({
      access_type: "offline",
      client_id: credentials.clientId,
      code_challenge: challenge,
      code_challenge_method: "S256",
      include_granted_scopes: "true",
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: CALENDAR_SCOPES.join(" "),
      state,
    }).toString();

    const codePromise = waitForAuthorizationCode(server, state);
    dependencies.openExternal(authorizationUrl.toString());
    const code = await withDeadline(codePromise, AUTHORIZATION_TIMEOUT_MS, signal);
    return await dependencies.exchangeCode({
      ...credentials,
      code,
      codeVerifier: verifier,
      redirectUri,
    });
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Could not open the local OAuth callback"));
      return;
    }
    resolve(address.port);
  });
  return promise;
}

function waitForAuthorizationCode(server: Server, expectedState: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth2callback") {
      response.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (state !== expectedState) {
      respond(response, 400, "Invalid authorization response. You can close this tab.");
      reject(new Error("Google returned an invalid OAuth callback"));
      return;
    }
    if (error) {
      respond(response, 400, "Google Calendar authorization was denied. You can close this tab.");
      reject(new Error(`Google authorization failed: ${error}`));
      return;
    }
    if (!code) {
      respond(response, 400, "Invalid authorization response. You can close this tab.");
      reject(new Error("Google returned an invalid OAuth callback"));
      return;
    }

    respond(response, 200, "Google Calendar authorization succeeded. You can close this tab.");
    resolve(code);
  });
  return promise;
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
  await promise;
}

/** Resolves with the callback result, or rejects once the deadline passes or the caller aborts. */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  const stopped = Promise.withResolvers<T>();
  const timeout = window.setTimeout(
    () => stopped.reject(new Error("Google authorization timed out")),
    timeoutMs,
  );
  const cancel = (): void => stopped.reject(new Error(AUTHORIZATION_CANCELLED_MESSAGE));
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    return await Promise.race([promise, stopped.promise]);
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

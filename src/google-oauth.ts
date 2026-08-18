import { createHash, randomBytes } from "node:crypto";
import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { exchangeAuthorizationCode } from "./google-calendar";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_AUTHORIZATION_VERSION = 1;
const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
];
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;

export async function authorizeGoogle(input: {
  clientId: string;
  clientSecret?: string;
}): Promise<string> {
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
      client_id: input.clientId,
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
    window.open(authorizationUrl.toString(), "_blank", "noopener,noreferrer");
    const code = await withTimeout(codePromise, AUTHORIZATION_TIMEOUT_MS);
    return await exchangeAuthorizationCode({
      ...input,
      code,
      codeVerifier: verifier,
      redirectUri,
    });
  } finally {
    server.close();
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
    if (error) {
      respond(response, 400, "Google Calendar authorization was denied. You can close this tab.");
      reject(new Error(`Google authorization failed: ${error}`));
      return;
    }
    if (state !== expectedState || !code) {
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeoutResult = Promise.withResolvers<T>();
  const timeout = setTimeout(
    () => timeoutResult.reject(new Error("Google authorization timed out")),
    timeoutMs,
  );
  try {
    return await Promise.race([promise, timeoutResult.promise]);
  } finally {
    clearTimeout(timeout);
  }
}

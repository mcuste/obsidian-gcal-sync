import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { get } from "node:http";
import { after, test } from "node:test";
import {
  AUTHORIZATION_CANCELLED_MESSAGE,
  AUTHORIZATION_TIMEOUT_MS,
  authorizeGoogle,
  type GoogleAuthorizationDependencies,
} from "../src/gcal-oauth";

interface HttpResult {
  status: number;
  body: string;
}

const originalWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", { value: originalWindow });
  else Reflect.deleteProperty(globalThis, "window");
});

type ExchangeInput = Parameters<GoogleAuthorizationDependencies["exchangeCode"]>[0];

function request(url: URL): Promise<HttpResult> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResult>();
  const outgoing = get(url, { agent: false }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      body += chunk;
    });
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
  });
  outgoing.on("error", reject);
  return promise;
}

function redirectUri(authorizationUrl: URL): URL {
  const value = authorizationUrl.searchParams.get("redirect_uri");
  assert.ok(value, "Expected a redirect URI");
  return new URL(value);
}

function callbackUrl(
  authorizationUrl: URL,
  parameters: Record<string, string>,
  path = "/oauth2callback",
): URL {
  const callback = redirectUri(authorizationUrl);
  callback.pathname = path;
  callback.search = new URLSearchParams(parameters).toString();
  return callback;
}

async function assertListenerClosed(authorizationUrl: URL): Promise<void> {
  await assert.rejects(request(redirectUri(authorizationUrl)));
}

test("valid loopback callback verifies PKCE and exchanges the code", async () => {
  const callbackResult = Promise.withResolvers<HttpResult>();
  let authorizationUrl: URL | undefined;
  let exchanged: ExchangeInput | undefined;

  const refreshToken = await authorizeGoogle(
    { clientId: "client-id", clientSecret: "client-secret" },
    {
      openExternal(value) {
        authorizationUrl = new URL(value);
        const state = authorizationUrl.searchParams.get("state");
        assert.ok(state);
        void request(callbackUrl(authorizationUrl, { code: "authorization-code", state })).then(
          callbackResult.resolve,
          callbackResult.reject,
        );
      },
      async exchangeCode(input) {
        exchanged = input;
        return "refresh-token";
      },
    },
  );

  assert.equal(refreshToken, "refresh-token");
  const response = await callbackResult.promise;
  assert.equal(response.status, 200);
  assert.match(response.body, /authorization succeeded/);
  assert.ok(authorizationUrl);
  assert.ok(exchanged);
  assert.equal(exchanged.code, "authorization-code");
  assert.equal(exchanged.clientId, "client-id");
  assert.equal(exchanged.clientSecret, "client-secret");
  assert.equal(exchanged.redirectUri, redirectUri(authorizationUrl).toString());
  const expectedChallenge = createHash("sha256").update(exchanged.codeVerifier).digest("base64url");
  assert.equal(authorizationUrl.searchParams.get("code_challenge"), expectedChallenge);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  await assertListenerClosed(authorizationUrl);
});

test("mismatched callback state is rejected before token exchange", async () => {
  const opened = Promise.withResolvers<URL>();
  const callbackResult = Promise.withResolvers<HttpResult>();
  let exchangeCalls = 0;
  const authorization = authorizeGoogle(
    { clientId: "client-id" },
    {
      openExternal(value) {
        const authorizationUrl = new URL(value);
        opened.resolve(authorizationUrl);
        void request(
          callbackUrl(authorizationUrl, { code: "authorization-code", state: "wrong-state" }),
        ).then(callbackResult.resolve, callbackResult.reject);
      },
      async exchangeCode() {
        exchangeCalls += 1;
        return "unexpected";
      },
    },
  );

  await assert.rejects(authorization, /invalid OAuth callback/);
  const response = await callbackResult.promise;
  assert.equal(response.status, 400);
  assert.match(response.body, /Invalid authorization response/);
  assert.equal(exchangeCalls, 0);
  await assertListenerClosed(await opened.promise);
});

test("callback without an authorization code is rejected", async () => {
  const opened = Promise.withResolvers<URL>();
  const callbackResult = Promise.withResolvers<HttpResult>();
  const authorization = authorizeGoogle(
    { clientId: "client-id" },
    {
      openExternal(value) {
        const authorizationUrl = new URL(value);
        opened.resolve(authorizationUrl);
        const state = authorizationUrl.searchParams.get("state");
        assert.ok(state);
        void request(callbackUrl(authorizationUrl, { state })).then(
          callbackResult.resolve,
          callbackResult.reject,
        );
      },
      async exchangeCode() {
        throw new Error("Token exchange must not run");
      },
    },
  );

  await assert.rejects(authorization, /invalid OAuth callback/);
  assert.equal((await callbackResult.promise).status, 400);
  await assertListenerClosed(await opened.promise);
});

test("Google authorization denial is returned to the caller", async () => {
  const opened = Promise.withResolvers<URL>();
  const callbackResult = Promise.withResolvers<HttpResult>();
  const authorization = authorizeGoogle(
    { clientId: "client-id" },
    {
      openExternal(value) {
        const authorizationUrl = new URL(value);
        opened.resolve(authorizationUrl);
        const state = authorizationUrl.searchParams.get("state");
        assert.ok(state);
        void request(callbackUrl(authorizationUrl, { error: "access_denied", state })).then(
          callbackResult.resolve,
          callbackResult.reject,
        );
      },
      async exchangeCode() {
        throw new Error("Token exchange must not run");
      },
    },
  );

  await assert.rejects(authorization, /Google authorization failed: access_denied/);
  const response = await callbackResult.promise;
  assert.equal(response.status, 400);
  assert.match(response.body, /authorization was denied/);
  await assertListenerClosed(await opened.promise);
});

test("unrelated callback paths return 404 without consuming authorization", async () => {
  const opened = Promise.withResolvers<URL>();
  const unrelatedResult = Promise.withResolvers<HttpResult>();
  const callbackResult = Promise.withResolvers<HttpResult>();
  const authorization = authorizeGoogle(
    { clientId: "client-id" },
    {
      openExternal(value) {
        const authorizationUrl = new URL(value);
        opened.resolve(authorizationUrl);
        const state = authorizationUrl.searchParams.get("state");
        assert.ok(state);
        void (async () => {
          unrelatedResult.resolve(
            await request(callbackUrl(authorizationUrl, {}, "/unrelated-path")),
          );
          callbackResult.resolve(
            await request(callbackUrl(authorizationUrl, { code: "authorization-code", state })),
          );
        })().catch((error: unknown) => {
          unrelatedResult.reject(error);
          callbackResult.reject(error);
        });
      },
      async exchangeCode() {
        return "refresh-token";
      },
    },
  );

  assert.equal(await authorization, "refresh-token");
  assert.deepEqual(await unrelatedResult.promise, { status: 404, body: "" });
  assert.equal((await callbackResult.promise).status, 200);
  await assertListenerClosed(await opened.promise);
});

test("authorization timeout uses fake time and closes the listener", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = Promise.withResolvers<URL>();
  const authorization = authorizeGoogle(
    { clientId: "client-id" },
    {
      openExternal(value) {
        opened.resolve(new URL(value));
      },
      async exchangeCode() {
        throw new Error("Token exchange must not run");
      },
    },
  );
  const authorizationUrl = await opened.promise;

  try {
    context.mock.timers.tick(AUTHORIZATION_TIMEOUT_MS);
    await assert.rejects(authorization, /Google authorization timed out/);
  } finally {
    context.mock.timers.reset();
  }
  await assertListenerClosed(authorizationUrl);
});

test("aborting mid-flow stops waiting and closes the listener", async () => {
  const opened = Promise.withResolvers<URL>();
  const controller = new AbortController();
  const authorization = authorizeGoogle(
    { clientId: "client-id", signal: controller.signal },
    {
      openExternal(value) {
        opened.resolve(new URL(value));
      },
      async exchangeCode() {
        throw new Error("Token exchange must not run");
      },
    },
  );
  const authorizationUrl = await opened.promise;

  controller.abort();

  await assert.rejects(authorization, { message: AUTHORIZATION_CANCELLED_MESSAGE });
  await assertListenerClosed(authorizationUrl);
});

test("an already-aborted signal never opens a browser or a listener", async () => {
  let opened = false;
  await assert.rejects(
    authorizeGoogle(
      { clientId: "client-id", signal: AbortSignal.abort() },
      {
        openExternal() {
          opened = true;
        },
        async exchangeCode() {
          throw new Error("Token exchange must not run");
        },
      },
    ),
    { message: AUTHORIZATION_CANCELLED_MESSAGE },
  );
  assert.equal(opened, false);
});

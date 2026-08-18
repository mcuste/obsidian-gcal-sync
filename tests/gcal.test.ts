import assert from "node:assert/strict";
import test from "node:test";
import type { VaultCalendarEvent } from "../src/event-parser";
import {
  GcalClient,
  type GoogleHttpRequest,
  type GoogleHttpResponse,
  type GoogleTransport,
  RECONCILIATION_APPROVAL_THRESHOLD,
  RECONCILIATION_DELETE_APPROVAL_THRESHOLD,
  type ReconciliationSummary,
  revokeGoogleAuthorization,
} from "../src/gcal";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const VAULT_ID = "vault/id";

function response(json: unknown, status = 200, text = JSON.stringify(json)): GoogleHttpResponse {
  return { status, json, text };
}

function recordingTransport(
  handler: (request: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>,
): { requests: GoogleHttpRequest[]; transport: GoogleTransport } {
  const requests: GoogleHttpRequest[] = [];
  return {
    requests,
    async transport(request) {
      requests.push(request);
      return handler(request);
    },
  };
}

function desired(sourceKey: string, summary: string, recurrence?: string[]): VaultCalendarEvent {
  return {
    sourceKey,
    remoteSourceKey: sourceKey,
    summary,
    start: { date: "2026-08-18" },
    end: { date: "2026-08-19" },
    recurrence,
  };
}

/** The private properties the plugin stamps on every event it owns in this vault. */
function managedBy(sourceKey: string, vaultId = VAULT_ID): Record<string, string> {
  return { obsidianGcal: "1", obsidianVaultId: vaultId, obsidianSourceKey: sourceKey };
}

function requestBody(request: GoogleHttpRequest): Record<string, unknown> {
  if (typeof request.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(request.body) as Record<string, unknown>;
}

function client(transport: GoogleTransport, calendarId = "calendar-id"): GcalClient {
  return new GcalClient(
    {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    calendarId,
    VAULT_ID,
    transport,
  );
}

test("managed-event listing isolates the vault, exhausts pages, and encodes IDs", async () => {
  const { requests, transport } = recordingTransport((request) => {
    if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      if (!url.searchParams.has("pageToken")) {
        return response({
          items: [
            {
              id: "event/id",
              summary: "Stale one",
              extendedProperties: { private: managedBy("stale-one") },
            },
            {
              id: "cancelled-id",
              status: "cancelled",
              extendedProperties: { private: managedBy("cancelled") },
            },
          ],
          nextPageToken: "next page",
        });
      }
      return response({
        items: [
          {
            id: "event two",
            summary: "Stale two",
            extendedProperties: { private: managedBy("stale-two") },
          },
        ],
      });
    }
    if (request.method === "DELETE") return response({}, 204, "");
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });

  const stats = await client(transport, "calendar/id").reconcile([]);

  assert.deepEqual(stats, {
    created: 0,
    updated: 0,
    deleted: 2,
    unchanged: 0,
    deferredDeletes: 0,
  });
  const tokenRequest = requests[0];
  assert.ok(tokenRequest);
  assert.equal(tokenRequest.url, TOKEN_ENDPOINT);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(tokenRequest.body))), {
    client_id: "client-id",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "refresh-token",
  });

  const listRequests = requests.filter((request) => request.method === "GET");
  assert.equal(listRequests.length, 2);
  for (const request of listRequests) {
    const url = new URL(request.url);
    assert.equal(url.pathname, "/calendar/v3/calendars/calendar%2Fid/events");
    // Google ORs repeated private-property filters, so only the vault marker may be queried.
    assert.deepEqual(url.searchParams.getAll("privateExtendedProperty"), [
      "obsidianVaultId=vault/id",
    ]);
    assert.equal(request.headers?.Authorization, "Bearer access-token");
  }
  assert.equal(new URL(listRequests[1]?.url ?? "").searchParams.get("pageToken"), "next page");

  const deleteUrls = requests
    .filter((request) => request.method === "DELETE")
    .map((request) => request.url);
  assert.deepEqual(deleteUrls, [
    "https://www.googleapis.com/calendar/v3/calendars/calendar%2Fid/events/event%2Fid",
    "https://www.googleapis.com/calendar/v3/calendars/calendar%2Fid/events/event%20two",
  ]);
});

test("create and patch bodies preserve source metadata and remove recurrence", async () => {
  const { requests, transport } = recordingTransport((request) => {
    if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
    if (request.method === "GET") {
      return response({
        items: [
          {
            id: "patch/id",
            summary: "Old title",
            start: { date: "2026-08-18" },
            end: { date: "2026-08-19" },
            recurrence: ["RRULE:FREQ=WEEKLY"],
            extendedProperties: { private: managedBy("changed") },
          },
        ],
      });
    }
    if (request.method === "POST" || request.method === "PATCH") return response({});
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });

  const stats = await client(transport).reconcile([
    desired("new", "New", ["RRULE:FREQ=WEEKLY"]),
    desired("changed", "Changed"),
  ]);

  assert.deepEqual(stats, {
    created: 1,
    updated: 1,
    deleted: 0,
    unchanged: 0,
    deferredDeletes: 0,
  });
  const createRequest = requests.find(
    (request) => request.method === "POST" && request.url.includes("/calendar/v3/"),
  );
  const patchRequest = requests.find((request) => request.method === "PATCH");
  assert.ok(createRequest);
  assert.ok(patchRequest);
  assert.equal(
    patchRequest.url,
    "https://www.googleapis.com/calendar/v3/calendars/calendar-id/events/patch%2Fid",
  );
  assert.deepEqual(requestBody(createRequest), {
    summary: "New",
    start: { date: "2026-08-18" },
    end: { date: "2026-08-19" },
    recurrence: ["RRULE:FREQ=WEEKLY"],
    extendedProperties: {
      private: {
        obsidianGcal: "1",
        obsidianVaultId: "vault/id",
        obsidianSourceKey: "new",
      },
    },
  });
  assert.deepEqual(requestBody(patchRequest), {
    summary: "Changed",
    start: { date: "2026-08-18" },
    end: { date: "2026-08-19" },
    recurrence: [],
    extendedProperties: {
      private: {
        obsidianGcal: "1",
        obsidianVaultId: "vault/id",
        obsidianSourceKey: "changed",
      },
    },
  });
});

test("delete accepts gone events and rejects unexpected statuses", async () => {
  for (const status of [204, 404, 410]) {
    const { transport } = recordingTransport((request) => {
      if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
      if (request.method === "GET") {
        return response({
          items: [
            {
              id: "stale-id",
              extendedProperties: { private: managedBy("stale") },
            },
          ],
        });
      }
      if (request.method === "DELETE") return response({}, status, "");
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    await assert.doesNotReject(client(transport).reconcile([]));
  }

  const { transport } = recordingTransport((request) => {
    if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
    if (request.method === "GET") {
      return response({
        items: [
          {
            id: "stale-id",
            extendedProperties: { private: managedBy("stale") },
          },
        ],
      });
    }
    if (request.method === "DELETE") return response({}, 500, "server failed");
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  await assert.rejects(client(transport).reconcile([]), /delete failed \(500\): server failed/);
});

test("writable calendars are filtered, sorted, and paginated", async () => {
  const { requests, transport } = recordingTransport((request) => {
    if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
    const url = new URL(request.url);
    if (!url.searchParams.has("pageToken")) {
      return response({
        items: [
          { id: "read-only", summary: "Read only", accessRole: "reader" },
          { id: "primary", summary: "Primary", accessRole: "owner", primary: true },
          { summary: "Missing ID", accessRole: "writer" },
        ],
        nextPageToken: "page-2",
      });
    }
    return response({
      items: [
        { id: "beta", summary: "Beta", accessRole: "writerWithoutPrivateAccess" },
        { id: "alpha", summary: "Ignored", summaryOverride: "Alpha", accessRole: "writer" },
      ],
    });
  });

  const calendars = await client(transport).listWritableCalendars();

  assert.deepEqual(calendars, [
    { id: "primary", name: "Primary", primary: true },
    { id: "alpha", name: "Alpha", primary: false },
    { id: "beta", name: "Beta", primary: false },
  ]);
  const listRequests = requests.filter((request) => request.url.includes("/calendarList"));
  assert.equal(listRequests.length, 2);
  const firstQuery = new URL(listRequests[0]?.url ?? "").searchParams;
  assert.deepEqual(Object.fromEntries(firstQuery), {
    maxResults: "250",
    minAccessRole: "writer",
    showHidden: "true",
  });
  assert.equal(new URL(listRequests[1]?.url ?? "").searchParams.get("pageToken"), "page-2");
});

test("calendar creation trims names and rejects missing response IDs", async () => {
  const blank = recordingTransport(() => response({}));
  await assert.rejects(client(blank.transport).createCalendar("   "), /Calendar name is required/);
  assert.deepEqual(blank.requests, []);

  const created = recordingTransport((request) => {
    if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
    return response({ id: "new-calendar", summary: "Google name" });
  });
  const calendar = await client(created.transport).createCalendar("  Team calendar  ");
  assert.deepEqual(calendar, { id: "new-calendar", name: "Google name", primary: false });
  const createRequest = created.requests.find((request) => request.url.endsWith("/calendars"));
  assert.ok(createRequest);
  assert.deepEqual(requestBody(createRequest), { summary: "Team calendar" });

  const missingId = recordingTransport((request) => {
    if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
    return response({ summary: "Missing" });
  });
  await assert.rejects(
    client(missingId.transport).createCalendar("Missing"),
    /did not return the created calendar ID/,
  );
});

test("events marked for another vault are never planned against", async () => {
  const { requests, transport } = recordingTransport((request) => {
    if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
    if (request.method === "GET") {
      // Google ORs repeated privateExtendedProperty filters, so the listing can include events
      // that only match the shared plugin marker.
      return response({
        items: [
          {
            id: "other-vault-event",
            summary: "Someone else's event",
            extendedProperties: { private: managedBy("their-key", "other-vault") },
          },
          {
            id: "unmarked-event",
            summary: "Missing the plugin marker",
            extendedProperties: { private: { obsidianVaultId: VAULT_ID } },
          },
        ],
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });

  const stats = await client(transport).reconcile([]);

  assert.deepEqual(stats, {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    deferredDeletes: 0,
  });
  assert.deepEqual(
    requests.filter((request) => request.method !== "GET" && request.url !== TOKEN_ENDPOINT),
    [],
  );
});

function staleEvents(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `stale-${index}`,
    summary: `Stale ${index}`,
    extendedProperties: { private: managedBy(`stale-${index}`) },
  }));
}

function listingTransport(items: Array<Record<string, unknown>>) {
  return recordingTransport((request) => {
    if (request.url === TOKEN_ENDPOINT) return response({ access_token: "access-token" });
    if (request.method === "GET") return response({ items });
    if (request.method === "DELETE") return response({}, 204, "");
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

test("a destructive plan waits for approval and runs only once approved", async () => {
  const items = staleEvents(RECONCILIATION_DELETE_APPROVAL_THRESHOLD);

  const unapproved = listingTransport(items);
  const held = await client(unapproved.transport).reconcile([]);
  assert.deepEqual(held.pendingApproval, {
    creates: 0,
    updates: 0,
    deletes: RECONCILIATION_DELETE_APPROVAL_THRESHOLD,
    total: RECONCILIATION_DELETE_APPROVAL_THRESHOLD,
  });
  assert.equal(held.deleted, 0);
  assert.equal(unapproved.requests.filter((request) => request.method === "DELETE").length, 0);

  const declined = listingTransport(items);
  const refused = await client(declined.transport).reconcile([], {
    approvePlan: async () => false,
  });
  assert.ok(refused.pendingApproval);
  assert.equal(declined.requests.filter((request) => request.method === "DELETE").length, 0);

  const approved = listingTransport(items);
  const seen: ReconciliationSummary[] = [];
  const applied = await client(approved.transport).reconcile([], {
    approvePlan: async (summary) => {
      seen.push(summary);
      return true;
    },
  });
  assert.equal(applied.pendingApproval, undefined);
  assert.equal(applied.deleted, RECONCILIATION_DELETE_APPROVAL_THRESHOLD);
  assert.deepEqual(seen, [
    {
      creates: 0,
      updates: 0,
      deletes: RECONCILIATION_DELETE_APPROVAL_THRESHOLD,
      total: RECONCILIATION_DELETE_APPROVAL_THRESHOLD,
    },
  ]);
});

test("a large but non-destructive plan also waits for approval", async () => {
  const { requests, transport } = listingTransport([]);
  const events = Array.from({ length: RECONCILIATION_APPROVAL_THRESHOLD }, (_unused, index) =>
    desired(`bulk-${index}`, `Bulk ${index}`),
  );

  const stats = await client(transport).reconcile(events);

  assert.deepEqual(stats.pendingApproval, {
    creates: RECONCILIATION_APPROVAL_THRESHOLD,
    updates: 0,
    deletes: 0,
    total: RECONCILIATION_APPROVAL_THRESHOLD,
  });
  assert.equal(stats.created, 0);
  const creates = requests.filter(
    (request) => request.method === "POST" && request.url.includes("/calendar/v3/"),
  );
  assert.deepEqual(creates, []);
});

test("a small plan runs without asking for approval", async () => {
  const { requests, transport } = listingTransport(staleEvents(1));
  let asked = false;

  const stats = await client(transport).reconcile([], {
    approvePlan: async () => {
      asked = true;
      return true;
    },
  });

  assert.equal(asked, false);
  assert.equal(stats.deleted, 1);
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 1);
});

test("a plan past the change limit is refused even when it is approved", async () => {
  const { requests, transport } = listingTransport(staleEvents(3));

  await assert.rejects(
    client(transport).reconcile([], { maxChanges: 2, approvePlan: async () => true }),
    /3 changes exceed the per-sync limit of 2/,
  );
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 0);
});

test("deletes are held back while part of the vault is unreadable", async () => {
  const { requests, transport } = listingTransport(staleEvents(2));

  const stats = await client(transport).reconcile([], { allowDeletes: false });

  assert.deepEqual(stats, {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    deferredDeletes: 2,
  });
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 0);
});

test("revoking sends the refresh token to Google and surfaces failures", async () => {
  const { requests, transport } = recordingTransport(() => response({}, 200, ""));
  await revokeGoogleAuthorization("refresh-token", transport);

  const revocation = requests[0];
  assert.ok(revocation);
  assert.equal(revocation.url, REVOCATION_ENDPOINT);
  assert.equal(revocation.method, "POST");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(revocation.body))), {
    token: "refresh-token",
  });

  const failing = recordingTransport(() =>
    response({ error: "invalid_token" }, 400, JSON.stringify({ error: "invalid_token" })),
  );
  await assert.rejects(
    revokeGoogleAuthorization("refresh-token", failing.transport),
    /revocation failed \(400\): invalid_token/,
  );
});

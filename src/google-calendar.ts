import { requestUrl } from "obsidian";
import type { CalendarDateTime, VaultCalendarEvent } from "./event-parser";
import type { GoogleEvent } from "./sync-plan";
import { planReconciliation } from "./sync-plan";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** A plan touching at least this many events is reviewed by the user before it runs. */
export const RECONCILIATION_APPROVAL_THRESHOLD = 25;
/** A plan deleting at least this many events is reviewed by the user before it runs. */
export const RECONCILIATION_DELETE_APPROVAL_THRESHOLD = 5;
/** Default ceiling on how many events one sync may create, update, and delete. */
export const DEFAULT_MAX_CHANGES_PER_SYNC = 200;

export interface GoogleCredentials {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

export interface GoogleHttpRequest {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface GoogleHttpResponse {
  status: number;
  json: unknown;
  text: string;
}

export type GoogleTransport = (request: GoogleHttpRequest) => Promise<GoogleHttpResponse>;

export interface SyncStats {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Deletes that were planned but skipped because part of the vault could not be read. */
  deferredDeletes: number;
  /** Set when the plan was large or destructive and nobody approved it, so nothing ran. */
  pendingApproval?: ReconciliationSummary;
}

export interface ReconciliationSummary {
  creates: number;
  updates: number;
  deletes: number;
  total: number;
}

export interface ReconciliationOptions {
  affectedSourceKeys?: ReadonlySet<string>;
  /** Set to false while any note is unreadable, so unmatched remote events survive. */
  allowDeletes?: boolean;
  /** Refuse to run a plan larger than this. Defaults to DEFAULT_MAX_CHANGES_PER_SYNC. */
  maxChanges?: number;
  /** Asks the user to confirm a large or destructive plan. Omit for background syncs. */
  approvePlan?(summary: ReconciliationSummary): Promise<boolean>;
}

export interface GoogleCalendarInfo {
  id: string;
  name: string;
  primary: boolean;
}

export interface GoogleCalendarGateway {
  reconcile(
    desiredEvents: Iterable<VaultCalendarEvent>,
    options?: ReconciliationOptions,
  ): Promise<SyncStats>;
  listWritableCalendars(): Promise<GoogleCalendarInfo[]>;
  createCalendar(summary: string): Promise<GoogleCalendarInfo>;
}

interface GoogleCalendarList {
  items?: GoogleCalendarListEntry[];
  nextPageToken?: string;
}

interface GoogleCalendarListEntry {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  accessRole?: string;
}

interface GoogleCalendarResource {
  id?: string;
  summary?: string;
}

const WRITABLE_ACCESS_ROLES: Record<string, true> = {
  owner: true,
  writer: true,
  writerWithoutPrivateAccess: true,
};

interface GoogleEventList {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

interface EventBody {
  summary: string;
  start: CalendarDateTime;
  end: CalendarDateTime;
  recurrence?: string[];
  extendedProperties: {
    private: Record<string, string>;
  };
}

export class GoogleCalendarClient implements GoogleCalendarGateway {
  constructor(
    private readonly credentials: GoogleCredentials,
    private readonly calendarId: string,
    private readonly vaultId: string,
    private readonly transport: GoogleTransport = requestUrl,
  ) {}

  async reconcile(
    desiredEvents: Iterable<VaultCalendarEvent>,
    options: ReconciliationOptions = {},
  ): Promise<SyncStats> {
    const accessToken = await refreshAccessToken(this.credentials, this.transport);
    const remoteEvents = await this.listManagedEvents(accessToken);
    const plan = planReconciliation(desiredEvents, remoteEvents, options.affectedSourceKeys);
    const deferredDeletes = options.allowDeletes === false ? plan.deletes.length : 0;
    if (options.allowDeletes === false) plan.deletes = [];

    const summary = reconciliationSummary(plan);
    const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES_PER_SYNC;
    if (summary.total > maxChanges) {
      throw new Error(
        `Google Calendar sync stopped because ${summary.total} changes exceed the per-sync limit of ${maxChanges}. Review the notes that declare these events, then raise the limit in the plugin settings if the changes are expected.`,
      );
    }
    if (requiresApproval(summary) && !(await options.approvePlan?.(summary))) {
      return {
        created: 0,
        updated: 0,
        deleted: 0,
        unchanged: plan.unchanged,
        deferredDeletes,
        pendingApproval: summary,
      };
    }

    for (const event of plan.creates) await this.createEvent(accessToken, event);
    for (const update of plan.updates) {
      await this.updateEvent(accessToken, update.eventId, update.event);
    }
    for (const eventId of plan.deletes) await this.deleteEvent(accessToken, eventId);

    return {
      created: plan.creates.length,
      updated: plan.updates.length,
      deleted: plan.deletes.length,
      unchanged: plan.unchanged,
      deferredDeletes,
    };
  }

  async listWritableCalendars(): Promise<GoogleCalendarInfo[]> {
    const accessToken = await refreshAccessToken(this.credentials, this.transport);
    const calendars: GoogleCalendarInfo[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        maxResults: "250",
        minAccessRole: "writer",
        showHidden: "true",
      });
      if (pageToken) query.set("pageToken", pageToken);

      const response = await this.request<GoogleCalendarList>(
        accessToken,
        "GET",
        `/users/me/calendarList?${query.toString()}`,
      );
      for (const entry of response.items ?? []) {
        if (!entry.id || WRITABLE_ACCESS_ROLES[entry.accessRole ?? ""] !== true) continue;
        calendars.push({
          id: entry.id,
          name: entry.summaryOverride ?? entry.summary ?? entry.id,
          primary: entry.primary === true,
        });
      }
      pageToken = response.nextPageToken;
    } while (pageToken);

    return calendars.sort(
      (left, right) =>
        Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name),
    );
  }

  async createCalendar(summary: string): Promise<GoogleCalendarInfo> {
    const normalizedSummary = summary.trim();
    if (!normalizedSummary) throw new Error("Calendar name is required");

    const accessToken = await refreshAccessToken(this.credentials, this.transport);
    const calendar = await this.request<GoogleCalendarResource>(accessToken, "POST", "/calendars", {
      summary: normalizedSummary,
    });
    if (!calendar.id) {
      throw new Error("Google Calendar did not return the created calendar ID");
    }
    return {
      id: calendar.id,
      name: calendar.summary ?? normalizedSummary,
      primary: false,
    };
  }

  private async listManagedEvents(accessToken: string): Promise<GoogleEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        maxResults: "2500",
        showDeleted: "false",
        singleEvents: "false",
      });
      query.append("privateExtendedProperty", `obsidianVaultId=${this.vaultId}`);
      if (pageToken) query.set("pageToken", pageToken);

      const response = await this.request<GoogleEventList>(
        accessToken,
        "GET",
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${query.toString()}`,
      );
      events.push(
        ...(response.items ?? []).filter(
          (event) => event.status !== "cancelled" && isManagedEventForVault(event, this.vaultId),
        ),
      );
      pageToken = response.nextPageToken;
    } while (pageToken);
    return events;
  }

  private async createEvent(accessToken: string, event: VaultCalendarEvent): Promise<void> {
    await this.request(
      accessToken,
      "POST",
      `/calendars/${encodeURIComponent(this.calendarId)}/events`,
      this.eventBody(event),
    );
  }

  private async updateEvent(
    accessToken: string,
    eventId: string,
    event: VaultCalendarEvent,
  ): Promise<void> {
    const body = this.eventBody(event);
    body.recurrence ??= [];
    await this.request(
      accessToken,
      "PATCH",
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`,
      body,
    );
  }

  private async deleteEvent(accessToken: string, eventId: string): Promise<void> {
    const response = await this.transport({
      url: `${CALENDAR_API}/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`,
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });
    if (response.status !== 204 && response.status !== 404 && response.status !== 410) {
      throw apiError("Google Calendar delete failed", response.status, response.text);
    }
  }

  private eventBody(event: VaultCalendarEvent): EventBody {
    return {
      summary: event.summary,
      start: event.start,
      end: event.end,
      recurrence: event.recurrence,
      extendedProperties: {
        private: {
          obsidianGcal: "1",
          obsidianVaultId: this.vaultId,
          obsidianSourceKey: event.remoteSourceKey,
        },
      },
    };
  }

  private async request<T = unknown>(
    accessToken: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.transport({
      url: `${CALENDAR_API}${path}`,
      method,
      contentType: body === undefined ? undefined : "application/json",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw apiError(`Google Calendar ${method} failed`, response.status, response.text);
    }
    return response.json as T;
  }
}

export async function exchangeAuthorizationCode(
  input: {
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  transport: GoogleTransport = requestUrl,
): Promise<string> {
  const form = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  if (input.clientSecret) form.set("client_secret", input.clientSecret);
  const response = await transport({
    url: TOKEN_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form.toString(),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw apiError("Google OAuth authorization failed", response.status, response.text);
  }
  const token = response.json as { refresh_token?: string };
  if (!token.refresh_token) {
    throw new Error(
      "Google did not return a refresh token; revoke the app grant and authorize again",
    );
  }
  return token.refresh_token;
}

export async function revokeGoogleAuthorization(
  refreshToken: string,
  transport: GoogleTransport = requestUrl,
): Promise<void> {
  const response = await transport({
    url: REVOCATION_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ token: refreshToken }).toString(),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw apiError("Google OAuth revocation failed", response.status, response.text);
  }
}

async function refreshAccessToken(
  credentials: GoogleCredentials,
  transport: GoogleTransport,
): Promise<string> {
  const form = new URLSearchParams({
    client_id: credentials.clientId,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  });
  if (credentials.clientSecret) form.set("client_secret", credentials.clientSecret);
  const response = await transport({
    url: TOKEN_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form.toString(),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw apiError("Google OAuth token refresh failed", response.status, response.text);
  }
  const token = response.json as { access_token?: string };
  if (!token.access_token) throw new Error("Google OAuth response did not include an access token");
  return token.access_token;
}

function reconciliationSummary(plan: {
  creates: unknown[];
  updates: unknown[];
  deletes: unknown[];
}): ReconciliationSummary {
  const creates = plan.creates.length;
  const updates = plan.updates.length;
  const deletes = plan.deletes.length;
  return { creates, updates, deletes, total: creates + updates + deletes };
}

function requiresApproval(summary: ReconciliationSummary): boolean {
  return (
    summary.deletes >= RECONCILIATION_DELETE_APPROVAL_THRESHOLD ||
    summary.total >= RECONCILIATION_APPROVAL_THRESHOLD
  );
}

/**
 * Google treats repeated privateExtendedProperty filters as OR, so the listing query alone can
 * return events belonging to other vaults. Require both markers here before anything is planned.
 */
function isManagedEventForVault(event: GoogleEvent, vaultId: string): boolean {
  const properties = event.extendedProperties?.private;
  return properties?.obsidianGcal === "1" && properties.obsidianVaultId === vaultId;
}

function apiError(prefix: string, status: number, body: string): Error {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    detail = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? body);
  } catch {}
  return new Error(`${prefix} (${status}): ${detail}`);
}

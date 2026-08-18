import { randomUUID } from "node:crypto";
import {
  type App,
  type CachedMetadata,
  Notice,
  Plugin,
  type PluginManifest,
  TFile,
} from "obsidian";
import { type ParseIssue, parseVaultEvents, type VaultCalendarEvent } from "./event-parser";
import {
  GoogleCalendarClient,
  type GoogleCalendarGateway,
  type GoogleCalendarInfo,
  type GoogleCredentials,
  type SyncStats,
} from "./google-calendar";
import {
  defaultSettings,
  GoogleCalendarSettingTab,
  type GoogleCalendarSyncSettings,
} from "./settings";

const CHANGE_DEBOUNCE_MS = 1_000;

export interface PluginTimers {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(timer: number): void;
  setInterval(callback: () => void, milliseconds: number): number;
  clearInterval(timer: number): void;
}

export interface GoogleCalendarSyncPluginDependencies {
  createCalendarGateway?(
    credentials: GoogleCredentials,
    calendarId: string,
    vaultId: string,
  ): GoogleCalendarGateway;
  timers?: PluginTimers;
}

const WINDOW_TIMERS: PluginTimers = {
  setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimeout: (timer) => window.clearTimeout(timer),
  setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearInterval: (timer) => window.clearInterval(timer),
};

export default class GoogleCalendarSyncPlugin extends Plugin {
  override settings: GoogleCalendarSyncSettings = defaultSettings("");

  private eventsByPath = new Map<string, VaultCalendarEvent[]>();
  private pendingPaths = new Set<string>();
  private changeTimer: number | undefined;
  private periodicTimer: number | undefined;
  private syncTail: Promise<void> = Promise.resolve();
  private readonly createCalendarGateway: NonNullable<
    GoogleCalendarSyncPluginDependencies["createCalendarGateway"]
  >;
  private readonly timers: PluginTimers;

  constructor(
    app: App,
    manifest: PluginManifest,
    dependencies: GoogleCalendarSyncPluginDependencies = {},
  ) {
    super(app, manifest);
    this.createCalendarGateway =
      dependencies.createCalendarGateway ??
      ((credentials, calendarId, vaultId) =>
        new GoogleCalendarClient(credentials, calendarId, vaultId));
    this.timers = dependencies.timers ?? WINDOW_TIMERS;
  }

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new GoogleCalendarSettingTab(this.app, this));
    this.addCommand({
      id: "sync-google-calendar-now",
      name: "Sync Google Calendar now",
      callback: () => void this.syncNow(true),
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => this.schedulePath(file.path)),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") this.schedulePath(file.path);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") this.schedulePath(file.path);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.schedulePath(oldPath);
        this.schedulePath(file.path);
      }),
    );

    this.resetPeriodicSync();
    this.app.workspace.onLayoutReady(() => void this.syncNow(false));
  }

  override onunload(): void {
    if (this.changeTimer !== undefined) this.timers.clearTimeout(this.changeTimer);
    if (this.periodicTimer !== undefined) this.timers.clearInterval(this.periodicTimer);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  resetPeriodicSync(): void {
    if (this.periodicTimer !== undefined) this.timers.clearInterval(this.periodicTimer);
    const milliseconds = this.settings.syncIntervalMinutes * 60 * 1000;
    this.periodicTimer = this.timers.setInterval(() => void this.syncNow(false), milliseconds);
  }

  async syncNow(showNotice: boolean): Promise<void> {
    return this.serialize(async () => {
      try {
        const events = await this.scanVault();
        this.eventsByPath = events;
        if (!this.isConfigured()) {
          if (showNotice) new Notice("Configure and authorize Google Calendar Sync first");
          return;
        }

        const stats = await this.createClient().reconcile(flattenEvents(events));
        if (showNotice || changedEventCount(stats) > 0) {
          new Notice(formatStats(stats));
        }
      } catch (error) {
        new Notice(errorMessage(error), 10_000);
      }
    });
  }

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<GoogleCalendarSyncSettings> | null;
    const vaultId = stored?.vaultId || randomUUID();
    this.settings = Object.assign(defaultSettings(vaultId), stored ?? {}, {
      vaultId,
    });
  }

  private schedulePath(path: string): void {
    this.pendingPaths.add(path);
    if (this.changeTimer !== undefined) this.timers.clearTimeout(this.changeTimer);
    this.changeTimer = this.timers.setTimeout(() => {
      this.changeTimer = undefined;
      void this.flushPendingPaths();
    }, CHANGE_DEBOUNCE_MS);
  }

  private async flushPendingPaths(): Promise<void> {
    const paths = new Set(this.pendingPaths);
    this.pendingPaths.clear();
    await this.serialize(async () => {
      const affectedKeys = new Set<string>();
      const nextEventsByPath = new Map(this.eventsByPath);

      try {
        for (const path of paths) {
          for (const oldEvent of nextEventsByPath.get(path) ?? []) {
            affectedKeys.add(oldEvent.sourceKey);
          }

          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile) || file.extension !== "md") {
            nextEventsByPath.delete(path);
            continue;
          }

          const parsed = await this.parseFile(file, this.app.metadataCache.getFileCache(file));
          assertNoIssues(parsed.issues);
          nextEventsByPath.set(path, parsed.events);
          for (const event of parsed.events) affectedKeys.add(event.sourceKey);
        }
        assertUniqueSourceKeys(nextEventsByPath);
        this.eventsByPath = nextEventsByPath;

        if (!this.isConfigured() || affectedKeys.size === 0) return;
        const stats = await this.createClient().reconcile(
          flattenEvents(nextEventsByPath),
          affectedKeys,
        );
        if (changedEventCount(stats) > 0) new Notice(formatStats(stats));
      } catch (error) {
        new Notice(errorMessage(error), 10_000);
      }
    });
  }

  private async scanVault(): Promise<Map<string, VaultCalendarEvent[]>> {
    const eventsByPath = new Map<string, VaultCalendarEvent[]>();
    const issues: ParseIssue[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const parsed = await this.parseFile(file, this.app.metadataCache.getFileCache(file));
      eventsByPath.set(file.path, parsed.events);
      issues.push(...parsed.issues);
    }
    assertNoIssues(issues);
    assertUniqueSourceKeys(eventsByPath);
    return eventsByPath;
  }

  private async parseFile(
    file: TFile,
    metadata: CachedMetadata | null,
  ): Promise<{ events: VaultCalendarEvent[]; issues: ParseIssue[] }> {
    const content = await this.app.vault.cachedRead(file);
    const frontmatter = metadata?.frontmatter as Record<string, unknown> | undefined;
    if (!content.includes("#gcal:") && frontmatter?.gcal === undefined) {
      return { events: [], issues: [] };
    }
    return parseVaultEvents({
      path: file.path,
      basename: file.basename,
      content,
      frontmatter,
      timeZone: this.settings.timeZone,
    });
  }

  async listWritableCalendars(): Promise<GoogleCalendarInfo[]> {
    return this.createClient().listWritableCalendars();
  }

  async createCalendar(summary: string): Promise<GoogleCalendarInfo> {
    return this.createClient().createCalendar(summary);
  }

  private createClient(): GoogleCalendarGateway {
    const credentials: GoogleCredentials = {
      clientId: this.readSecret(this.settings.clientIdSecret, "OAuth client ID"),
      refreshToken: this.readSecret(this.settings.refreshTokenSecret, "refresh token"),
    };
    if (this.settings.clientSecretSecret) {
      credentials.clientSecret = this.readSecret(
        this.settings.clientSecretSecret,
        "OAuth client secret",
      );
    }
    return this.createCalendarGateway(credentials, this.settings.calendarId, this.settings.vaultId);
  }

  private readSecret(secretId: string, label: string): string {
    const value = secretId ? this.app.secretStorage.getSecret(secretId) : null;
    if (!value) throw new Error(`The configured ${label} secret is missing`);
    return value;
  }

  private isConfigured(): boolean {
    return Boolean(this.settings.clientIdSecret && this.settings.refreshTokenSecret);
  }

  private async serialize(operation: () => Promise<void>): Promise<void> {
    const queued = this.syncTail.then(operation, operation);
    this.syncTail = queued.catch(() => undefined);
    await queued;
  }
}

function flattenEvents(
  eventsByPath: ReadonlyMap<string, VaultCalendarEvent[]>,
): VaultCalendarEvent[] {
  return Array.from(eventsByPath.values()).flat();
}

function assertNoIssues(issues: ParseIssue[]): void {
  if (issues.length === 0) return;
  const details = issues
    .slice(0, 5)
    .map((issue) => `${issue.sourcePath} (${issue.location}): ${issue.message}`)
    .join("\n");
  const remaining = issues.length > 5 ? `\n…and ${issues.length - 5} more` : "";
  throw new Error(
    `Calendar sync stopped because event declarations are invalid:\n${details}${remaining}`,
  );
}

function assertUniqueSourceKeys(eventsByPath: ReadonlyMap<string, VaultCalendarEvent[]>): void {
  const seen = new Set<string>();
  for (const event of flattenEvents(eventsByPath)) {
    if (seen.has(event.sourceKey)) {
      throw new Error(`Calendar sync stopped because ${event.sourceKey} is duplicated`);
    }
    seen.add(event.sourceKey);
  }
}

function changedEventCount(stats: SyncStats): number {
  return stats.created + stats.updated + stats.deleted;
}

function formatStats(stats: SyncStats): string {
  return `Google Calendar synced: ${stats.created} created, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.unchanged} unchanged`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

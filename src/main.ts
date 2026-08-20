import {
  type App,
  type CachedMetadata,
  Notice,
  Plugin,
  type PluginManifest,
  TFile,
} from "obsidian";
import { confirmReconciliation } from "./confirm-modal";
import { directiveStatusExtension, directiveStatusPostProcessor } from "./directive-status";
import { type ParseIssue, parseVaultEvents, type VaultCalendarEvent } from "./event-parser";
import {
  DEFAULT_MAX_CHANGES_PER_SYNC,
  GcalClient,
  type GcalGateway,
  type GcalInfo,
  type GoogleCredentials,
  type ReconciliationSummary,
  type SyncStats,
} from "./gcal";
import {
  defaultSettings,
  deriveVaultId,
  GcalSettingTab,
  type GcalSyncSettings,
  resolveTimeZone,
} from "./settings";

const CHANGE_DEBOUNCE_MS = 1_000;
const MAX_REPORTED_ISSUES = 5;

/**
 * A note that fails to parse keeps its last valid events, so one broken declaration cannot strand
 * every other note. A note that has never parsed leaves its events unknown, which suppresses
 * deletes for that sync.
 */
interface VaultScan {
  eventsByPath: Map<string, VaultCalendarEvent[]>;
  issues: ParseIssue[];
  unknownPaths: Set<string>;
}

/**
 * What the editor shows next to a declaration. A note is synced all or nothing, so one unreadable
 * declaration marks itself "error" and holds its siblings at "blocked".
 */
export type DirectiveStatus = "synced" | "pending" | "blocked" | "error";

function placementKey(path: string, line: number, occurrence: number): string {
  return `${path}\u0000${line}\u0000${occurrence}`;
}

export interface PluginTimers {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(timer: number): void;
  setInterval(callback: () => void, milliseconds: number): number;
  clearInterval(timer: number): void;
}

export interface GcalSyncPluginDependencies {
  createCalendarGateway?: (
    this: void,
    credentials: GoogleCredentials,
    calendarId: string,
    vaultId: string,
  ) => GcalGateway;
  timers?: PluginTimers;
  confirmPlan?: (this: void, summary: ReconciliationSummary) => Promise<boolean>;
}

const WINDOW_TIMERS: PluginTimers = {
  setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimeout: (timer) => window.clearTimeout(timer),
  setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearInterval: (timer) => window.clearInterval(timer),
};

export default class GcalSyncPlugin extends Plugin {
  override settings: GcalSyncSettings = defaultSettings("");

  private eventsByPath = new Map<string, VaultCalendarEvent[]>();
  private pendingPaths = new Set<string>();
  private changeTimer: number | undefined;
  private periodicTimer: number | undefined;
  private syncTail: Promise<void> = Promise.resolve();
  private lastPendingApproval = "";
  private syncedSourceKeys = new Set<string>();
  private erroredPaths = new Set<string>();
  private erroredPlacements = new Set<string>();
  private sourceKeyByPlacement = new Map<string, string>();
  private readonly statusListeners = new Set<() => void>();
  private readonly createCalendarGateway: NonNullable<
    GcalSyncPluginDependencies["createCalendarGateway"]
  >;
  private readonly timers: PluginTimers;
  private readonly confirmPlan: NonNullable<GcalSyncPluginDependencies["confirmPlan"]>;

  constructor(app: App, manifest: PluginManifest, dependencies: GcalSyncPluginDependencies = {}) {
    super(app, manifest);
    this.createCalendarGateway =
      dependencies.createCalendarGateway ??
      ((credentials, calendarId, vaultId) => new GcalClient(credentials, calendarId, vaultId));
    this.timers = dependencies.timers ?? WINDOW_TIMERS;
    this.confirmPlan =
      dependencies.confirmPlan ?? ((summary) => confirmReconciliation(this.app, summary));
  }

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new GcalSettingTab(this.app, this));
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
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

    this.registerEditorExtension(directiveStatusExtension(this));
    this.registerMarkdownPostProcessor(directiveStatusPostProcessor(this));

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

  directiveStatus(path: string, line: number, occurrence: number): DirectiveStatus | undefined {
    const key = placementKey(path, line, occurrence);
    if (this.erroredPlacements.has(key)) return "error";
    if (this.erroredPaths.has(path)) return "blocked";

    const sourceKey = this.sourceKeyByPlacement.get(key);
    if (!sourceKey) return undefined;
    return this.syncedSourceKeys.has(sourceKey) ? "synced" : "pending";
  }

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private publishStatus(scan: VaultScan, affectedKeys?: ReadonlySet<string>): void {
    const errored = new Set(scan.unknownPaths);
    const erroredPlacements = new Set<string>();
    for (const issue of scan.issues) {
      errored.add(issue.sourcePath);
      if (!issue.placement) continue;
      const { line, occurrence } = issue.placement;
      erroredPlacements.add(placementKey(issue.sourcePath, line, occurrence));
    }
    this.erroredPaths = errored;
    this.erroredPlacements = erroredPlacements;

    this.sourceKeyByPlacement = new Map();
    for (const [path, events] of scan.eventsByPath) {
      for (const event of events) {
        if (!event.placement) continue;
        const { line, occurrence } = event.placement;
        this.sourceKeyByPlacement.set(placementKey(path, line, occurrence), event.sourceKey);
      }
    }

    if (affectedKeys) for (const key of affectedKeys) this.syncedSourceKeys.delete(key);
    for (const listener of this.statusListeners) listener();
  }

  private recordSynced(keys: readonly string[], replaceAll: boolean): void {
    if (replaceAll) this.syncedSourceKeys = new Set(keys);
    else for (const key of keys) this.syncedSourceKeys.add(key);
    for (const listener of this.statusListeners) listener();
  }

  resetPeriodicSync(): void {
    if (this.periodicTimer !== undefined) this.timers.clearInterval(this.periodicTimer);
    const milliseconds = this.settings.syncIntervalMinutes * 60 * 1000;
    this.periodicTimer = this.timers.setInterval(() => void this.syncNow(false), milliseconds);
  }

  /**
   * Reconciles the whole vault. Interactive syncs may prompt the user to approve a large or
   * destructive plan; background syncs report it and leave the calendar untouched.
   */
  async syncNow(interactive: boolean): Promise<void> {
    return this.serialize(async () => {
      try {
        const scan = await this.scanVault();
        this.eventsByPath = scan.eventsByPath;
        this.publishStatus(scan);
        this.reportIssues(scan.issues);
        if (!this.isConfigured()) {
          if (interactive) new Notice("Configure and authorize Google Calendar Sync first");
          return;
        }

        const stats = await this.createClient().reconcile(flattenEvents(scan.eventsByPath), {
          allowDeletes: scan.unknownPaths.size === 0,
          maxChanges: this.settings.maxChangesPerSync,
          ...(interactive ? { approvePlan: this.confirmPlan } : {}),
        });
        this.recordSynced(stats.syncedSourceKeys, true);
        this.reportStats(stats, interactive);
      } catch (error) {
        new Notice(errorMessage(error), 10_000);
      }
    });
  }

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<GcalSyncSettings> | null;
    const vaultId = stored?.vaultId || deriveVaultId(this.app.vault.getName());
    const defaults = defaultSettings(vaultId);
    const settings = Object.assign(defaults, stored ?? {}, { vaultId });
    settings.syncFolders = Array.isArray(settings.syncFolders)
      ? settings.syncFolders.filter((folder) => typeof folder === "string" && folder.length > 0)
      : [];
    if (!Number.isInteger(settings.maxChangesPerSync) || settings.maxChangesPerSync < 1) {
      settings.maxChangesPerSync = DEFAULT_MAX_CHANGES_PER_SYNC;
    }
    this.settings = settings;
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
      try {
        const scan: VaultScan = {
          eventsByPath: new Map(this.eventsByPath),
          issues: [],
          unknownPaths: new Set(),
        };
        const affectedKeys = new Set<string>();

        for (const path of paths) {
          for (const oldEvent of scan.eventsByPath.get(path) ?? []) {
            addAffectedKeys(affectedKeys, oldEvent);
          }
          scan.eventsByPath.delete(path);

          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile) || file.extension !== "md" || !this.isSyncedPath(path)) {
            continue;
          }

          await this.collectFile(scan, file);
          for (const event of scan.eventsByPath.get(path) ?? []) {
            addAffectedKeys(affectedKeys, event);
          }
        }
        dropDuplicateSourceKeys(scan);
        this.eventsByPath = scan.eventsByPath;
        this.publishStatus(scan, affectedKeys);
        this.reportIssues(scan.issues);

        if (!this.isConfigured() || affectedKeys.size === 0) return;
        const stats = await this.createClient().reconcile(flattenEvents(scan.eventsByPath), {
          affectedSourceKeys: affectedKeys,
          allowDeletes: scan.unknownPaths.size === 0,
          maxChanges: this.settings.maxChangesPerSync,
        });
        this.recordSynced(stats.syncedSourceKeys, false);
        this.reportStats(stats, false);
      } catch (error) {
        new Notice(errorMessage(error), 10_000);
      }
    });
  }

  private async scanVault(): Promise<VaultScan> {
    const scan: VaultScan = { eventsByPath: new Map(), issues: [], unknownPaths: new Set() };
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isSyncedPath(file.path)) continue;
      await this.collectFile(scan, file);
    }
    dropDuplicateSourceKeys(scan);
    return scan;
  }

  private async collectFile(scan: VaultScan, file: TFile): Promise<void> {
    const parsed = await this.parseFile(file, this.app.metadataCache.getFileCache(file));
    if (parsed.issues.length === 0) {
      scan.eventsByPath.set(file.path, parsed.events);
      return;
    }

    scan.issues.push(...parsed.issues);
    const retained = this.eventsByPath.get(file.path);
    if (retained) scan.eventsByPath.set(file.path, retained);
    else scan.unknownPaths.add(file.path);
  }

  private async parseFile(
    file: TFile,
    metadata: CachedMetadata | null,
  ): Promise<{ events: VaultCalendarEvent[]; issues: ParseIssue[] }> {
    const content = await this.app.vault.cachedRead(file);
    const frontmatter = metadata?.frontmatter;
    if (!content.includes("gcal:") && frontmatter?.gcal === undefined) {
      return { events: [], issues: [] };
    }
    return parseVaultEvents({
      path: file.path,
      basename: file.basename,
      content,
      frontmatter,
      timeZone: resolveTimeZone(this.settings.timeZone),
      vaultId: this.settings.vaultId,
    });
  }

  private isSyncedPath(path: string): boolean {
    const folders = this.settings.syncFolders;
    if (folders.length === 0) return true;
    return folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
  }

  private reportIssues(issues: ParseIssue[]): void {
    if (issues.length === 0) return;
    new Notice(formatIssues(issues), 10_000);
  }

  private reportStats(stats: SyncStats, interactive: boolean): void {
    if (stats.pendingApproval) {
      const signature = formatSummary(stats.pendingApproval);
      if (interactive) {
        new Notice("Google Calendar sync cancelled; no events were changed");
        return;
      }
      if (signature === this.lastPendingApproval) return;
      this.lastPendingApproval = signature;
      new Notice(
        `Google Calendar sync needs review (${signature}). Run the "Sync now" command to approve it.`,
        10_000,
      );
      return;
    }

    this.lastPendingApproval = "";
    if (interactive || changedEventCount(stats) > 0) new Notice(formatStats(stats));
  }

  async listWritableCalendars(): Promise<GcalInfo[]> {
    return this.createClient().listWritableCalendars();
  }

  async createCalendar(summary: string): Promise<GcalInfo> {
    return this.createClient().createCalendar(summary);
  }

  private createClient(): GcalGateway {
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

function addAffectedKeys(keys: Set<string>, event: VaultCalendarEvent): void {
  keys.add(event.sourceKey);
  keys.add(event.remoteSourceKey);
}

/** Drops events whose key another note already claimed, so one note cannot hijack another's event. */
function dropDuplicateSourceKeys(scan: VaultScan): void {
  const seen = new Set<string>();
  for (const [path, events] of scan.eventsByPath) {
    const unique = events.filter((event) => {
      if (!seen.has(event.sourceKey)) {
        seen.add(event.sourceKey);
        return true;
      }
      scan.issues.push({
        sourcePath: path,
        location: event.sourceKey,
        message: "Another note already declares this event key; this declaration was skipped",
      });
      scan.unknownPaths.add(path);
      return false;
    });
    if (unique.length !== events.length) scan.eventsByPath.set(path, unique);
  }
}

function formatIssues(issues: ParseIssue[]): string {
  const details = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.sourcePath} (${issue.location}): ${issue.message}`)
    .join("\n");
  const remaining =
    issues.length > MAX_REPORTED_ISSUES ? `\n…and ${issues.length - MAX_REPORTED_ISSUES} more` : "";
  return `Some event declarations were skipped; their notes keep their last synced events:\n${details}${remaining}`;
}

function changedEventCount(stats: SyncStats): number {
  return stats.created + stats.updated + stats.deleted;
}

function formatSummary(summary: ReconciliationSummary): string {
  return `${summary.creates} to create, ${summary.updates} to update, ${summary.deletes} to delete`;
}

function formatStats(stats: SyncStats): string {
  const deferred =
    stats.deferredDeletes > 0
      ? `, ${stats.deferredDeletes} deletion(s) held back until every note parses`
      : "";
  return `Google Calendar synced: ${stats.created} created, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.unchanged} unchanged${deferred}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

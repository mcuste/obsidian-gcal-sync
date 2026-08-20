import assert from "node:assert/strict";
import test from "node:test";
import type { App, PluginManifest } from "obsidian";
import { TFile } from "obsidian";
import { makeRemoteSourceKey, type VaultCalendarEvent } from "../src/event-parser";
import type {
  GcalGateway,
  GcalInfo,
  ReconciliationOptions,
  ReconciliationSummary,
  SyncStats,
} from "../src/gcal";
import { DEFAULT_MAX_CHANGES_PER_SYNC } from "../src/gcal";
import GcalSyncPlugin, { type PluginTimers } from "../src/main";
import { deriveVaultId, type GcalSyncSettings } from "../src/settings";
import { type GoogleEvent, planReconciliation } from "../src/sync-plan";

const RuntimeTFile = TFile as unknown as new (path: string) => TFile;
/** The plugin takes its vault ID from the vault name, so the tests take the same one. */
const VAULT_ID = deriveVaultId("Notes");

/** The key the plugin stores on Google for a note-local source key. */
function remoteKey(sourceKey: string): string {
  return makeRemoteSourceKey(VAULT_ID, sourceKey);
}
const MANIFEST = {
  id: "gcal-sync",
  name: "Google Calendar Sync",
  version: "0.1.0",
  minAppVersion: "1.0.0",
  description: "Test manifest",
  author: "Test",
  isDesktopOnly: true,
} as PluginManifest;

class TestEmitter {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();

  on(event: string, listener: (...args: unknown[]) => unknown): object {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return {};
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class TestVault extends TestEmitter {
  private readonly files = new Map<string, { file: TFile; content: string }>();

  getName(): string {
    return "Notes";
  }

  set(path: string, content: string): TFile {
    const file = new RuntimeTFile(path);
    this.files.set(path, { file, content });
    return file;
  }

  remove(path: string): TFile {
    const entry = this.files.get(path);
    assert.ok(entry, `Expected ${path} to exist`);
    this.files.delete(path);
    return entry.file;
  }

  rename(oldPath: string, newPath: string, content: string): TFile {
    this.remove(oldPath);
    return this.set(newPath, content);
  }

  getMarkdownFiles(): TFile[] {
    return Array.from(this.files.values(), ({ file }) => file);
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.files.get(path)?.file ?? null;
  }

  async cachedRead(file: TFile): Promise<string> {
    const content = this.files.get(file.path)?.content;
    if (content === undefined) throw new Error(`Expected content for ${file.path}`);
    return content;
  }
}

class TestWorkspace {
  private readonly callbacks: Array<() => void> = [];

  onLayoutReady(callback: () => void): void {
    this.callbacks.push(callback);
  }

  ready(): void {
    for (const callback of this.callbacks.splice(0)) callback();
  }
}

class TestTimers implements PluginTimers {
  private nextId = 1;
  private readonly timeouts = new Map<number, () => void>();
  private readonly intervals = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = this.nextId++;
    this.timeouts.set(id, callback);
    return id;
  }

  clearTimeout(timer: number): void {
    this.timeouts.delete(timer);
  }

  setInterval(callback: () => void): number {
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id;
  }

  clearInterval(timer: number): void {
    this.intervals.delete(timer);
  }

  runTimeouts(): void {
    const callbacks = Array.from(this.timeouts.values());
    this.timeouts.clear();
    for (const callback of callbacks) callback();
  }

  runIntervals(): void {
    for (const callback of this.intervals.values()) callback();
  }
}

/**
 * Stands in for the whole calendar client, so it holds one vault's events only: it never filters by
 * vault ID the way the real listing does. Vault scoping is covered in the GcalClient tests.
 */
class InMemoryGateway implements GcalGateway {
  private createdId = 0;
  private completed = 0;
  private events: GoogleEvent[];
  private readonly completionWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(events: GoogleEvent[] = []) {
    this.events = [...events];
  }

  readonly options: ReconciliationOptions[] = [];

  async reconcile(
    desiredEvents: Iterable<VaultCalendarEvent>,
    options: ReconciliationOptions = {},
  ): Promise<SyncStats> {
    this.options.push(options);
    const plan = planReconciliation(desiredEvents, this.events, options.affectedSourceKeys);
    const deferredDeletes = options.allowDeletes === false ? plan.deletes.length : 0;
    if (options.allowDeletes === false) plan.deletes = [];
    const deletedIds = new Set(plan.deletes);
    this.events = this.events.filter((event) => !event.id || !deletedIds.has(event.id));

    for (const update of plan.updates) {
      this.events = this.events.filter((event) => event.id !== update.eventId);
      this.events.push(toRemote(update.event, update.eventId));
    }
    for (const event of plan.creates) {
      this.createdId += 1;
      this.events.push(toRemote(event, `created-${this.createdId}`));
    }

    this.completed += 1;
    for (const waiter of this.completionWaiters.splice(0)) {
      if (this.completed >= waiter.count) waiter.resolve();
      else this.completionWaiters.push(waiter);
    }
    return {
      created: plan.creates.length,
      updated: plan.updates.length,
      deleted: plan.deletes.length,
      duplicatesRemoved: plan.duplicates.length,
      unchanged: plan.unchanged.length,
      deferredDeletes,
      syncedSourceKeys: [
        ...plan.creates.map((event) => event.sourceKey),
        ...plan.updates.map((update) => update.event.sourceKey),
        ...plan.unchanged,
      ],
    };
  }

  async listWritableCalendars(): Promise<GcalInfo[]> {
    return [];
  }

  async createCalendar(summary: string): Promise<GcalInfo> {
    return { id: "created-calendar", name: summary, primary: false };
  }

  addRemote(event: GoogleEvent): void {
    this.events.push(event);
  }

  state(): Array<[string, string | undefined, string | undefined]> {
    return this.events
      .map(
        (event) =>
          [event.extendedProperties?.private?.obsidianSourceKey ?? "", event.summary, event.id] as [
            string,
            string | undefined,
            string | undefined,
          ],
      )
      .sort(([left], [right]) => left.localeCompare(right));
  }

  waitForCompleted(count: number): Promise<void> {
    if (this.completed >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.completionWaiters.push({ count, resolve });
    return promise;
  }
}

class BlockingGateway implements GcalGateway {
  starts = 0;
  completions = 0;
  active = 0;
  maxActive = 0;
  readonly kinds: string[] = [];
  private readonly releases: Array<() => void> = [];
  private readonly startWaiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly completionWaiters: Array<{ count: number; resolve: () => void }> = [];

  async reconcile(
    _desiredEvents: Iterable<VaultCalendarEvent>,
    options: ReconciliationOptions = {},
  ): Promise<SyncStats> {
    this.starts += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.kinds.push(options.affectedSourceKeys ? "incremental" : "full");
    this.resolveWaiters(this.startWaiters, this.starts);

    const gate = Promise.withResolvers<void>();
    this.releases.push(gate.resolve);
    await gate.promise;

    this.active -= 1;
    this.completions += 1;
    this.resolveWaiters(this.completionWaiters, this.completions);
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      duplicatesRemoved: 0,
      unchanged: 0,
      deferredDeletes: 0,
      syncedSourceKeys: [],
    };
  }

  async listWritableCalendars(): Promise<GcalInfo[]> {
    return [];
  }

  async createCalendar(summary: string): Promise<GcalInfo> {
    return { id: "created-calendar", name: summary, primary: false };
  }

  release(): void {
    const resolve = this.releases.shift();
    assert.ok(resolve, "Expected a blocked reconciliation");
    resolve();
  }

  waitForStarts(count: number): Promise<void> {
    return this.waitFor(this.startWaiters, this.starts, count);
  }

  waitForCompletions(count: number): Promise<void> {
    return this.waitFor(this.completionWaiters, this.completions, count);
  }

  private waitFor(
    waiters: Array<{ count: number; resolve: () => void }>,
    current: number,
    count: number,
  ): Promise<void> {
    if (current >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ count, resolve });
    return promise;
  }

  private resolveWaiters(
    waiters: Array<{ count: number; resolve: () => void }>,
    current: number,
  ): void {
    for (const waiter of waiters.splice(0)) {
      if (current >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
  }
}

function managed(id: string, sourceKey: string, summary: string): GoogleEvent {
  return {
    id,
    summary,
    start: { date: "2026-08-18" },
    end: { date: "2026-08-19" },
    extendedProperties: { private: { obsidianSourceKey: remoteKey(sourceKey) } },
  };
}

function toRemote(event: VaultCalendarEvent, id: string): GoogleEvent {
  return {
    id,
    summary: event.summary,
    start: event.start,
    end: event.end,
    recurrence: event.recurrence,
    extendedProperties: { private: { obsidianSourceKey: event.remoteSourceKey } },
  };
}

/** Maps the gateway's hashed keys back to the note-local keys the tests declare. */
function sourceKeys(
  gateway: InMemoryGateway,
): Array<[string, string | undefined, string | undefined]> {
  return gateway
    .state()
    .map(
      ([remote, summary, id]) =>
        [KNOWN_SOURCE_KEYS.get(remote) ?? remote, summary, id] as [
          string,
          string | undefined,
          string | undefined,
        ],
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

const KNOWN_SOURCE_KEYS = new Map(
  [
    "New.md::line-1-1",
    "Update.md::line-1-1",
    "Removed.md::stale",
    "Other.md::event",
    "Old.md::line-1-1",
    "New.md::line-1-1",
    "Delete.md::line-1-1",
    "Valid.md::line-1-1",
    "Notes.md::line-1-1",
    "Broken.md::line-1-1",
    "Calendar/Team.md::line-1-1",
    "Shared/Injected.md::line-1-1",
    "Shared/Later.md::line-1-1",
  ].map((sourceKey) => [remoteKey(sourceKey), sourceKey] as const),
);
function setup(
  gateway: GcalGateway,
  storedSettings: Partial<GcalSyncSettings> = {},
  confirmPlan?: (summary: ReconciliationSummary) => Promise<boolean>,
): {
  plugin: GcalSyncPlugin;
  vault: TestVault;
  workspace: TestWorkspace;
  timers: TestTimers;
  vaultIds: string[];
} {
  const vault = new TestVault();
  const workspace = new TestWorkspace();
  const timers = new TestTimers();
  const metadataCache = new TestEmitter() as TestEmitter & {
    getFileCache(file: TFile): null;
  };
  metadataCache.getFileCache = () => null;
  const app = {
    vault,
    workspace,
    metadataCache,
    secretStorage: {
      getSecret(id: string) {
        return id === "client-id-secret" ? "client-id" : "refresh-token";
      },
    },
  } as unknown as App;
  const vaultIds: string[] = [];
  const plugin = new GcalSyncPlugin(app, MANIFEST, {
    createCalendarGateway: (_credentials, _calendarId, vaultId) => {
      vaultIds.push(vaultId);
      return gateway;
    },
    timers,
    ...(confirmPlan ? { confirmPlan } : {}),
  });
  plugin.loadData = async () => ({
    calendarId: "calendar-id",
    clientIdSecret: "client-id-secret",
    refreshTokenSecret: "refresh-token-secret",
    syncIntervalMinutes: 15,
    timeZone: "UTC",
    vaultId: VAULT_ID,
    ...storedSettings,
  });
  return { plugin, vault, workspace, timers, vaultIds };
}

test("full lifecycle scan creates, updates, and deletes managed events", async () => {
  const gateway = new InMemoryGateway([
    managed("update-id", "Update.md::line-1-1", "Old title"),
    managed("stale-id", "Removed.md::stale", "Stale"),
  ]);
  const { plugin, vault, workspace } = setup(gateway);
  vault.set("New.md", "New `gcal:2026-08-18`");
  vault.set("Update.md", "Updated `gcal:2026-08-18`");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);

  assert.deepEqual(sourceKeys(gateway), [
    ["New.md::line-1-1", "New", "created-1"],
    ["Update.md::line-1-1", "Updated", "update-id"],
  ]);
  plugin.onunload();
});

test("deleting a note removes cached source keys without touching unrelated events", async () => {
  const gateway = new InMemoryGateway();
  const { plugin, vault, workspace, timers } = setup(gateway);
  vault.set("Delete.md", "Delete me `gcal:2026-08-18`");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);
  gateway.addRemote(managed("unrelated-id", "Other.md::event", "Other"));

  const deletedFile = vault.remove("Delete.md");
  vault.emit("delete", deletedFile);
  timers.runTimeouts();
  await gateway.waitForCompleted(2);

  assert.deepEqual(sourceKeys(gateway), [["Other.md::event", "Other", "unrelated-id"]]);
  plugin.onunload();
});

test("renaming a note reconciles both its old and new paths", async () => {
  const gateway = new InMemoryGateway();
  const { plugin, vault, workspace, timers } = setup(gateway);
  vault.set("Old.md", "Before `gcal:2026-08-18`");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);
  gateway.addRemote(managed("unrelated-id", "Other.md::event", "Other"));

  const renamedFile = vault.rename("Old.md", "New.md", "After `gcal:2026-08-18`");
  vault.emit("rename", renamedFile, "Old.md");
  timers.runTimeouts();
  await gateway.waitForCompleted(2);

  assert.deepEqual(sourceKeys(gateway), [
    ["New.md::line-1-1", "After", "created-2"],
    ["Other.md::event", "Other", "unrelated-id"],
  ]);
  plugin.onunload();
});

test("a note that has never parsed does not block others and suspends deletes", async () => {
  const gateway = new InMemoryGateway([managed("stale-id", "Removed.md::stale", "Stale")]);
  const { plugin, vault } = setup(gateway);
  vault.set("Valid.md", "Would create `gcal:2026-08-18`");
  vault.set("Broken.md", "Broken `gcal:not-a-date`");

  await plugin.onload();
  await plugin.syncNow(false);

  assert.deepEqual(sourceKeys(gateway), [
    ["Removed.md::stale", "Stale", "stale-id"],
    ["Valid.md::line-1-1", "Would create", "created-1"],
  ]);
  assert.equal(gateway.options.at(-1)?.allowDeletes, false);
  plugin.onunload();
});

test("a note that becomes invalid keeps the events it last synced", async () => {
  const gateway = new InMemoryGateway();
  const { plugin, vault, workspace, timers } = setup(gateway);
  const file = vault.set("Notes.md", "Standup `gcal:2026-08-18`");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);
  assert.deepEqual(sourceKeys(gateway), [["Notes.md::line-1-1", "Standup", "created-1"]]);

  vault.set("Notes.md", "Standup `gcal:2026-08-18`\nBroken `gcal:not-a-date`");
  vault.emit("create", file);
  timers.runTimeouts();
  await gateway.waitForCompleted(2);

  assert.deepEqual(sourceKeys(gateway), [["Notes.md::line-1-1", "Standup", "created-1"]]);
  plugin.onunload();
});

test("full syncs resume deleting once every note parses again", async () => {
  const gateway = new InMemoryGateway([managed("stale-id", "Removed.md::stale", "Stale")]);
  const { plugin, vault } = setup(gateway);
  vault.set("Broken.md", "Broken `gcal:not-a-date`");

  await plugin.onload();
  await plugin.syncNow(false);
  assert.deepEqual(sourceKeys(gateway), [["Removed.md::stale", "Stale", "stale-id"]]);

  vault.set("Broken.md", "Fixed `gcal:2026-08-18`");
  await plugin.syncNow(false);

  assert.deepEqual(sourceKeys(gateway), [["Broken.md::line-1-1", "Fixed", "created-1"]]);
  assert.equal(gateway.options.at(-1)?.allowDeletes, true);
  plugin.onunload();
});

test("notes outside the synced folders never reach the calendar", async () => {
  const gateway = new InMemoryGateway();
  const { plugin, vault, workspace, timers } = setup(gateway, { syncFolders: ["Calendar"] });
  vault.set("Calendar/Team.md", "Standup `gcal:2026-08-18`");
  vault.set("Shared/Injected.md", "Injected `gcal:2026-08-18`");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);
  assert.deepEqual(sourceKeys(gateway), [["Calendar/Team.md::line-1-1", "Standup", "created-1"]]);

  const outside = vault.set("Shared/Later.md", "Later `gcal:2026-08-19`");
  vault.emit("create", outside);
  timers.runTimeouts();

  await plugin.syncNow(false);
  assert.deepEqual(sourceKeys(gateway), [["Calendar/Team.md::line-1-1", "Standup", "created-1"]]);
  plugin.onunload();
});

test("only user-initiated syncs can approve a large or destructive plan", async () => {
  const gateway = new InMemoryGateway();
  const confirmPlan = async (): Promise<boolean> => true;
  const { plugin, vault, workspace, timers } = setup(
    gateway,
    { maxChangesPerSync: 42 },
    confirmPlan,
  );
  const file = vault.set("Notes.md", "Standup `gcal:2026-08-18`");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);
  assert.equal(gateway.options.at(-1)?.approvePlan, undefined, "startup syncs cannot prompt");
  assert.equal(gateway.options.at(-1)?.maxChanges, 42);

  vault.set("Notes.md", "Renamed `gcal:2026-08-18`");
  vault.emit("create", file);
  timers.runTimeouts();
  await gateway.waitForCompleted(2);
  assert.equal(gateway.options.at(-1)?.approvePlan, undefined, "file changes cannot prompt");

  await plugin.syncNow(true);
  assert.equal(gateway.options.at(-1)?.approvePlan, confirmPlan);
  plugin.onunload();
});

test("a stored change limit that is not a positive integer falls back to the default", async () => {
  const gateway = new InMemoryGateway();
  const { plugin, vault } = setup(gateway, {
    maxChangesPerSync: 0,
    syncFolders: undefined as unknown as string[],
  });
  vault.set("Notes.md", "Standup `gcal:2026-08-18`");

  await plugin.onload();
  await plugin.syncNow(false);

  assert.equal(gateway.options.at(-1)?.maxChanges, DEFAULT_MAX_CHANGES_PER_SYNC);
  assert.deepEqual(sourceKeys(gateway), [["Notes.md::line-1-1", "Standup", "created-1"]]);
  plugin.onunload();
});

test("manual, periodic, and incremental sync triggers run serially", async () => {
  const gateway = new BlockingGateway();
  const { plugin, vault, timers } = setup(gateway);
  vault.set("Initial.md", "Initial `gcal:2026-08-18`");
  await plugin.onload();

  const manualSync = plugin.syncNow(false);
  await gateway.waitForStarts(1);
  timers.runIntervals();
  const createdFile = vault.set("Created.md", "Created `gcal:2026-08-19`");
  vault.emit("create", createdFile);
  timers.runTimeouts();

  assert.equal(gateway.starts, 1);
  assert.equal(gateway.active, 1);
  gateway.release();
  await gateway.waitForStarts(2);
  assert.equal(gateway.active, 1);
  gateway.release();
  await gateway.waitForStarts(3);
  assert.equal(gateway.active, 1);
  gateway.release();
  await gateway.waitForCompletions(3);
  await manualSync;

  assert.equal(gateway.maxActive, 1);
  assert.deepEqual(gateway.kinds, ["full", "full", "incremental"]);
  plugin.onunload();
});

/** A location the plugin's data.json was never synced to, so no vault ID is stored. */
function storeWithoutVaultId(): Partial<GcalSyncSettings> {
  return {
    calendarId: "calendar-id",
    clientIdSecret: "client-id-secret",
    refreshTokenSecret: "refresh-token-secret",
  };
}

test("a vault opened without stored plugin data stamps the ID it used before", async () => {
  const first = setup(new InMemoryGateway());
  first.plugin.loadData = async () => storeWithoutVaultId();
  await first.plugin.onload();
  await first.plugin.syncNow(false);
  first.plugin.onunload();

  const second = setup(new InMemoryGateway());
  second.plugin.loadData = async () => storeWithoutVaultId();
  await second.plugin.onload();
  await second.plugin.syncNow(false);

  assert.equal(first.vaultIds.length, 1);
  assert.deepEqual(second.vaultIds, first.vaultIds);
  second.plugin.onunload();
});

test("a vault ID stored by an earlier release is replaced by the one the name gives", async () => {
  const gateway = new InMemoryGateway();
  const { plugin, vault, vaultIds } = setup(gateway, { vaultId: "random-id-from-0.3.0" });
  vault.set("Notes.md", "Standup `gcal:2026-08-18`");

  await plugin.onload();
  await plugin.syncNow(false);

  assert.deepEqual(vaultIds, [VAULT_ID]);
  assert.deepEqual(sourceKeys(gateway), [["Notes.md::line-1-1", "Standup", "created-1"]]);
  plugin.onunload();
});

import assert from "node:assert/strict";
import test from "node:test";
import type { App, PluginManifest } from "obsidian";
import { TFile } from "obsidian";
import type { VaultCalendarEvent } from "../src/event-parser";
import type { GoogleCalendarGateway, GoogleCalendarInfo, SyncStats } from "../src/google-calendar";
import GoogleCalendarSyncPlugin, { type PluginTimers } from "../src/main";
import { type GoogleEvent, planReconciliation } from "../src/sync-plan";

const RuntimeTFile = TFile as unknown as new (path: string) => TFile;
const MANIFEST = {
  id: "obsidian-gcloud",
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

class InMemoryGateway implements GoogleCalendarGateway {
  private createdId = 0;
  private completed = 0;
  private events: GoogleEvent[];
  private readonly completionWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(events: GoogleEvent[] = []) {
    this.events = [...events];
  }

  async reconcile(
    desiredEvents: Iterable<VaultCalendarEvent>,
    affectedSourceKeys?: ReadonlySet<string>,
  ): Promise<SyncStats> {
    const plan = planReconciliation(desiredEvents, this.events, affectedSourceKeys);
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
      unchanged: plan.unchanged,
    };
  }

  async listWritableCalendars(): Promise<GoogleCalendarInfo[]> {
    return [];
  }

  async createCalendar(summary: string): Promise<GoogleCalendarInfo> {
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

class BlockingGateway implements GoogleCalendarGateway {
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
    affectedSourceKeys?: ReadonlySet<string>,
  ): Promise<SyncStats> {
    this.starts += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.kinds.push(affectedSourceKeys ? "incremental" : "full");
    this.resolveWaiters(this.startWaiters, this.starts);

    const gate = Promise.withResolvers<void>();
    this.releases.push(gate.resolve);
    await gate.promise;

    this.active -= 1;
    this.completions += 1;
    this.resolveWaiters(this.completionWaiters, this.completions);
    return { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  }

  async listWritableCalendars(): Promise<GoogleCalendarInfo[]> {
    return [];
  }

  async createCalendar(summary: string): Promise<GoogleCalendarInfo> {
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
    extendedProperties: { private: { obsidianSourceKey: sourceKey } },
  };
}

function toRemote(event: VaultCalendarEvent, id: string): GoogleEvent {
  return {
    id,
    summary: event.summary,
    start: event.start,
    end: event.end,
    recurrence: event.recurrence,
    extendedProperties: { private: { obsidianSourceKey: event.sourceKey } },
  };
}

function setup(gateway: GoogleCalendarGateway): {
  plugin: GoogleCalendarSyncPlugin;
  vault: TestVault;
  workspace: TestWorkspace;
  timers: TestTimers;
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
  const plugin = new GoogleCalendarSyncPlugin(app, MANIFEST, {
    createCalendarGateway: () => gateway,
    timers,
  });
  plugin.loadData = async () => ({
    calendarId: "calendar-id",
    clientIdSecret: "client-id-secret",
    refreshTokenSecret: "refresh-token-secret",
    syncIntervalMinutes: 15,
    timeZone: "UTC",
    vaultId: "vault-id",
  });
  return { plugin, vault, workspace, timers };
}

test("full lifecycle scan creates, updates, and deletes managed events", async () => {
  const gateway = new InMemoryGateway([
    managed("update-id", "Update.md::update", "Old title"),
    managed("stale-id", "Removed.md::stale", "Stale"),
  ]);
  const { plugin, vault, workspace } = setup(gateway);
  vault.set("New.md", "New #gcal:2026-08-18 #gcal-id:new");
  vault.set("Update.md", "Updated #gcal:2026-08-18 #gcal-id:update");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);

  assert.deepEqual(gateway.state(), [
    ["New.md::new", "New", "created-1"],
    ["Update.md::update", "Updated", "update-id"],
  ]);
  plugin.onunload();
});

test("deleting a note removes cached source keys without touching unrelated events", async () => {
  const gateway = new InMemoryGateway();
  const { plugin, vault, workspace, timers } = setup(gateway);
  vault.set("Delete.md", "Delete me #gcal:2026-08-18 #gcal-id:event");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);
  gateway.addRemote(managed("unrelated-id", "Other.md::event", "Other"));

  const deletedFile = vault.remove("Delete.md");
  vault.emit("delete", deletedFile);
  timers.runTimeouts();
  await gateway.waitForCompleted(2);

  assert.deepEqual(gateway.state(), [["Other.md::event", "Other", "unrelated-id"]]);
  plugin.onunload();
});

test("renaming a note reconciles both its old and new paths", async () => {
  const gateway = new InMemoryGateway();
  const { plugin, vault, workspace, timers } = setup(gateway);
  vault.set("Old.md", "Before #gcal:2026-08-18 #gcal-id:event");

  await plugin.onload();
  workspace.ready();
  await gateway.waitForCompleted(1);
  gateway.addRemote(managed("unrelated-id", "Other.md::event", "Other"));

  const renamedFile = vault.rename("Old.md", "New.md", "After #gcal:2026-08-18 #gcal-id:event");
  vault.emit("rename", renamedFile, "Old.md");
  timers.runTimeouts();
  await gateway.waitForCompleted(2);

  assert.deepEqual(gateway.state(), [
    ["New.md::event", "After", "created-2"],
    ["Other.md::event", "Other", "unrelated-id"],
  ]);
  plugin.onunload();
});

test("an invalid declaration prevents every remote mutation", async () => {
  const gateway = new InMemoryGateway([managed("safe-id", "Remote.md::safe", "Safe")]);
  const { plugin, vault } = setup(gateway);
  vault.set("Valid.md", "Would create #gcal:2026-08-18 #gcal-id:new");
  vault.set("Broken.md", "Broken #gcal:not-a-date");

  await plugin.onload();
  await plugin.syncNow(false);

  assert.deepEqual(gateway.state(), [["Remote.md::safe", "Safe", "safe-id"]]);
  plugin.onunload();
});

test("manual, periodic, and incremental sync triggers run serially", async () => {
  const gateway = new BlockingGateway();
  const { plugin, vault, timers } = setup(gateway);
  vault.set("Initial.md", "Initial #gcal:2026-08-18 #gcal-id:initial");
  await plugin.onload();

  const manualSync = plugin.syncNow(false);
  await gateway.waitForStarts(1);
  timers.runIntervals();
  const createdFile = vault.set("Created.md", "Created #gcal:2026-08-19 #gcal-id:created");
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

import assert from "node:assert/strict";
import test from "node:test";
import type { VaultCalendarEvent } from "../src/event-parser";
import { type GoogleEvent, planReconciliation } from "../src/sync-plan";

/** Mirrors the hashing the parser applies before a key is uploaded. */
function remoteKey(sourceKey: string): string {
  return `v1:${sourceKey}-hashed`;
}

function desired(sourceKey: string, summary: string): VaultCalendarEvent {
  return {
    sourceKey,
    remoteSourceKey: remoteKey(sourceKey),
    summary,
    start: { dateTime: "2026-08-18T09:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-08-18T10:00:00-04:00", timeZone: "America/New_York" },
    recurrence: ["RRULE:FREQ=WEEKLY"],
  };
}

function remote(
  id: string,
  sourceKey: string,
  summary: string,
  overrides: Partial<GoogleEvent> = {},
): GoogleEvent {
  return {
    id,
    summary,
    start: { dateTime: "2026-08-18T13:00:00Z" },
    end: { dateTime: "2026-08-18T14:00:00Z" },
    recurrence: ["RRULE:FREQ=WEEKLY"],
    extendedProperties: { private: { obsidianSourceKey: remoteKey(sourceKey) } },
    ...overrides,
  };
}

test("plans create, update, delete, and unchanged operations", () => {
  const expected = [desired("new", "New"), desired("changed", "Changed"), desired("same", "Same")];
  const existing = [
    remote("changed-id", "changed", "Old title"),
    remote("same-id", "same", "Same"),
    remote("stale-id", "stale", "Stale"),
  ];

  const plan = planReconciliation(expected, existing);
  assert.deepEqual(
    plan.creates.map((event) => event.sourceKey),
    ["new"],
  );
  assert.deepEqual(
    plan.updates.map((update) => [update.eventId, update.event.sourceKey]),
    [["changed-id", "changed"]],
  );
  assert.deepEqual(plan.deletes, ["stale-id"]);
  assert.equal(plan.unchanged, 1);
});

test("incremental plans do not touch sources outside the affected set", () => {
  const plan = planReconciliation(
    [desired("changed", "Changed"), desired("unrelated-new", "New")],
    [
      remote("changed-id", "changed", "Old title"),
      remote("unrelated-stale-id", "unrelated-stale", "Stale"),
    ],
    new Set(["changed"]),
  );

  assert.equal(plan.creates.length, 0);
  assert.deepEqual(
    plan.updates.map((update) => update.eventId),
    ["changed-id"],
  );
  assert.equal(plan.deletes.length, 0);
});

test("keeps one matching event and deletes duplicate managed events", () => {
  const plan = planReconciliation(
    [desired("same", "Same")],
    [remote("first", "same", "Same"), remote("duplicate", "same", "Same")],
  );

  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.deletes, ["duplicate"]);
});

test("updates when a recurrence changes", () => {
  const plan = planReconciliation(
    [desired("event", "Event")],
    [remote("event-id", "event", "Event", { recurrence: ["RRULE:FREQ=DAILY"] })],
  );

  assert.deepEqual(
    plan.updates.map((update) => update.eventId),
    ["event-id"],
  );
});

test("ignores remote events without managed source metadata", () => {
  const plan = planReconciliation(
    [],
    [
      {
        id: "unmanaged-id",
        summary: "Personal event",
        start: { date: "2026-08-18" },
        end: { date: "2026-08-19" },
      },
    ],
  );

  assert.deepEqual(plan, { creates: [], updates: [], deletes: [], unchanged: 0 });
});

test("fails safely when an actionable remote event has no ID", () => {
  assert.throws(
    () => planReconciliation([desired("changed", "Changed")], [remote("", "changed", "Old title")]),
    /event without an ID/,
  );
  assert.throws(
    () => planReconciliation([], [remote("", "stale", "Stale")]),
    /event without an ID/,
  );
});

test("adopts an event still keyed by an unhashed source key and rewrites it", () => {
  const plan = planReconciliation(
    [desired("event", "Event")],
    [
      remote("legacy-id", "event", "Event", {
        extendedProperties: { private: { obsidianSourceKey: "event" } },
      }),
    ],
  );

  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(
    plan.updates.map((update) => update.eventId),
    ["legacy-id"],
  );
});

test("compares all-day start and end dates", () => {
  const expected: VaultCalendarEvent = {
    ...desired("all-day", "All day"),
    start: { date: "2026-08-18" },
    end: { date: "2026-08-19" },
    recurrence: undefined,
  };

  const same = planReconciliation(
    [expected],
    [
      remote("all-day-id", "all-day", "All day", {
        start: { date: "2026-08-18" },
        end: { date: "2026-08-19" },
        recurrence: undefined,
      }),
    ],
  );
  const changed = planReconciliation(
    [expected],
    [
      remote("all-day-id", "all-day", "All day", {
        start: { date: "2026-08-18" },
        end: { date: "2026-08-20" },
        recurrence: undefined,
      }),
    ],
  );

  assert.equal(same.unchanged, 1);
  assert.deepEqual(
    changed.updates.map((update) => update.eventId),
    ["all-day-id"],
  );
});

test("updates a remote recurrence when the declaration removes it", () => {
  const expected: VaultCalendarEvent = {
    ...desired("event", "Event"),
    recurrence: undefined,
  };
  const plan = planReconciliation(
    [expected],
    [remote("event-id", "event", "Event", { recurrence: ["RRULE:FREQ=WEEKLY"] })],
  );

  assert.deepEqual(
    plan.updates.map((update) => update.eventId),
    ["event-id"],
  );
});

/** A note that wrote a time but no date, resolved against today at parse time. */
function impliedToday(sourceKey: string, date: string, time: string): VaultCalendarEvent {
  return {
    ...desired(sourceKey, "Standup"),
    start: { dateTime: `${date}T${time}:00`, timeZone: "UTC" },
    end: { dateTime: `${date}T${time}:00`, timeZone: "UTC" },
    recurrence: undefined,
    impliedDate: true,
  };
}

function wallClockRemote(id: string, sourceKey: string, start: string, end: string): GoogleEvent {
  return {
    id,
    summary: "Standup",
    start: { dateTime: start, timeZone: "UTC" },
    end: { dateTime: end, timeZone: "UTC" },
    extendedProperties: { private: { obsidianSourceKey: remoteKey(sourceKey) } },
  };
}

test("an implied date stays on the day the event was created", () => {
  const today = {
    ...impliedToday("standup", "2026-08-20", "09:00"),
    end: { dateTime: "2026-08-20T09:30:00", timeZone: "UTC" },
  };
  const plan = planReconciliation(
    [today],
    [wallClockRemote("standup-id", "standup", "2026-08-18T09:00:00", "2026-08-18T09:30:00")],
  );

  assert.equal(plan.unchanged, 1, "the event should not be moved forward each day");
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deletes, []);
});

test("retiming an implied-date event keeps its original day", () => {
  const retimed = {
    ...impliedToday("standup", "2026-08-20", "10:00"),
    end: { dateTime: "2026-08-20T11:00:00", timeZone: "UTC" },
  };
  const plan = planReconciliation(
    [retimed],
    [wallClockRemote("standup-id", "standup", "2026-08-18T09:00:00", "2026-08-18T10:00:00")],
  );

  assert.deepEqual(
    plan.updates.map((update) => [update.eventId, update.event.start.dateTime]),
    [["standup-id", "2026-08-18T10:00:00"]],
  );
  assert.equal(plan.updates[0]?.event.end.dateTime, "2026-08-18T11:00:00");
});

test("a declared date is never re-anchored to the remote event", () => {
  const declared = {
    ...impliedToday("standup", "2026-08-20", "09:00"),
    end: { dateTime: "2026-08-20T09:30:00", timeZone: "UTC" },
    impliedDate: undefined,
  };
  const plan = planReconciliation(
    [declared],
    [wallClockRemote("standup-id", "standup", "2026-08-18T09:00:00", "2026-08-18T09:30:00")],
  );

  assert.deepEqual(
    plan.updates.map((update) => update.event.start.dateTime),
    ["2026-08-20T09:00:00"],
  );
});

test("an implied date is used as written when the event does not exist yet", () => {
  const plan = planReconciliation([impliedToday("standup", "2026-08-20", "09:00")], []);

  assert.deepEqual(
    plan.creates.map((event) => event.start.dateTime),
    ["2026-08-20T09:00:00"],
  );
});

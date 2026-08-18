import assert from "node:assert/strict";
import test from "node:test";
import type { VaultCalendarEvent } from "../src/event-parser";
import {
  planReconciliation,
  type GoogleEvent
} from "../src/sync-plan";

function desired(sourceKey: string, summary: string): VaultCalendarEvent {
  return {
    sourceKey,
    sourcePath: "Calendar.md",
    summary,
    start: { dateTime: "2026-08-18T09:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-08-18T10:00:00-04:00", timeZone: "America/New_York" },
    recurrence: ["RRULE:FREQ=WEEKLY"]
  };
}

function remote(
  id: string,
  sourceKey: string,
  summary: string,
  overrides: Partial<GoogleEvent> = {}
): GoogleEvent {
  return {
    id,
    summary,
    start: { dateTime: "2026-08-18T13:00:00Z" },
    end: { dateTime: "2026-08-18T14:00:00Z" },
    recurrence: ["RRULE:FREQ=WEEKLY"],
    extendedProperties: { private: { obsidianSourceKey: sourceKey } },
    ...overrides
  };
}

test("plans create, update, delete, and unchanged operations", () => {
  const expected = [
    desired("new", "New"),
    desired("changed", "Changed"),
    desired("same", "Same")
  ];
  const existing = [
    remote("changed-id", "changed", "Old title"),
    remote("same-id", "same", "Same"),
    remote("stale-id", "stale", "Stale")
  ];

  const plan = planReconciliation(expected, existing);
  assert.deepEqual(plan.creates.map((event) => event.sourceKey), ["new"]);
  assert.deepEqual(
    plan.updates.map((update) => [update.eventId, update.event.sourceKey]),
    [["changed-id", "changed"]]
  );
  assert.deepEqual(plan.deletes, ["stale-id"]);
  assert.equal(plan.unchanged, 1);
});

test("incremental plans do not touch sources outside the affected set", () => {
  const plan = planReconciliation(
    [desired("changed", "Changed"), desired("unrelated-new", "New")],
    [
      remote("changed-id", "changed", "Old title"),
      remote("unrelated-stale-id", "unrelated-stale", "Stale")
    ],
    new Set(["changed"])
  );

  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.updates.map((update) => update.eventId), ["changed-id"]);
  assert.equal(plan.deletes.length, 0);
});

test("keeps one matching event and deletes duplicate managed events", () => {
  const plan = planReconciliation(
    [desired("same", "Same")],
    [remote("first", "same", "Same"), remote("duplicate", "same", "Same")]
  );

  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.deletes, ["duplicate"]);
});

test("updates when a recurrence changes", () => {
  const plan = planReconciliation(
    [desired("event", "Event")],
    [remote("event-id", "event", "Event", { recurrence: ["RRULE:FREQ=DAILY"] })]
  );

  assert.deepEqual(plan.updates.map((update) => update.eventId), ["event-id"]);
});

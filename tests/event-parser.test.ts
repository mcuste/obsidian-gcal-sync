import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRecurrence,
  parseSchedule,
  parseVaultEvents
} from "../src/event-parser";

const TIME_ZONE = "America/New_York";

test("parses inline event title, duration, recurrence, and stable ID", () => {
  const result = parseVaultEvents({
    path: "Projects/Launch.md",
    basename: "Launch",
    content:
      "- [ ] Team standup #gcal:2026-08-18T09:00:00-04:00/PT30M #gcal-repeat:monday-thursday #gcal-id:standup",
    timeZone: TIME_ZONE
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.events, [
    {
      sourceKey: "Projects/Launch.md::standup",
      sourcePath: "Projects/Launch.md",
      summary: "Team standup",
      start: {
        dateTime: "2026-08-18T09:00:00-04:00",
        timeZone: TIME_ZONE
      },
      end: {
        dateTime: "2026-08-18T13:30:00.000Z",
        timeZone: TIME_ZONE
      },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH"]
    }
  ]);
});

test("falls back to the note name when an inline directive has no title", () => {
  const result = parseVaultEvents({
    path: "Calendar/Release.md",
    basename: "Release",
    content: "#gcal:2026-09-01",
    timeZone: "UTC"
  });

  assert.equal(result.events[0]?.summary, "Release");
  assert.deepEqual(result.events[0]?.start, { date: "2026-09-01" });
  assert.deepEqual(result.events[0]?.end, { date: "2026-09-02" });
});

test("parses multiple frontmatter events using the note name", () => {
  const result = parseVaultEvents({
    path: "Travel.md",
    basename: "Travel",
    content: "---\ngcal:\n  - 2026-10-01/P2D\n  - 2026-11-01\n---",
    frontmatter: {
      gcal: ["2026-10-01/P2D", "2026-11-01"],
      "gcal-id": ["outbound", "return"]
    },
    timeZone: "UTC"
  });

  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary, event.end.date]),
    [
      ["Travel.md::outbound", "Travel", "2026-10-03"],
      ["Travel.md::return", "Travel", "2026-11-02"]
    ]
  );
});

test("uses a one-hour default for a timestamp without duration", () => {
  const schedule = parseSchedule("2026-08-18T14:00:00Z", "UTC");
  assert.equal(schedule.end.dateTime, "2026-08-18T15:00:00.000Z");
});

test("normalizes recurrence aliases and RRULE values", () => {
  assert.equal(normalizeRecurrence("weekly"), "RRULE:FREQ=WEEKLY");
  assert.equal(
    normalizeRecurrence("mon,wed,fri"),
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"
  );
  assert.equal(
    normalizeRecurrence("FREQ=MONTHLY;BYDAY=MO"),
    "RRULE:FREQ=MONTHLY;BYDAY=MO"
  );
});

test("rejects local timestamps whose time zone would be ambiguous", () => {
  assert.throws(
    () => parseSchedule("2026-08-18T14:00/PT1H", TIME_ZONE),
    /RFC 3339 timestamp/
  );
});

test("rejects calendar dates that JavaScript would otherwise normalize", () => {
  assert.throws(() => parseSchedule("2026-02-31", "UTC"), /Invalid calendar date/);
  assert.throws(
    () => parseSchedule("2026-02-31T14:00:00Z", "UTC"),
    /Invalid calendar date/
  );
});

test("returns no events when any declaration in a note is invalid", () => {
  const result = parseVaultEvents({
    path: "Broken.md",
    basename: "Broken",
    content: "Good #gcal:2026-08-18\nBad #gcal:not-a-date",
    timeZone: "UTC"
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.location, "line 2");
});

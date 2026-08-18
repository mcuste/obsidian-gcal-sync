import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EVENTS_PER_NOTE,
  makeRemoteSourceKey,
  normalizeRecurrence,
  parseSchedule,
  parseVaultEvents,
} from "../src/event-parser";

const TIME_ZONE = "America/New_York";
const VAULT_ID = "vault-id";

test("parses inline event title, duration, recurrence, and stable ID", () => {
  const result = parseVaultEvents({
    path: "Projects/Launch.md",
    basename: "Launch",
    content:
      "- [ ] Team standup #gcal:2026-08-18T09:00:00-04:00/PT30M #gcal-repeat:monday-thursday #gcal-id:standup",
    timeZone: TIME_ZONE,
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.events, [
    {
      sourceKey: "Projects/Launch.md::standup",
      remoteSourceKey: makeRemoteSourceKey(VAULT_ID, "Projects/Launch.md::standup"),
      summary: "Team standup",
      start: {
        dateTime: "2026-08-18T09:00:00-04:00",
        timeZone: TIME_ZONE,
      },
      end: {
        dateTime: "2026-08-18T13:30:00.000Z",
        timeZone: TIME_ZONE,
      },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH"],
    },
  ]);
});

test("falls back to the note name when an inline directive has no title", () => {
  const result = parseVaultEvents({
    path: "Calendar/Release.md",
    basename: "Release",
    content: "#gcal:2026-09-01",
    timeZone: "UTC",
    vaultId: VAULT_ID,
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
      "gcal-id": ["outbound", "return"],
    },
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary, event.end.date]),
    [
      ["Travel.md::outbound", "Travel", "2026-10-03"],
      ["Travel.md::return", "Travel", "2026-11-02"],
    ],
  );
});

test("uses a one-hour default for a timestamp without duration", () => {
  const schedule = parseSchedule("2026-08-18T14:00:00Z", "UTC");
  assert.equal(schedule.end.dateTime, "2026-08-18T15:00:00.000Z");
});

test("normalizes recurrence aliases and RRULE values", () => {
  assert.equal(normalizeRecurrence("weekly"), "RRULE:FREQ=WEEKLY");
  assert.equal(normalizeRecurrence("mon,wed,fri"), "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
  assert.equal(normalizeRecurrence("FREQ=MONTHLY;BYDAY=MO"), "RRULE:FREQ=MONTHLY;BYDAY=MO");
});

test("rejects local timestamps whose time zone would be ambiguous", () => {
  assert.throws(() => parseSchedule("2026-08-18T14:00/PT1H", TIME_ZONE), /RFC 3339 timestamp/);
});

test("rejects calendar dates that JavaScript would otherwise normalize", () => {
  assert.throws(() => parseSchedule("2026-02-31", "UTC"), /Invalid calendar date/);
  assert.throws(() => parseSchedule("2026-02-31T14:00:00Z", "UTC"), /Invalid calendar date/);
});

test("keys uploaded to Google reveal neither the note path nor the vault ID", () => {
  const sourceKey = "Private/Therapy notes.md::weekly";
  const remoteSourceKey = makeRemoteSourceKey(VAULT_ID, sourceKey);

  assert.match(remoteSourceKey, /^v1:[\w-]+$/);
  for (const secret of ["Private", "Therapy notes", sourceKey, VAULT_ID]) {
    assert.ok(!remoteSourceKey.includes(secret), `${secret} leaked into the uploaded key`);
  }
  assert.notEqual(remoteSourceKey, makeRemoteSourceKey("other-vault", sourceKey));
  assert.equal(remoteSourceKey, makeRemoteSourceKey(VAULT_ID, sourceKey));
});

test("ignores directives inside code fences, inline code, and HTML comments", () => {
  const result = parseVaultEvents({
    path: "Docs/Syntax.md",
    basename: "Syntax",
    content: [
      "Write `Standup #gcal:not-a-date` to declare an event.",
      "```markdown",
      "Fenced #gcal:also-not-a-date",
      "```",
      "<!-- Commented #gcal:still-not-a-date -->",
      "~~~",
      "Tilde fenced #gcal:nope",
      "~~~",
      "Real #gcal:2026-08-18 #gcal-id:real",
    ].join("\n"),
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary]),
    [["Docs/Syntax.md::real", "Real"]],
  );
});

test("ignores a directive inside a multi-line HTML comment", () => {
  const result = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content:
      "<!--\nDraft #gcal:2026-08-18 #gcal-id:draft\n-->\nKept #gcal:2026-08-19 #gcal-id:kept",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(
    result.events.map((event) => event.sourceKey),
    ["Notes.md::kept"],
  );
});

test("rejects a note that declares events in bulk", () => {
  const lines = Array.from(
    { length: MAX_EVENTS_PER_NOTE + 1 },
    (_unused, index) => `Spam ${index} #gcal:2026-08-18 #gcal-id:spam${index}`,
  );
  const result = parseVaultEvents({
    path: "Spam.md",
    basename: "Spam",
    content: lines.join("\n"),
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(
    result.issues.map((issue) => issue.message),
    [`A note can declare at most ${MAX_EVENTS_PER_NOTE} calendar events`],
  );
});

test("returns no events when any declaration in a note is invalid", () => {
  const result = parseVaultEvents({
    path: "Broken.md",
    basename: "Broken",
    content: "Good #gcal:2026-08-18\nBad #gcal:not-a-date",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.location, "line 2");
});

test("duplicate explicit IDs invalidate every declaration in the note", () => {
  const result = parseVaultEvents({
    path: "Duplicate.md",
    basename: "Duplicate",
    content: "First #gcal:2026-08-18 #gcal-id:shared\nSecond #gcal:2026-08-19 #gcal-id:shared",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(
    result.issues.map((issue) => issue.message),
    ["Duplicate gcal ID in this note"],
  );
});

test("invalid durations and weekday ranges invalidate the note", () => {
  const result = parseVaultEvents({
    path: "Invalid.md",
    basename: "Invalid",
    content: [
      "Zero #gcal:2026-08-18T09:00:00Z/PT0S",
      "Malformed #gcal:2026-08-18T09:00:00Z/P1H",
      "Range #gcal:2026-08-18 #gcal-repeat:friday-monday",
    ].join("\n"),
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(
    result.issues.map((issue) => issue.message),
    [
      "Event duration must be greater than zero",
      "Invalid ISO 8601 duration",
      "Invalid recurring weekday range",
    ],
  );
});

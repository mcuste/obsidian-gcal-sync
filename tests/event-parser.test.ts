import assert from "node:assert/strict";
import test from "node:test";
import {
  findLineDirectives,
  MAX_EVENTS_PER_NOTE,
  makeRemoteEventId,
  makeRemoteSourceKey,
  normalizeRecurrence,
  parseSchedule,
  parseVaultEvents,
} from "../src/event-parser";

const TIME_ZONE = "America/New_York";
const VAULT_ID = "vault-id";

test("parses inline event title, duration, and recurrence", () => {
  const result = parseVaultEvents({
    path: "Projects/Launch.md",
    basename: "Launch",
    content: "- [ ] Team standup `gcal:2026-08-18T09:00-04:00/PT30M gcal-repeat:monday-thursday`",
    timeZone: TIME_ZONE,
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.events, [
    {
      sourceKey: "Projects/Launch.md::line-1-1",
      remoteSourceKey: makeRemoteSourceKey(VAULT_ID, "Projects/Launch.md::line-1-1"),
      remoteEventId: makeRemoteEventId(VAULT_ID, "Projects/Launch.md::line-1-1"),
      summary: "Team standup",
      start: {
        dateTime: "2026-08-18T09:00:00-04:00",
        timeZone: TIME_ZONE,
      },
      end: {
        dateTime: "2026-08-18T13:30:00Z",
        timeZone: TIME_ZONE,
      },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH"],
      placement: { line: 0, occurrence: 1 },
    },
  ]);
});

test("falls back to the note name when an inline directive has no title", () => {
  const result = parseVaultEvents({
    path: "Calendar/Release.md",
    basename: "Release",
    content: "`gcal:2026-09-01`",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.equal(result.events[0]?.summary, "Release");
  assert.deepEqual(result.events[0]?.start, { date: "2026-09-01" });
  assert.deepEqual(result.events[0]?.end, { date: "2026-09-02" });
});

test("parses multiple frontmatter events, keyed by their position", () => {
  const result = parseVaultEvents({
    path: "Travel.md",
    basename: "Travel",
    content: "---\ngcal:\n---",
    frontmatter: {
      gcal: [{ when: "2026-10-01/P2D" }, { when: "2026-11-01" }],
    },
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary, event.end.date]),
    [
      ["Travel.md::frontmatter-1", "Travel", "2026-10-03"],
      ["Travel.md::frontmatter-2", "Travel", "2026-11-02"],
    ],
  );
});

test("uses a one-hour default for a timestamp without duration", () => {
  const schedule = parseSchedule("2026-08-18T14:00Z", "UTC");
  assert.equal(schedule.end.dateTime, "2026-08-18T15:00:00Z");
});

test("normalizes recurrence aliases and RRULE values", () => {
  assert.equal(normalizeRecurrence("weekly"), "RRULE:FREQ=WEEKLY");
  assert.equal(normalizeRecurrence("mon,wed,fri"), "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
  assert.equal(normalizeRecurrence("FREQ=MONTHLY;BYDAY=MO"), "RRULE:FREQ=MONTHLY;BYDAY=MO");
});

test("normalizes calendar-period names, including quarterly", () => {
  assert.equal(normalizeRecurrence("daily"), "RRULE:FREQ=DAILY");
  assert.equal(normalizeRecurrence("everyday"), "RRULE:FREQ=DAILY");
  assert.equal(normalizeRecurrence("monthly"), "RRULE:FREQ=MONTHLY");
  assert.equal(normalizeRecurrence("quarterly"), "RRULE:FREQ=MONTHLY;INTERVAL=3");
  assert.equal(normalizeRecurrence("yearly"), "RRULE:FREQ=YEARLY");
  assert.equal(normalizeRecurrence("annually"), "RRULE:FREQ=YEARLY");
  assert.equal(normalizeRecurrence("fortnightly"), "RRULE:FREQ=WEEKLY;INTERVAL=2");
  assert.equal(normalizeRecurrence("weekdays"), "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
});

test("normalizes every-N-unit intervals and drops a redundant interval of one", () => {
  assert.equal(normalizeRecurrence("every-2-weeks"), "RRULE:FREQ=WEEKLY;INTERVAL=2");
  assert.equal(normalizeRecurrence("every-10-days"), "RRULE:FREQ=DAILY;INTERVAL=10");
  assert.equal(normalizeRecurrence("3-months"), "RRULE:FREQ=MONTHLY;INTERVAL=3");
  assert.equal(normalizeRecurrence("every-2-years"), "RRULE:FREQ=YEARLY;INTERVAL=2");
  assert.equal(normalizeRecurrence("every-1-week"), "RRULE:FREQ=WEEKLY");
  assert.equal(normalizeRecurrence("every-week"), "RRULE:FREQ=WEEKLY");
  assert.equal(normalizeRecurrence("every-month"), "RRULE:FREQ=MONTHLY");
  assert.throws(() => normalizeRecurrence("every-0-weeks"), /whole number of units/);
});

test("rejects seconds and milliseconds in every timed form", () => {
  for (const value of [
    "2026-08-18T09:00:00",
    "2026-08-18T09:00:00Z",
    "2026-08-18T09:00:00-04:00",
    "2026-08-18T09:00:00.123Z",
    "09:00:00",
  ]) {
    assert.throws(() => parseSchedule(value, "UTC"), /Expected a date/, `accepted ${value}`);
  }
  assert.throws(() => parseSchedule("2026-08-18T09:00Z/PT30S", "UTC"), /Invalid duration/);
});

test("a bare time is flagged so its date can be pinned once the event exists", () => {
  const now = new Date("2026-08-18T12:00:00Z");

  assert.equal(parseSchedule("09:00", "UTC", now).impliedDate, true);
  assert.equal(parseSchedule("2026-08-18T09:00", "UTC").impliedDate, undefined);
  assert.equal(parseSchedule("2026-08-18", "UTC").impliedDate, undefined);
});

test("a timestamp without an offset is read in the event time zone", () => {
  const schedule = parseSchedule("2026-08-18T14:00/PT1H", TIME_ZONE);

  assert.deepEqual(schedule.start, { dateTime: "2026-08-18T14:00:00", timeZone: TIME_ZONE });
  assert.deepEqual(schedule.end, { dateTime: "2026-08-18T15:00:00", timeZone: TIME_ZONE });
});

test("a bare time means today in the event time zone", () => {
  // 23:30 UTC is still the 18th in New York but already the 19th in Tokyo.
  const now = new Date("2026-08-18T23:30:00Z");

  assert.deepEqual(parseSchedule("09:00", TIME_ZONE, now).start, {
    dateTime: "2026-08-18T09:00:00",
    timeZone: TIME_ZONE,
  });
  assert.deepEqual(parseSchedule("09:00", "Asia/Tokyo", now).start, {
    dateTime: "2026-08-19T09:00:00",
    timeZone: "Asia/Tokyo",
  });
});

test("a bare time defaults to an hour and honours an explicit duration", () => {
  const now = new Date("2026-08-18T12:00:00Z");

  assert.equal(parseSchedule("09:00", "UTC", now).end.dateTime, "2026-08-18T10:00:00");
  assert.equal(parseSchedule("09:00/PT15M", "UTC", now).end.dateTime, "2026-08-18T09:15:00");
  assert.equal(parseSchedule("23:30/PT1H", "UTC", now).end.dateTime, "2026-08-19T00:30:00");
});

test("a date with no time is still an all-day event", () => {
  const schedule = parseSchedule("2026-08-18", TIME_ZONE);

  assert.deepEqual(schedule.start, { date: "2026-08-18" });
  assert.deepEqual(schedule.end, { date: "2026-08-19" });
});

test("rejects a time zone with no time, and impossible times of day", () => {
  for (const value of ["Z", "+02:00", "-04:00", "T14:00", "14:00+02:00", "2026-08-18T"]) {
    assert.throws(() => parseSchedule(value, TIME_ZONE), /Expected a date/, `accepted ${value}`);
  }
  assert.throws(() => parseSchedule("25:00", TIME_ZONE), /Invalid time of day/);
  assert.throws(() => parseSchedule("2026-08-18T14:61", TIME_ZONE), /Invalid time of day/);
});

test("rejects calendar dates that JavaScript would otherwise normalize", () => {
  assert.throws(() => parseSchedule("2026-02-31", "UTC"), /Invalid calendar date/);
  assert.throws(() => parseSchedule("2026-02-31T14:00Z", "UTC"), /Invalid calendar date/);
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
      "Write `Standup gcal:not-a-date` to declare an event.",
      "```markdown",
      "Fenced `gcal:also-not-a-date`",
      "```",
      "<!-- Commented `gcal:still-not-a-date` -->",
      "~~~",
      "Tilde fenced `gcal:nope`",
      "~~~",
      "Real `gcal:2026-08-18`",
    ].join("\n"),
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary]),
    [["Docs/Syntax.md::line-9-1", "Real"]],
  );
});

test("ignores a directive inside a multi-line HTML comment", () => {
  const result = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content: "<!--\nDraft `gcal:2026-08-18`\n-->\nKept `gcal:2026-08-19`",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(
    result.events.map((event) => event.sourceKey),
    ["Notes.md::line-4-1"],
  );
});

test("rejects a note that declares events in bulk", () => {
  const lines = Array.from(
    { length: MAX_EVENTS_PER_NOTE + 1 },
    (_unused, index) => `Spam ${index} \`gcal:2026-08-18\``,
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
    content: "Good `gcal:2026-08-18`\nBad `gcal:not-a-date`",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.location, "line 2");
});

test("two declarations on one line stay distinct without any id", () => {
  const result = parseVaultEvents({
    path: "Duplicate.md",
    basename: "Duplicate",
    content: "First `gcal:2026-08-18` Second `gcal:2026-08-19`",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary]),
    [
      ["Duplicate.md::line-1-1", "First"],
      ["Duplicate.md::line-1-2", "Second"],
    ],
  );
});

test("invalid durations and weekday ranges invalidate the note", () => {
  const result = parseVaultEvents({
    path: "Invalid.md",
    basename: "Invalid",
    content: [
      "Zero `gcal:2026-08-18T09:00Z/PT0M`",
      "Malformed `gcal:2026-08-18T09:00Z/P1H`",
      "Range `gcal:2026-08-18 gcal-repeat:friday-monday`",
    ].join("\n"),
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(
    result.issues.map((issue) => issue.message),
    [
      "Event duration must be greater than zero",
      "Invalid duration; use days, hours, and minutes such as PT90M",
      "Invalid recurring weekday range",
    ],
  );
});

test("inline code holding only directives declares events", () => {
  const result = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content: [
      "Design review `gcal:2026-08-18T14:00/PT1H`",
      "Standup `gcal:09:00` `gcal-repeat:weekdays`",
    ].join("\n"),
    timeZone: "UTC",
    vaultId: VAULT_ID,
    now: new Date("2026-08-18T12:00:00Z"),
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary, event.recurrence]),
    [
      ["Notes.md::line-1-1", "Design review", undefined],
      ["Notes.md::line-2-1", "Standup", ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]],
    ],
  );
});

test("a standalone repeat creates an all-day event beginning today", () => {
  const result = parseVaultEvents({
    path: "Tasks.md",
    basename: "Tasks",
    content: "- [ ] Take medication `gcal-repeat:everyday`",
    timeZone: "America/New_York",
    vaultId: VAULT_ID,
    now: new Date("2026-08-18T23:30:00Z"),
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.events, [
    {
      sourceKey: "Tasks.md::line-1-1",
      remoteSourceKey: makeRemoteSourceKey(VAULT_ID, "Tasks.md::line-1-1"),
      remoteEventId: makeRemoteEventId(VAULT_ID, "Tasks.md::line-1-1"),
      summary: "Take medication",
      start: { date: "2026-08-18" },
      end: { date: "2026-08-19" },
      recurrence: ["RRULE:FREQ=DAILY"],
      impliedDate: true,
      placement: { line: 0, occurrence: 1 },
    },
  ]);
});

test("inline code mixing prose with a directive stays inert", () => {
  const result = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content: [
      "Write `Standup gcal:not-a-date` to declare an event.",
      "Or `see gcal:2026-08-18 for details`.",
      "Real `gcal:2026-08-19`",
    ].join("\n"),
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.events.map((event) => event.sourceKey),
    ["Notes.md::line-3-1"],
  );
});

test("directives are written without any tag prefix", () => {
  const result = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content: [
      "Design review `gcal:2026-08-18T14:00/PT1H`",
      "Standup `gcal:09:00 gcal-repeat:weekdays`",
      "Spread `gcal:2026-08-20`",
    ].join("\n"),
    timeZone: "UTC",
    vaultId: VAULT_ID,
    now: new Date("2026-08-18T12:00:00Z"),
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary, event.recurrence]),
    [
      ["Notes.md::line-1-1", "Design review", undefined],
      ["Notes.md::line-2-1", "Standup", ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]],
      ["Notes.md::line-3-1", "Spread", undefined],
    ],
  );
});

test("a directive outside backticks never declares an event", () => {
  const result = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content: "Ask about gcal:2026-08-18, #gcal:2026-08-19, and the gcal:14:00 window",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.events, []);
});

test("reports where each declaration sits so the editor can mark it", () => {
  assert.deepEqual(findLineDirectives("Design review `gcal:2026-08-18T14:00` today"), [
    { from: 14, to: 37, occurrence: 1 },
  ]);
  assert.deepEqual(
    findLineDirectives("A `gcal:09:00` then B `gcal:10:00`").map((found) => found.occurrence),
    [1, 2],
  );
  assert.deepEqual(findLineDirectives("Standup `gcal:09:00 gcal-repeat:weekly`"), [
    { from: 8, to: 39, occurrence: 1 },
  ]);
  assert.deepEqual(findLineDirectives("Write `Standup gcal:not-a-date` here"), []);
  assert.deepEqual(findLineDirectives("A plain gcal:2026-08-18 mention"), []);
  assert.deepEqual(findLineDirectives("Repeat only `gcal-repeat:weekly`"), [
    { from: 12, to: 32, occurrence: 1 },
  ]);
});

test("declaration ranges cover the backticks so a marker can sit after them", () => {
  const line = "Design review `gcal:2026-08-18T14:00` today";
  const [found] = findLineDirectives(line);

  assert.ok(found);
  assert.equal(line.slice(found.from, found.to), "`gcal:2026-08-18T14:00`");
});

test("a note property entry can carry its own when, title, and repeat", () => {
  const result = parseVaultEvents({
    path: "Projects/Launch.md",
    basename: "Launch",
    content: "body",
    frontmatter: {
      gcal: [
        { when: "2026-08-18T09:15/PT15M", title: "Standup", repeat: "weekdays" },
        { when: "2026-08-20/P1D" },
      ],
    },
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary, event.recurrence?.[0] ?? null]),
    [
      ["Projects/Launch.md::frontmatter-1", "Standup", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
      ["Projects/Launch.md::frontmatter-2", "Launch", null],
    ],
  );
});

test("a single note property entry may be a lone map", () => {
  const result = parseVaultEvents({
    path: "Launch.md",
    basename: "Launch",
    content: "body",
    frontmatter: { gcal: { when: "2026-08-18", title: "Launch day" } },
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary]),
    [["Launch.md::frontmatter-1", "Launch day"]],
  );
});

test("note property entries report a missing when and a typo", () => {
  const messages = (frontmatter: Record<string, unknown>): string[] =>
    parseVaultEvents({
      path: "Launch.md",
      basename: "Launch",
      content: "body",
      frontmatter,
      timeZone: "UTC",
      vaultId: VAULT_ID,
    }).issues.map((issue) => issue.message);

  assert.deepEqual(messages({ gcal: [{ title: "No date" }] }), [
    "A gcal entry needs when, such as when: 2026-08-18T09:15/PT15M",
  ]);
  assert.deepEqual(messages({ gcal: [{ when: "2026-08-18", titel: "Oops" }] }), [
    "Unknown gcal field titel; use when, title, repeat",
  ]);
  assert.deepEqual(messages({ gcal: [{ when: "2026-08-18", id: "gone" }] }), [
    "Unknown gcal field id; use when, title, repeat",
  ]);
  assert.deepEqual(messages({ gcal: [42] }), [
    "A gcal entry must be a value such as 2026-08-18, or a map with a when field",
  ]);
});

test("each declaration on a line takes its own title and repeat", () => {
  const result = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content: "Standup `gcal:09:00 gcal-repeat:daily` Retro `gcal:11:00 gcal-repeat:weekly`",
    timeZone: "UTC",
    vaultId: VAULT_ID,
    now: new Date("2026-08-18T12:00:00Z"),
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.events.map((event) => [event.sourceKey, event.summary, event.recurrence?.[0]]),
    [
      ["Notes.md::line-1-1", "Standup", "RRULE:FREQ=DAILY"],
      ["Notes.md::line-1-2", "Retro", "RRULE:FREQ=WEEKLY"],
    ],
  );
});

test("a second declaration on a line never inherits the first one's directive text", () => {
  const result = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content: "A `gcal:09:00` B `gcal:11:00` `gcal-repeat:weekly`",
    timeZone: "UTC",
    vaultId: VAULT_ID,
    now: new Date("2026-08-18T12:00:00Z"),
  });

  const summaries = result.events.map((event) => event.summary);
  assert.deepEqual(summaries, ["A", "B"]);
  for (const summary of summaries) {
    assert.ok(!summary.includes("gcal:"), `${summary} leaked directive text into the title`);
  }
});

test("a note-level repeat applies to every entry", () => {
  const parse = (frontmatter: Record<string, unknown>) =>
    parseVaultEvents({
      path: "L.md",
      basename: "Launch",
      content: "x",
      frontmatter,
      timeZone: "UTC",
      vaultId: VAULT_ID,
    });

  const shared = parse({ gcal: ["2026-08-18", "2026-08-20"], "gcal-repeat": "weekly" });
  assert.deepEqual(shared.issues, []);
  assert.deepEqual(
    shared.events.map((event) => event.recurrence?.[0]),
    ["RRULE:FREQ=WEEKLY", "RRULE:FREQ=WEEKLY"],
  );

  const entryWins = parse({
    gcal: [{ when: "2026-08-18", repeat: "daily" }],
    "gcal-repeat": "weekly",
  });
  assert.deepEqual(entryWins.events[0]?.recurrence, ["RRULE:FREQ=DAILY"]);

  assert.deepEqual(parse({ gcal: ["2026-08-18", "2026-08-20"], "gcal-id": "gone" }).issues, []);
});

test("the removed positional list form reports how to migrate", () => {
  const result = parseVaultEvents({
    path: "Travel.md",
    basename: "Travel",
    content: "x",
    frontmatter: {
      gcal: ["2026-10-01/P2D", "2026-11-01"],
      "gcal-repeat": ["weekdays", ""],
    },
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(
    result.issues.map((issue) => [issue.location, issue.message]),
    [
      [
        "gcal-repeat",
        "gcal-repeat is no longer matched to gcal by position; give each gcal entry its own repeat field",
      ],
    ],
  );
});

test("an unrecognized directive is reported rather than silently ignored", () => {
  const messages = (content: string): string[] =>
    parseVaultEvents({
      path: "n.md",
      basename: "Note",
      content,
      timeZone: "UTC",
      vaultId: VAULT_ID,
      now: new Date("2026-08-19T12:00:00Z"),
    }).issues.map((issue) => issue.message);

  assert.deepEqual(messages("Standup `gcal:09:00 gcal-repat:weekly`"), [
    "Unknown directive gcal-repat; use gcal or gcal-repeat",
  ]);
  assert.deepEqual(messages("Standup `gcal:09:00 gcal-id:standup`"), [
    "Unknown directive gcal-id; use gcal or gcal-repeat",
  ]);
  assert.deepEqual(messages("Standup `gcal:09:00 gcal-repeat:weekly`"), []);
});

test("a declaration reserves one Google event ID", () => {
  const parsed = parseVaultEvents({
    path: "Notes.md",
    basename: "Notes",
    content: "Standup `gcal:2026-08-18`",
    timeZone: "UTC",
    vaultId: VAULT_ID,
  });

  const event = parsed.events[0];
  assert.ok(event);
  assert.equal(event.remoteEventId, makeRemoteEventId(VAULT_ID, "Notes.md::line-1-1"));
  // Google only accepts event IDs written in base32hex.
  assert.match(event.remoteEventId, /^[0-9a-v]{5,1024}$/);
  assert.notEqual(makeRemoteEventId("other-vault", "Notes.md::line-1-1"), event.remoteEventId);
});

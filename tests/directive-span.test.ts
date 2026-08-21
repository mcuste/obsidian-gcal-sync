import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSpanDirectives, rewriteDocument, rewriteSpan } from "../src/directive-span";

describe("reading a span", () => {
  it("reads an event on its own", () => {
    assert.deepEqual(readSpanDirectives("gcal:2026-08-18"), { when: "2026-08-18" });
  });

  it("reads an event and its repeat", () => {
    assert.deepEqual(readSpanDirectives("gcal:09:00 gcal-repeat:weekdays"), {
      when: "09:00",
      repeat: "weekdays",
    });
  });

  it("reads a repeat on its own", () => {
    assert.deepEqual(readSpanDirectives("gcal-repeat:daily"), { repeat: "daily" });
  });

  it("ignores the order the two were written in", () => {
    assert.deepEqual(readSpanDirectives("gcal-repeat:daily gcal:09:00"), {
      when: "09:00",
      repeat: "daily",
    });
  });

  it("keeps padding out of the values", () => {
    assert.deepEqual(readSpanDirectives("  gcal:2026-08-18  "), { when: "2026-08-18" });
  });

  it("reads a directive named in any case", () => {
    assert.deepEqual(readSpanDirectives("GCAL:2026-08-18 GCAL-REPEAT:daily"), {
      when: "2026-08-18",
      repeat: "daily",
    });
  });

  const refused = [
    ["two events", "gcal:09:00 gcal:11:00"],
    ["two repeats", "gcal:09:00 gcal-repeat:daily gcal-repeat:weekly"],
    ["a directive it does not know", "gcal:09:00 gcal-until:2026-12-31"],
    ["prose mixed in", "Standup gcal:09:00"],
    ["prose after the directive", "gcal:09:00 please"],
    ["nothing at all", "   "],
  ];

  for (const [reason, span] of refused) {
    it(`refuses ${reason}`, () => {
      assert.equal(readSpanDirectives(span ?? ""), undefined);
    });
  }
});

describe("rewriting a span", () => {
  it("replaces the event", () => {
    assert.equal(rewriteSpan("gcal:2026-08-18", { when: "2026-09-01" }), "gcal:2026-09-01");
  });

  it("replaces both directives", () => {
    assert.equal(
      rewriteSpan("gcal:09:00 gcal-repeat:daily", { when: "10:00/PT30M", repeat: "weekdays" }),
      "gcal:10:00/PT30M gcal-repeat:weekdays",
    );
  });

  it("adds a repeat that was not there", () => {
    assert.equal(
      rewriteSpan("gcal:2026-08-18", { when: "2026-08-18", repeat: "weekly" }),
      "gcal:2026-08-18 gcal-repeat:weekly",
    );
  });

  it("removes a repeat that is no longer wanted", () => {
    assert.equal(
      rewriteSpan("gcal:2026-08-18 gcal-repeat:weekly", { when: "2026-08-18" }),
      "gcal:2026-08-18",
    );
  });

  it("adds an event in front of a repeat that stood on its own", () => {
    assert.equal(
      rewriteSpan("gcal-repeat:daily", { when: "2026-09-01", repeat: "daily" }),
      "gcal:2026-09-01 gcal-repeat:daily",
    );
  });

  it("leaves a repeat standing on its own when the start is still today", () => {
    assert.equal(rewriteSpan("gcal-repeat:daily", { repeat: "weekly" }), "gcal-repeat:weekly");
  });

  it("keeps the padding around the span", () => {
    assert.equal(rewriteSpan(" gcal:2026-08-18 ", { when: "2026-09-01" }), " gcal:2026-09-01 ");
  });

  it("refuses to empty a span out", () => {
    assert.equal(rewriteSpan("gcal:2026-08-18", {}), undefined);
  });

  it("refuses a span it cannot read", () => {
    assert.equal(rewriteSpan("gcal:09:00 gcal:11:00", { when: "2026-08-18" }), undefined);
  });
});

describe("rewriting a note", () => {
  const note = [
    "---",
    "title: Notes",
    "---",
    "",
    "- [ ] Design review `gcal:2026-08-18T14:00/PT1H gcal-repeat:weekdays`",
    "Retro `gcal:2026-08-21T16:00`",
  ].join("\n");

  it("rewrites the declaration on the line it was told", () => {
    const next = rewriteDocument(note, 4, 1, { when: "2026-08-19T15:00/PT2H", repeat: "weekly" });
    assert.equal(
      next,
      note.replace(
        "gcal:2026-08-18T14:00/PT1H gcal-repeat:weekdays",
        "gcal:2026-08-19T15:00/PT2H gcal-repeat:weekly",
      ),
    );
  });

  it("leaves every other line alone", () => {
    const next = rewriteDocument(note, 5, 1, { when: "2026-08-21T17:00/PT1H" });
    assert.equal(next, note.replace("gcal:2026-08-21T16:00", "gcal:2026-08-21T17:00/PT1H"));
  });

  it("rewrites only the declaration asked for when a line holds two", () => {
    const line = "Standup `gcal:09:00` Retro `gcal:11:00`";
    assert.equal(
      rewriteDocument(line, 0, 2, { when: "12:00/PT1H" }),
      "Standup `gcal:09:00` Retro `gcal:12:00/PT1H`",
    );
  });

  it("keeps carriage returns intact", () => {
    const windows = "one `gcal:2026-08-18`\r\ntwo\r\n";
    assert.equal(
      rewriteDocument(windows, 0, 1, { when: "2026-08-19" }),
      "one `gcal:2026-08-19`\r\ntwo\r\n",
    );
  });

  it("changes nothing when the declaration is no longer there", () => {
    assert.equal(rewriteDocument(note, 3, 1, { when: "2026-08-19" }), undefined);
    assert.equal(rewriteDocument(note, 99, 1, { when: "2026-08-19" }), undefined);
    assert.equal(rewriteDocument(note, 4, 2, { when: "2026-08-19" }), undefined);
  });
});

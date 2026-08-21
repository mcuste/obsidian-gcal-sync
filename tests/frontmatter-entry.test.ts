import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readEntrySource, writeEntrySource } from "../src/frontmatter-entry";

describe("reading a gcal entry", () => {
  it("reads a bare value", () => {
    assert.deepEqual(readEntrySource({ gcal: "2026-08-18T14:00/PT1H" }, 0), {
      when: "2026-08-18T14:00/PT1H",
    });
  });

  it("reads a map with its own repeat", () => {
    assert.deepEqual(readEntrySource({ gcal: { when: "09:15", repeat: "weekdays" } }, 0), {
      when: "09:15",
      repeat: "weekdays",
    });
  });

  it("reads one entry out of a list", () => {
    const frontmatter = { gcal: [{ when: "2026-08-18" }, { when: "2026-08-20", title: "Retro" }] };
    assert.deepEqual(readEntrySource(frontmatter, 1), { when: "2026-08-20" });
  });

  it("marks a repeat that belongs to the whole note", () => {
    assert.deepEqual(readEntrySource({ gcal: "2026-08-18", "gcal-repeat": "weekly" }, 0), {
      when: "2026-08-18",
      repeat: "weekly",
      sharedRepeat: true,
    });
  });

  it("lets an entry's own repeat win over the note's", () => {
    assert.deepEqual(
      readEntrySource(
        { gcal: { when: "2026-08-18", repeat: "daily" }, "gcal-repeat": "weekly" },
        0,
      ),
      { when: "2026-08-18", repeat: "daily" },
    );
  });

  it("reads an entry with no when at all", () => {
    assert.deepEqual(readEntrySource({ gcal: { title: "Standup" } }, 0), {});
  });

  it("returns nothing for an entry that is not there", () => {
    assert.equal(readEntrySource({ gcal: "2026-08-18" }, 1), undefined);
    assert.equal(readEntrySource({}, 0), undefined);
    assert.equal(readEntrySource(undefined, 0), undefined);
  });
});

describe("writing a gcal entry", () => {
  it("keeps a bare value bare", () => {
    const frontmatter: Record<string, unknown> = { gcal: "2026-08-18" };
    assert.equal(writeEntrySource(frontmatter, 0, { when: "2026-09-01" }), true);
    assert.deepEqual(frontmatter, { gcal: "2026-09-01" });
  });

  it("turns a bare value into a map when a repeat needs a home", () => {
    const frontmatter: Record<string, unknown> = { gcal: "2026-08-18" };
    writeEntrySource(frontmatter, 0, { when: "2026-09-01", repeat: "weekly" });
    assert.deepEqual(frontmatter, { gcal: { when: "2026-09-01", repeat: "weekly" } });
  });

  it("keeps the other fields of a map", () => {
    const frontmatter: Record<string, unknown> = {
      gcal: { when: "09:15", title: "Standup", repeat: "weekdays" },
    };
    writeEntrySource(frontmatter, 0, { when: "09:30/PT15M", repeat: "daily" });
    assert.deepEqual(frontmatter, {
      gcal: { when: "09:30/PT15M", title: "Standup", repeat: "daily" },
    });
  });

  it("drops a repeat the entry no longer has", () => {
    const frontmatter: Record<string, unknown> = {
      gcal: { when: "09:15", title: "Standup", repeat: "weekdays" },
    };
    writeEntrySource(frontmatter, 0, { when: "09:15" });
    assert.deepEqual(frontmatter, { gcal: { when: "09:15", title: "Standup" } });
  });

  it("writes one entry of a list and leaves the rest alone", () => {
    const frontmatter: Record<string, unknown> = {
      gcal: [{ when: "2026-08-18" }, { when: "2026-08-20", title: "Retro" }],
    };
    writeEntrySource(frontmatter, 1, { when: "2026-08-21/P2D" });
    assert.deepEqual(frontmatter, {
      gcal: [{ when: "2026-08-18" }, { when: "2026-08-21/P2D", title: "Retro" }],
    });
  });

  it("leaves a note-level repeat where it is", () => {
    const frontmatter: Record<string, unknown> = { gcal: "2026-08-18", "gcal-repeat": "weekly" };
    writeEntrySource(frontmatter, 0, { when: "2026-09-01" });
    assert.deepEqual(frontmatter, { gcal: "2026-09-01", "gcal-repeat": "weekly" });
  });

  it("refuses an entry that is not there", () => {
    const frontmatter: Record<string, unknown> = { gcal: ["2026-08-18"] };
    assert.equal(writeEntrySource(frontmatter, 3, { when: "2026-09-01" }), false);
    assert.deepEqual(frontmatter, { gcal: ["2026-08-18"] });
    assert.equal(writeEntrySource({}, 0, { when: "2026-09-01" }), false);
  });
});

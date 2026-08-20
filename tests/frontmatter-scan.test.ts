import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findFrontmatterStarts } from "../src/frontmatter-scan";

/** Each start as `<line>:<text>@<entry>`, plus the slice its offsets point at, to catch drift. */
function scan(content: string): string[] {
  const lines = content.split("\n");
  return findFrontmatterStarts(content).map((start) => {
    const slice = (lines[start.line] ?? "").slice(start.from, start.to);
    return `${start.line}:${start.text}@${start.entryIndex} [${slice}]`;
  });
}

describe("findFrontmatterStarts", () => {
  it("finds the one-value form", () => {
    assert.deepEqual(scan("---\ngcal: 2026-08-18T14:00/PT1H\n---\n# Note\n"), [
      "1:2026-08-18T14:00/PT1H@0 [2026-08-18T14:00/PT1H]",
    ]);
  });

  it("numbers the entries of a list of maps in order", () => {
    const content = [
      "---",
      "gcal:",
      "  - when: 2026-08-18T09:15/PT15M",
      "    title: Standup",
      "    repeat: weekdays",
      "  - when: 2026-08-20/P1D",
      "---",
    ].join("\n");
    assert.deepEqual(scan(content), [
      "2:2026-08-18T09:15/PT15M@0 [2026-08-18T09:15/PT15M]",
      "5:2026-08-20/P1D@1 [2026-08-20/P1D]",
    ]);
  });

  it("finds a when written after the other fields of its entry", () => {
    const content = ["---", "gcal:", "  - title: Standup", "    when: 2026-08-18", "---"].join(
      "\n",
    );
    assert.deepEqual(scan(content), ["3:2026-08-18@0 [2026-08-18]"]);
  });

  it("reads a lone map as one entry", () => {
    const content = ["---", "gcal:", "  when: 2026-08-18", "  title: Offsite", "---"].join("\n");
    assert.deepEqual(scan(content), ["2:2026-08-18@0 [2026-08-18]"]);
  });

  it("reads a list of bare values", () => {
    const content = ["---", "gcal:", "  - 2026-10-01/P2D", "  - 2026-11-01", "---"].join("\n");
    assert.deepEqual(scan(content), [
      "2:2026-10-01/P2D@0 [2026-10-01/P2D]",
      "3:2026-11-01@1 [2026-11-01]",
    ]);
  });

  it("drops the quotes around a value but keeps the offsets on them", () => {
    assert.deepEqual(scan('---\ngcal: "2026-08-18"\n---'), ['1:2026-08-18@0 ["2026-08-18"]']);
  });

  it("ignores other properties, including gcal-repeat and a later when", () => {
    const content = [
      "---",
      "gcal: 2026-08-18",
      "gcal-repeat: weekly",
      "other:",
      "  - when: 2026-09-01",
      "---",
    ].join("\n");
    assert.deepEqual(scan(content), ["1:2026-08-18@0 [2026-08-18]"]);
  });

  it("stops at the end of the properties and ignores the note body", () => {
    const content = ["---", "gcal: 2026-08-18", "---", "gcal: 2026-09-01", ""].join("\n");
    assert.deepEqual(scan(content), ["1:2026-08-18@0 [2026-08-18]"]);
  });

  it("finds nothing in a note with no properties", () => {
    assert.deepEqual(scan("# Note\n\ngcal: 2026-08-18\n"), []);
  });

  it("skips an empty value and a comment", () => {
    assert.deepEqual(scan("---\ngcal: # later\n---"), []);
    assert.deepEqual(scan("---\ngcal:\n---"), []);
  });
});

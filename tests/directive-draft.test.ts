import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type DirectiveDraft,
  type DirectiveSource,
  previewDirective,
  readDraft,
  toDirectiveSource,
  writeDraft,
} from "../src/directive-draft";

const OPTIONS = { timeZone: "Europe/Lisbon", now: new Date("2026-08-18T12:00:00Z") };
const TODAY = "2026-08-18";

function draft(source: DirectiveSource): DirectiveDraft {
  return readDraft(source, OPTIONS);
}

/** What the picker would write for a declaration nobody touched. */
function roundTrip(source: DirectiveSource): DirectiveSource {
  return toDirectiveSource(writeDraft(draft(source)));
}

describe("reading a start", () => {
  it("reads an all-day date", () => {
    assert.deepEqual(draft({ when: "2026-09-14" }), {
      allDay: true,
      date: "2026-09-14",
      dateImplied: false,
      time: "09:00",
      offset: "",
      days: 1,
      minutes: 60,
      repeat: { kind: "none" },
    });
  });

  it("reads an all-day span", () => {
    const read = draft({ when: "2026-09-14/P3D" });
    assert.equal(read.allDay, true);
    assert.equal(read.days, 3);
  });

  it("reads a local timestamp and its duration", () => {
    const read = draft({ when: "2026-08-18T14:00/PT90M" });
    assert.equal(read.allDay, false);
    assert.equal(read.date, "2026-08-18");
    assert.equal(read.time, "14:00");
    assert.equal(read.minutes, 90);
    assert.equal(read.dateImplied, false);
  });

  it("reads a duration in days, hours, and minutes", () => {
    assert.equal(draft({ when: "2026-08-18T14:00/P1DT2H30M" }).minutes, 24 * 60 + 150);
  });

  it("keeps a UTC offset as written", () => {
    const read = draft({ when: "2026-08-18T14:00-04:00" });
    assert.equal(read.offset, "-04:00");
    assert.equal(read.time, "14:00");
  });

  it("reads a bare time as today, still implied", () => {
    const read = draft({ when: "16:00/PT30M" });
    assert.equal(read.allDay, false);
    assert.equal(read.date, TODAY);
    assert.equal(read.dateImplied, true);
    assert.equal(read.minutes, 30);
  });

  it("reads a repeat on its own as all day today, still implied", () => {
    const read = draft({ repeat: "daily" });
    assert.equal(read.allDay, true);
    assert.equal(read.date, TODAY);
    assert.equal(read.dateImplied, true);
  });

  it("falls back to today, spelled out, for a start it cannot read", () => {
    const read = draft({ when: "next-tuesday" });
    assert.equal(read.allDay, true);
    assert.equal(read.date, TODAY);
    assert.equal(read.dateImplied, false);
  });

  it("falls back to the default length for a duration it cannot read", () => {
    assert.equal(draft({ when: "2026-08-18T14:00/PT0M" }).minutes, 60);
    assert.equal(draft({ when: "2026-08-18T14:00/soon" }).minutes, 60);
  });
});

describe("reading a repeat", () => {
  const kinds: Array<[string, unknown]> = [
    ["daily", { kind: "period", period: "daily" }],
    ["everyday", { kind: "period", period: "daily" }],
    ["weekly", { kind: "period", period: "weekly" }],
    ["every-week", { kind: "period", period: "weekly" }],
    ["fortnightly", { kind: "period", period: "fortnightly" }],
    ["every-2-weeks", { kind: "period", period: "fortnightly" }],
    ["quarterly", { kind: "period", period: "quarterly" }],
    ["yearly", { kind: "period", period: "yearly" }],
    ["weekdays", { kind: "weekdays", days: ["MO", "TU", "WE", "TH", "FR"] }],
    ["mon,wed,fri", { kind: "weekdays", days: ["MO", "WE", "FR"] }],
    ["monday-thursday", { kind: "weekdays", days: ["MO", "TU", "WE", "TH"] }],
    ["every-10-days", { kind: "interval", count: 10, unit: "day" }],
    // Every 3 months is the same rule as quarterly, which has a name of its own.
    ["every-3-months", { kind: "period", period: "quarterly" }],
    ["every-4-months", { kind: "interval", count: 4, unit: "month" }],
  ];

  for (const [written, expected] of kinds) {
    it(`reads ${written}`, () => {
      assert.deepEqual(draft({ when: TODAY, repeat: written }).repeat, expected);
    });
  }

  it("keeps a rule with no control of its own as written", () => {
    assert.deepEqual(draft({ when: TODAY, repeat: "FREQ=WEEKLY;UNTIL=20261231" }).repeat, {
      kind: "raw",
      text: "FREQ=WEEKLY;UNTIL=20261231",
    });
  });

  it("keeps a rule it cannot read at all as written", () => {
    assert.deepEqual(draft({ when: TODAY, repeat: "every-other-tuesday" }).repeat, {
      kind: "raw",
      text: "every-other-tuesday",
    });
  });

  it("reads no repeat as none", () => {
    assert.deepEqual(draft({ when: TODAY }).repeat, { kind: "none" });
  });
});

describe("writing a draft", () => {
  it("writes an all-day day as a bare date", () => {
    assert.deepEqual(roundTrip({ when: "2026-09-14" }), { when: "2026-09-14" });
  });

  it("writes an all-day span with its length", () => {
    assert.deepEqual(roundTrip({ when: "2026-09-14/P3D" }), { when: "2026-09-14/P3D" });
  });

  it("always spells out a timed length", () => {
    assert.deepEqual(roundTrip({ when: "2026-08-18T14:00" }), { when: "2026-08-18T14:00/PT1H" });
  });

  it("writes hours and minutes together", () => {
    assert.deepEqual(roundTrip({ when: "2026-08-18T14:00/PT90M" }), {
      when: "2026-08-18T14:00/PT1H30M",
    });
  });

  it("writes a length of whole days without a time part", () => {
    const read = draft({ when: "2026-08-18T14:00" });
    assert.deepEqual(writeDraft({ ...read, minutes: 2 * 24 * 60 }).when, "2026-08-18T14:00/P2D");
  });

  it("keeps a UTC offset", () => {
    assert.deepEqual(roundTrip({ when: "2026-08-18T14:00-04:00/PT90M" }), {
      when: "2026-08-18T14:00-04:00/PT1H30M",
    });
  });

  it("keeps a bare time bare, so the event stays on the day it was created", () => {
    assert.deepEqual(roundTrip({ when: "16:00/PT30M" }), { when: "16:00/PT30M" });
  });

  it("spells the date out once the date is picked", () => {
    const read = draft({ when: "16:00/PT30M" });
    const written = writeDraft({ ...read, date: "2026-12-01", dateImplied: false });
    assert.equal(written.when, "2026-12-01T16:00/PT30M");
  });

  it("leaves a repeat on its own alone, since its start is still today", () => {
    assert.deepEqual(roundTrip({ repeat: "daily" }), { repeat: "daily" });
  });

  it("spells out an implied start once there is no repeat to declare the event", () => {
    const read = draft({ repeat: "daily" });
    const written = writeDraft({ ...read, repeat: { kind: "none" } });
    assert.equal(written.whenImplied, true);
    assert.deepEqual(toDirectiveSource(written), { when: TODAY });
  });

  it("writes a timed event from a repeat on its own as a bare time", () => {
    const read = draft({ repeat: "daily" });
    assert.deepEqual(toDirectiveSource(writeDraft({ ...read, allDay: false })), {
      when: "09:00/PT1H",
      repeat: "daily",
    });
  });

  it("clamps a length that is zero or negative", () => {
    const read = draft({ when: "2026-08-18T14:00" });
    assert.equal(writeDraft({ ...read, minutes: 0 }).when, "2026-08-18T14:00/PT1M");
    assert.equal(writeDraft({ ...read, days: 0, allDay: true }).when, "2026-08-18");
  });
});

describe("writing a repeat", () => {
  function written(repeat: DirectiveDraft["repeat"]): string | undefined {
    return writeDraft({ ...draft({ when: TODAY }), repeat }).repeat;
  }

  it("writes each period as its own word", () => {
    assert.equal(written({ kind: "period", period: "fortnightly" }), "fortnightly");
    assert.equal(written({ kind: "period", period: "quarterly" }), "quarterly");
  });

  it("writes the working week as weekdays", () => {
    assert.equal(written({ kind: "weekdays", days: ["MO", "TU", "WE", "TH", "FR"] }), "weekdays");
  });

  it("writes a run of three or more days as a range", () => {
    assert.equal(written({ kind: "weekdays", days: ["TU", "WE", "TH"] }), "tuesday-thursday");
  });

  it("lists days that do not run together", () => {
    assert.equal(written({ kind: "weekdays", days: ["FR", "MO", "WE"] }), "mon,wed,fri");
  });

  it("writes nothing for a weekday list with nothing chosen", () => {
    assert.equal(written({ kind: "weekdays", days: [] }), undefined);
  });

  it("writes an interval of one as its period", () => {
    assert.equal(written({ kind: "interval", count: 1, unit: "week" }), "weekly");
  });

  it("writes a longer interval as every-n-units", () => {
    assert.equal(written({ kind: "interval", count: 10, unit: "day" }), "every-10-days");
  });

  it("writes a raw rule as written, and an empty one not at all", () => {
    assert.equal(
      written({ kind: "raw", text: "FREQ=MONTHLY;BYMONTHDAY=1" }),
      "FREQ=MONTHLY;BYMONTHDAY=1",
    );
    assert.equal(written({ kind: "raw", text: "  " }), undefined);
  });
});

describe("previewing a draft", () => {
  it("shows both directives", () => {
    assert.equal(
      previewDirective(writeDraft(draft({ when: "2026-08-18T14:00/PT1H", repeat: "weekdays" }))),
      "gcal:2026-08-18T14:00/PT1H gcal-repeat:weekdays",
    );
  });

  it("shows only the repeat while the start stays implied", () => {
    assert.equal(previewDirective(writeDraft(draft({ repeat: "daily" }))), "gcal-repeat:daily");
  });
});

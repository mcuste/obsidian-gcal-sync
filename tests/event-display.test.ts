import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DisplayOptions, describeEvent } from "../src/event-display";
import type { VaultCalendarEvent } from "../src/event-parser";

type DisplayEvent = Pick<VaultCalendarEvent, "start" | "end" | "recurrence">;

const ZONE = "Europe/Lisbon";
const OPTIONS: DisplayOptions = {
  timeZone: ZONE,
  now: new Date("2026-08-01T12:00:00Z"),
  locale: "en-GB",
};

function allDay(start: string, end: string, recurrence?: string[]): DisplayEvent {
  return { start: { date: start }, end: { date: end }, ...(recurrence ? { recurrence } : {}) };
}

function timed(start: string, end: string, recurrence?: string[]): DisplayEvent {
  return {
    start: { dateTime: start, timeZone: ZONE },
    end: { dateTime: end, timeZone: ZONE },
    ...(recurrence ? { recurrence } : {}),
  };
}

/** Intl spaces a range with thin and no-break spaces, and which one moves between ICU versions. */
function plain(value: string): string {
  return value.replace(/[\u2009\u202f\u00a0]/g, " ");
}

function when(event: DisplayEvent, options: DisplayOptions = OPTIONS): string {
  return plain(describeEvent(event, options).when);
}

function repeat(rule: string): string | undefined {
  const described = describeEvent(allDay("2026-08-18", "2026-08-19", [rule]), OPTIONS).repeat;
  return described === undefined ? undefined : plain(described);
}

describe("describeEvent", () => {
  it("names the weekday of a one-off all-day event", () => {
    assert.equal(when(allDay("2026-08-18", "2026-08-19")), "Tue 18 Aug");
  });

  it("says today, tomorrow, and yesterday for a one-off event", () => {
    assert.equal(when(allDay("2026-08-01", "2026-08-02")), "Today");
    assert.equal(when(allDay("2026-08-02", "2026-08-03")), "Tomorrow");
    assert.equal(when(allDay("2026-07-31", "2026-08-01")), "Yesterday");
  });

  it("shows the last day of a multi-day all-day event, not the exclusive end", () => {
    assert.equal(when(allDay("2026-08-18", "2026-08-21")), "18 – 20 Aug");
  });

  it("adds the year only when it is not the current one", () => {
    assert.match(when(allDay("2027-03-04", "2027-03-05")), /2027/);
    assert.doesNotMatch(when(allDay("2026-03-04", "2026-03-05")), /2026/);
  });

  it("puts a timed event on one line as a range", () => {
    assert.equal(
      when(timed("2026-08-18T14:00:00", "2026-08-18T15:00:00")),
      "Tue 18 Aug, 14:00–15:00",
    );
  });

  it("writes both dates when a timed event crosses midnight", () => {
    assert.equal(
      when(timed("2026-08-18T23:00:00", "2026-08-19T02:00:00")),
      "18 Aug 23:00 – 19 Aug 02:00",
    );
  });

  it("reads a start carrying an offset in the event time zone", () => {
    assert.equal(
      when({
        start: { dateTime: "2026-08-18T14:00:00-04:00", timeZone: "America/New_York" },
        end: { dateTime: "2026-08-18T15:00:00-04:00", timeZone: "America/New_York" },
      }),
      "Tue 18 Aug, 14:00–15:00",
    );
  });

  it("drops the weekday and relative wording for a repeating event, which the rule carries", () => {
    const rule = ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"];
    assert.equal(
      when(timed("2026-08-18T09:15:00", "2026-08-18T09:30:00", rule)),
      "18 Aug, 09:15–09:30",
    );
    assert.equal(when(allDay("2026-08-01", "2026-08-02", ["RRULE:FREQ=DAILY"])), "1 Aug");
  });

  it("follows the locale for month names, weekdays, and the clock", () => {
    assert.equal(
      when(timed("2026-08-18T14:00:00", "2026-08-18T15:00:00"), { ...OPTIONS, locale: "en-US" }),
      "Tue, Aug 18, 2:00 – 3:00 PM",
    );
  });

  it("keeps a wall-clock start where the note wrote it whatever the device zone", () => {
    assert.equal(
      when(timed("2026-08-18T14:00:00", "2026-08-18T15:00:00"), {
        ...OPTIONS,
        timeZone: "Asia/Tokyo",
      }),
      "Tue 18 Aug, 14:00–15:00",
    );
  });
});

describe("recurrence in words", () => {
  it("phrases the named intervals", () => {
    assert.equal(repeat("RRULE:FREQ=DAILY"), "daily");
    assert.equal(repeat("RRULE:FREQ=WEEKLY"), "weekly");
    assert.equal(repeat("RRULE:FREQ=MONTHLY"), "monthly");
    assert.equal(repeat("RRULE:FREQ=YEARLY"), "yearly");
  });

  it("phrases an interval of more than one", () => {
    assert.equal(repeat("RRULE:FREQ=WEEKLY;INTERVAL=2"), "every 2 weeks");
    assert.equal(repeat("RRULE:FREQ=MONTHLY;INTERVAL=3"), "every 3 months");
    assert.equal(repeat("RRULE:FREQ=DAILY;INTERVAL=10"), "every 10 days");
  });

  it("shortens a run of weekdays and lists the rest", () => {
    assert.equal(repeat("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), "Mon–Fri");
    assert.equal(repeat("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"), "Mon, Wed, Fri");
    assert.equal(repeat("RRULE:FREQ=WEEKLY;BYDAY=SA,SU"), "Sat, Sun");
    assert.equal(repeat("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2"), "Mon, Wed, every 2 weeks");
  });

  it("phrases a day of the month", () => {
    assert.equal(repeat("RRULE:FREQ=MONTHLY;BYMONTHDAY=1"), "monthly on day 1");
    assert.equal(repeat("RRULE:FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=3"), "every 3 months on day 15");
  });

  it("shows a rule it cannot phrase exactly as written", () => {
    assert.equal(
      repeat("RRULE:FREQ=WEEKLY;UNTIL=20261231T000000Z"),
      "FREQ=WEEKLY;UNTIL=20261231T000000Z",
    );
    assert.equal(repeat("RRULE:FREQ=MONTHLY;BYDAY=1MO"), "FREQ=MONTHLY;BYDAY=1MO");
  });
});

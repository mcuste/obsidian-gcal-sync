import { currentDate, normalizeRecurrence } from "./event-parser";

/** A declaration as written: the `gcal:` value, and the `gcal-repeat:` value beside it. */
export interface DirectiveSource {
  /** Absent when only a repeat was written, which starts today. */
  when?: string;
  repeat?: string;
}

export type RepeatPeriod = "daily" | "weekly" | "fortnightly" | "monthly" | "quarterly" | "yearly";
export type RepeatUnit = "day" | "week" | "month" | "year";

/**
 * The repeat choices the picker offers. `raw` keeps a rule the picker has no control for, such as
 * an RRULE with an end date, so opening the picker does not simplify it.
 */
export type RepeatDraft =
  | { kind: "none" }
  | { kind: "period"; period: RepeatPeriod }
  | { kind: "weekdays"; days: string[] }
  | { kind: "interval"; count: number; unit: RepeatUnit }
  | { kind: "raw"; text: string };

/** What the picker edits. The date and time carry no zone, so they cannot shift while it is open. */
export interface DirectiveDraft {
  allDay: boolean;
  /** `YYYY-MM-DD`. */
  date: string;
  /** The date came from today, not from the note, so it is left out when written back. */
  dateImplied: boolean;
  /** `HH:MM`, used when the event is timed. */
  time: string;
  /** `Z` or a UTC offset as written. Kept, so the event stays at the same instant. */
  offset: string;
  /** Length, used when the event is all day. */
  days: number;
  /** Length, used when the event is timed. */
  minutes: number;
  repeat: RepeatDraft;
}

export interface WrittenDirective {
  when: string;
  repeat?: string;
  /** The start is today and all day, which is the same as writing no `gcal:` at all. */
  whenImplied: boolean;
}

export interface DraftOptions {
  timeZone: string;
  now?: Date;
}

export const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SHORT_DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WORKING_WEEK = "MO,TU,WE,TH,FR";

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
const LOCAL_START = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
const ZONED_START = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/;
const TIME_ONLY = /^(\d{2}:\d{2})$/;
const ALL_DAY_DURATION = /^P(\d+)D$/;
const TIMED_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_MINUTES = 60;
const DEFAULT_TIME = "09:00";
/** A cap on the length, far past anything a declaration needs. */
const MAX_DAYS = 366;
const MAX_MINUTES = MAX_DAYS * MINUTES_PER_DAY;

/** Rules that have a name, keyed by what `normalizeRecurrence` returns for them. */
const PERIOD_BY_RULE: Record<string, RepeatPeriod> = {
  "FREQ=DAILY": "daily",
  "FREQ=WEEKLY": "weekly",
  "FREQ=WEEKLY;INTERVAL=2": "fortnightly",
  "FREQ=MONTHLY": "monthly",
  "FREQ=MONTHLY;INTERVAL=3": "quarterly",
  "FREQ=YEARLY": "yearly",
};
const UNIT_BY_FREQUENCY: Record<string, RepeatUnit> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};
const PERIOD_BY_UNIT: Record<RepeatUnit, RepeatPeriod> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};
/** Rule parts an interval or weekday draft can hold. Anything else stays raw. */
const DRAFTABLE_RULE_PARTS = ["FREQ", "INTERVAL", "BYDAY"];

/**
 * Never throws. A declaration it cannot read opens on today, since that is the one being fixed.
 */
export function readDraft(source: DirectiveSource, options: DraftOptions): DirectiveDraft {
  const base = {
    date: currentDate(options.timeZone, options.now ?? new Date()),
    dateImplied: true,
    time: DEFAULT_TIME,
    offset: "",
    days: 1,
    minutes: DEFAULT_MINUTES,
    repeat: readRepeat(source.repeat),
  };

  const written = source.when?.trim();
  // Nothing written means only a repeat, which the parser starts today and all day.
  if (!written) return { ...base, allDay: true };

  const separator = written.indexOf("/");
  const start = separator === -1 ? written : written.slice(0, separator);
  const duration = separator === -1 ? "" : written.slice(separator + 1);

  const dateOnly = DATE_ONLY.exec(start);
  if (dateOnly?.[1]) {
    return {
      ...base,
      allDay: true,
      date: dateOnly[1],
      dateImplied: false,
      days: readDays(duration),
    };
  }

  const zoned = ZONED_START.exec(start);
  if (zoned?.[1] && zoned[2] && zoned[3]) {
    return {
      ...base,
      allDay: false,
      date: zoned[1],
      dateImplied: false,
      time: zoned[2],
      offset: zoned[3],
      minutes: readMinutes(duration),
    };
  }

  const local = LOCAL_START.exec(start);
  if (local?.[1] && local[2]) {
    return {
      ...base,
      allDay: false,
      date: local[1],
      dateImplied: false,
      time: local[2],
      minutes: readMinutes(duration),
    };
  }

  const timeOnly = TIME_ONLY.exec(start);
  if (timeOnly?.[1]) {
    return { ...base, allDay: false, time: timeOnly[1], minutes: readMinutes(duration) };
  }

  // Unreadable. The date is written out, not left implied, so applying visibly replaces it.
  return { ...base, allDay: true, dateImplied: false };
}

/** Timed events always write their length, so nothing falls back to a default. */
export function writeDraft(draft: DirectiveDraft): WrittenDirective {
  const repeat = writeRepeat(draft.repeat);
  const rule = repeat ? { repeat } : {};

  if (draft.allDay) {
    const days = clamp(draft.days, 1, MAX_DAYS);
    return {
      when: days > 1 ? `${draft.date}/P${days}D` : draft.date,
      ...rule,
      whenImplied: draft.dateImplied && days === 1,
    };
  }

  const duration = writeMinutes(clamp(draft.minutes, 1, MAX_MINUTES));
  // A time with no date keeps that form, since today's date would move an event created earlier.
  const start =
    draft.dateImplied && !draft.offset ? draft.time : `${draft.date}T${draft.time}${draft.offset}`;
  return { when: `${start}/${duration}`, ...rule, whenImplied: false };
}

/**
 * An implied start is left out only when a repeat is there to declare the event, so a declaration
 * is never left empty.
 */
export function toDirectiveSource(written: WrittenDirective): DirectiveSource {
  const rule = written.repeat === undefined ? {} : { repeat: written.repeat };
  if (written.whenImplied && written.repeat !== undefined) return rule;
  return { when: written.when, ...rule };
}

export function previewDirective(written: WrittenDirective): string {
  const source = toDirectiveSource(written);
  return [
    ...(source.when === undefined ? [] : [`gcal:${source.when}`]),
    ...(source.repeat === undefined ? [] : [`gcal-repeat:${source.repeat}`]),
  ].join(" ");
}

/** Weekday codes in Monday-first order, without duplicates, so the rule is always the same. */
export function orderWeekdays(days: readonly string[]): string[] {
  return WEEKDAY_CODES.filter((code) => days.includes(code));
}

function readDays(duration: string): number {
  const days = Number(ALL_DAY_DURATION.exec(duration)?.[1]);
  return Number.isInteger(days) && days >= 1 ? Math.min(days, MAX_DAYS) : 1;
}

function readMinutes(duration: string): number {
  if (!duration) return DEFAULT_MINUTES;
  const match = TIMED_DURATION.exec(duration);
  if (!match) return DEFAULT_MINUTES;
  const total =
    Number(match[1] ?? 0) * MINUTES_PER_DAY + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return total > 0 ? Math.min(total, MAX_MINUTES) : DEFAULT_MINUTES;
}

function readRepeat(written?: string): RepeatDraft {
  const text = written?.trim();
  if (!text) return { kind: "none" };

  let rule: string;
  try {
    rule = normalizeRecurrence(text).replace(/^RRULE:/, "");
  } catch {
    return { kind: "raw", text };
  }

  const period = PERIOD_BY_RULE[rule];
  if (period) return { kind: "period", period };

  const parts = ruleParts(rule);
  if (Array.from(parts.keys()).some((part) => !DRAFTABLE_RULE_PARTS.includes(part))) {
    return { kind: "raw", text };
  }
  const unit = UNIT_BY_FREQUENCY[parts.get("FREQ") ?? ""];
  const interval = Number(parts.get("INTERVAL") ?? 1);
  if (!unit || !Number.isInteger(interval) || interval < 1) return { kind: "raw", text };

  const byDay = parts.get("BYDAY");
  if (byDay === undefined) return { kind: "interval", count: interval, unit };

  const days = byDay.split(",");
  if (unit !== "week" || interval !== 1 || !days.every((day) => WEEKDAY_CODES.includes(day))) {
    return { kind: "raw", text };
  }
  return { kind: "weekdays", days: orderWeekdays(days) };
}

function ruleParts(rule: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const part of rule.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) parts.set(part.slice(0, separator), part.slice(separator + 1));
  }
  return parts;
}

function writeRepeat(repeat: RepeatDraft): string | undefined {
  switch (repeat.kind) {
    case "none":
      return undefined;
    case "period":
      return repeat.period;
    case "weekdays":
      return writeWeekdays(repeat.days);
    case "interval": {
      const count = clamp(repeat.count, 1, 999);
      return count === 1 ? PERIOD_BY_UNIT[repeat.unit] : `every-${count}-${repeat.unit}s`;
    }
    case "raw":
      return repeat.text.trim() || undefined;
  }
}

/** Monday to Friday is `weekdays`, three or more days in a row is a range, the rest is a list. */
function writeWeekdays(days: readonly string[]): string | undefined {
  const ordered = orderWeekdays(days);
  if (ordered.length === 0) return undefined;
  if (ordered.join(",") === WORKING_WEEK) return "weekdays";

  const indexes = ordered.map((code) => WEEKDAY_CODES.indexOf(code));
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (first !== undefined && last !== undefined && indexes.length >= 3) {
    if (last - first === indexes.length - 1) return `${DAY_NAMES[first]}-${DAY_NAMES[last]}`;
  }
  return indexes.map((index) => SHORT_DAY_NAMES[index]).join(",");
}

function writeMinutes(total: number): string {
  const days = Math.floor(total / MINUTES_PER_DAY);
  const rest = total % MINUTES_PER_DAY;
  const hours = Math.floor(rest / 60);
  const minutes = rest % 60;
  const dayPart = days > 0 ? `${days}D` : "";
  const timePart = `${hours > 0 ? `${hours}H` : ""}${minutes > 0 ? `${minutes}M` : ""}`;
  return timePart ? `P${dayPart}T${timePart}` : `P${dayPart}`;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(Math.trunc(value), low), high);
}

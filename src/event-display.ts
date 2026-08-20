import type { CalendarDateTime, VaultCalendarEvent } from "./event-parser";

export interface EventDisplay {
  /** Such as "Tue 18 Aug, 14:00–15:00", or "Today". */
  when: string;
  /** Such as "Mon–Fri". Absent when the event happens once. */
  repeat?: string;
}

export interface DisplayOptions {
  /** Zone for a start with no UTC offset, and for working out "today". */
  timeZone: string;
  now?: Date;
  /** Empty follows the device. Tests set it so the wording stays the same. */
  locale?: string;
}

const EN_DASH = "–";
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A moment as the calendar shows it. No zone, so nothing can shift it. */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

type DisplayEvent = Pick<VaultCalendarEvent, "start" | "end" | "recurrence">;

export function describeEvent(event: DisplayEvent, options: DisplayOptions): EventDisplay {
  const rule = event.recurrence?.[0];
  const repeat = rule ? describeRecurrence(rule, options.locale) : undefined;
  const zone = event.start.timeZone || options.timeZone;
  const today = wallClockIn(options.now ?? new Date(), zone, options.locale);
  // A repeat rule already says when the event happens, so its date needs no weekday or "Today".
  const once = repeat === undefined;

  return {
    when: event.start.date
      ? allDayWhen(event, today, once, options)
      : timedWhen(event, zone, today, once, options),
    ...(repeat ? { repeat } : {}),
  };
}

function allDayWhen(
  event: DisplayEvent,
  today: WallClock,
  once: boolean,
  options: DisplayOptions,
): string {
  const start = readCalendarDate(event.start.date ?? "");
  const endExclusive = event.end.date ? readCalendarDate(event.end.date) : addDays(start, 1);
  const lastDay = addDays(endExclusive, -1);

  if (sameDate(start, lastDay)) {
    return dateLabel(start, { today, once, weekday: once, locale: options.locale });
  }
  return dateRange(start, lastDay, today, options.locale);
}

function timedWhen(
  event: DisplayEvent,
  zone: string,
  today: WallClock,
  once: boolean,
  options: DisplayOptions,
): string {
  const start = readCalendarDateTime(event.start, zone, options.locale);
  const end = readCalendarDateTime(event.end, zone, options.locale);
  const date = dateLabel(start, { today, once, weekday: once, locale: options.locale });

  if (sameDate(start, end)) {
    return `${date}, ${timeFormat(options.locale).formatRange(instant(start), instant(end))}`;
  }
  // "Today 23:00 - 19 Aug 02:00" would read as one date, so both ends get a plain date.
  const startLabel = dateLabel(start, {
    today,
    once: false,
    weekday: false,
    locale: options.locale,
  });
  const endLabel = dateLabel(end, { today, once: false, weekday: false, locale: options.locale });
  return `${startLabel} ${timeOf(start, options.locale)} ${EN_DASH} ${endLabel} ${timeOf(end, options.locale)}`;
}

interface DateLabelOptions {
  today: WallClock;
  /** Allows "Today" and its neighbours, which only fit an event happening once. */
  once: boolean;
  weekday: boolean;
  locale?: string;
}

function dateLabel(clock: WallClock, options: DateLabelOptions): string {
  if (options.once) {
    const offset = dayOffset(clock, options.today);
    if (offset === 0) return "Today";
    if (offset === 1) return "Tomorrow";
    if (offset === -1) return "Yesterday";
  }
  return dateFormat(options.locale, {
    weekday: options.weekday,
    year: clock.year !== options.today.year,
  }).format(instant(clock));
}

function dateRange(start: WallClock, end: WallClock, today: WallClock, locale?: string): string {
  const year = start.year !== today.year || end.year !== today.year;
  return dateFormat(locale, { weekday: false, year }).formatRange(instant(start), instant(end));
}

function timeOf(clock: WallClock, locale?: string): string {
  return timeFormat(locale).format(instant(clock));
}

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const UNIT_BY_FREQUENCY: Record<string, string> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};
const WORD_BY_FREQUENCY: Record<string, string> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};
/** Parts that can be put into words. */
const KNOWN_RULE_PARTS = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY"];

/**
 * A repeat rule in words, or the rule as written when it cannot be phrased exactly. A chip never
 * claims a repeat the calendar does not use.
 */
function describeRecurrence(rule: string, locale?: string): string {
  const written = rule.replace(/^RRULE:/, "");
  const parts = new Map<string, string>();
  for (const part of written.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) parts.set(part.slice(0, separator), part.slice(separator + 1));
  }

  const frequency = parts.get("FREQ") ?? "";
  const unit = UNIT_BY_FREQUENCY[frequency];
  if (!unit) return written;
  if (Array.from(parts.keys()).some((part) => !KNOWN_RULE_PARTS.includes(part))) return written;

  const interval = Number(parts.get("INTERVAL") ?? 1);
  if (!Number.isInteger(interval) || interval < 1) return written;
  const every =
    interval === 1 ? (WORD_BY_FREQUENCY[frequency] ?? written) : `every ${interval} ${unit}s`;

  const byDay = parts.get("BYDAY");
  const byMonthDay = parts.get("BYMONTHDAY");
  if (byDay && frequency === "WEEKLY") {
    const days = describeDays(byDay, locale);
    if (!days) return written;
    return interval === 1 ? days : `${days}, ${every}`;
  }
  if (byMonthDay && frequency === "MONTHLY" && /^\d{1,2}$/.test(byMonthDay)) {
    return `${every} on day ${Number(byMonthDay)}`;
  }
  if (byDay || byMonthDay) return written;
  return every;
}

/** A run of three or more days becomes "Mon–Fri"; anything else is listed. */
function describeDays(byDay: string, locale?: string): string | undefined {
  const indexes = byDay.split(",").map((code) => WEEKDAY_CODES.indexOf(code));
  if (indexes.some((index) => index === -1)) return undefined;

  const ordered = Array.from(new Set(indexes)).sort((left, right) => left - right);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return undefined;

  // Sorted and deduplicated, so spanning first to last means every day between them is there.
  if (ordered.length >= 3 && last - first === ordered.length - 1) {
    return `${weekdayName(first, locale)}${EN_DASH}${weekdayName(last, locale)}`;
  }
  return ordered.map((index) => weekdayName(index, locale)).join(", ");
}

/** 2024-01-01 was a Monday, which is what makes index 0 Monday. */
function weekdayName(index: number, locale?: string): string {
  return formatter(locale, { timeZone: "UTC", weekday: "short" }).format(
    new Date(Date.UTC(2024, 0, 1 + index)),
  );
}

function readCalendarDate(value: string): WallClock {
  const match = DATE.exec(value);
  return {
    year: Number(match?.[1] ?? 0),
    month: Number(match?.[2] ?? 1),
    day: Number(match?.[3] ?? 1),
    hour: 0,
    minute: 0,
  };
}

/**
 * A start with no Z or offset is already the wall clock to show, so its digits are read off as they
 * are. One with an offset is a fixed instant, so it moves into the event's zone first.
 */
function readCalendarDateTime(value: CalendarDateTime, zone: string, locale?: string): WallClock {
  const text = value.dateTime ?? "";
  if (ZONED.test(text)) return wallClockIn(new Date(text), value.timeZone || zone, locale);

  const match = LOCAL_DATE_TIME.exec(text);
  return {
    year: Number(match?.[1] ?? 0),
    month: Number(match?.[2] ?? 1),
    day: Number(match?.[3] ?? 1),
    hour: Number(match?.[4] ?? 0),
    minute: Number(match?.[5] ?? 0),
  };
}

function wallClockIn(date: Date, zone: string, locale?: string): WallClock {
  const parts = formatter(locale, {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

/** A wall clock as a UTC instant: formatted back in UTC it returns the same digits, unshifted. */
function instant(clock: WallClock): Date {
  return new Date(Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute));
}

function addDays(clock: WallClock, days: number): WallClock {
  const shifted = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: clock.hour,
    minute: clock.minute,
  };
}

function sameDate(first: WallClock, second: WallClock): boolean {
  return first.year === second.year && first.month === second.month && first.day === second.day;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayOffset(clock: WallClock, today: WallClock): number {
  const from = Date.UTC(today.year, today.month - 1, today.day);
  const to = Date.UTC(clock.year, clock.month - 1, clock.day);
  return Math.round((to - from) / DAY_MS);
}

function dateFormat(
  locale: string | undefined,
  options: { weekday: boolean; year: boolean },
): Intl.DateTimeFormat {
  return formatter(locale, {
    timeZone: "UTC",
    ...(options.weekday ? { weekday: "short" as const } : {}),
    day: "numeric",
    month: "short",
    ...(options.year ? { year: "numeric" as const } : {}),
  });
}

function timeFormat(locale: string | undefined): Intl.DateTimeFormat {
  return formatter(locale, { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
}

/** Built once per shape: every visible declaration is formatted again on each editor update. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale ?? ""} ${JSON.stringify(options)}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const built = new Intl.DateTimeFormat(locale, options);
  formatters.set(key, built);
  return built;
}

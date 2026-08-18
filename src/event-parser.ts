import { createHash } from "node:crypto";

export interface CalendarDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface VaultCalendarEvent {
  /** Local identity: `<note path>::<locator>`. Never leaves this device. */
  sourceKey: string;
  /** The identity stored on Google, hashed so note and folder names are not uploaded. */
  remoteSourceKey: string;
  summary: string;
  start: CalendarDateTime;
  end: CalendarDateTime;
  recurrence?: string[];
  /**
   * The note gave a time but no date, so the date was filled in from today. Once the event exists
   * on Google its own date wins, which keeps the event where it was first created.
   */
  impliedDate?: true;
}

export interface ParseIssue {
  sourcePath: string;
  location: string;
  message: string;
}

export interface ParseResult {
  events: VaultCalendarEvent[];
  issues: ParseIssue[];
}

interface ParseFileOptions {
  path: string;
  basename: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  timeZone: string;
  vaultId: string;
  /** Resolves a bare time such as 14:00 to a date. Defaults to the current moment. */
  now?: Date;
}

const EVENT_DIRECTIVE = /#gcal:([^\s#]+)/g;
const REPEAT_DIRECTIVE = /#gcal-repeat:([^\s#]+)/i;
const ID_DIRECTIVE = /#gcal-id:([a-zA-Z0-9_-]+)/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const LOCAL_TIME = /^\d{2}:\d{2}$/;
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;
const RRULE = /^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;[A-Z]+=[A-Z0-9,+-]+)*$/;

export const MAX_EVENTS_PER_NOTE = 100;
const DEFAULT_EVENT_MS = 60 * 60 * 1000;

const DAY_CODES: Record<string, string> = {
  monday: "MO",
  mon: "MO",
  tuesday: "TU",
  tue: "TU",
  wednesday: "WE",
  wed: "WE",
  thursday: "TH",
  thu: "TH",
  friday: "FR",
  fri: "FR",
  saturday: "SA",
  sat: "SA",
  sunday: "SU",
  sun: "SU",
};
/** Frequencies that "every 2 weeks" style rules build on. */
const UNIT_FREQUENCIES: Record<string, string> = {
  day: "DAILY",
  week: "WEEKLY",
  month: "MONTHLY",
  year: "YEARLY",
};
const NAMED_INTERVALS: Record<string, string> = {
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  fortnightly: "FREQ=WEEKLY;INTERVAL=2",
  monthly: "FREQ=MONTHLY",
  quarterly: "FREQ=MONTHLY;INTERVAL=3",
  yearly: "FREQ=YEARLY",
  annually: "FREQ=YEARLY",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
};
const EVERY_N_UNITS = /^(\d+)-(day|week|month|year)s?$/;
const EVERY_UNIT = /^(day|week|month|year)s?$/;

const ORDERED_DAY_NAMES = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export function parseVaultEvents(options: ParseFileOptions): ParseResult {
  const result: ParseResult = { events: [], issues: [] };
  parseFrontmatter(options, result);
  parseLines(options, result);

  const keys = new Set<string>();
  for (const event of result.events) {
    if (keys.has(event.sourceKey)) {
      result.issues.push({
        sourcePath: options.path,
        location: event.sourceKey,
        message: "Duplicate gcal ID in this note",
      });
    }
    keys.add(event.sourceKey);
  }

  if (result.events.length > MAX_EVENTS_PER_NOTE) {
    result.issues.push({
      sourcePath: options.path,
      location: "note",
      message: `A note can declare at most ${MAX_EVENTS_PER_NOTE} calendar events`,
    });
  }

  if (result.issues.length > 0) {
    result.events = [];
  }
  return result;
}

function parseFrontmatter(options: ParseFileOptions, result: ParseResult): void {
  const rawEvents = toStringArray(options.frontmatter?.gcal);
  if (rawEvents.length === 0) return;

  const repeats = toStringArray(options.frontmatter?.["gcal-repeat"]);
  const ids = toStringArray(options.frontmatter?.["gcal-id"]);

  rawEvents.forEach((raw, index) => {
    const id = ids[index] ?? (rawEvents.length === 1 ? ids[0] : undefined);
    const repeat = repeats[index] ?? (rawEvents.length === 1 ? repeats[0] : undefined);
    addEvent(result, options, {
      raw,
      repeat,
      summary: options.basename,
      sourceKey: makeSourceKey(options.path, id ?? `frontmatter-${index + 1}`),
      location: `frontmatter gcal${rawEvents.length > 1 ? `[${index}]` : ""}`,
    });
  });
}

function parseLines(options: ParseFileOptions, result: ParseResult): void {
  const lines = maskIgnoredMarkdown(options.content).split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    const repeat = REPEAT_DIRECTIVE.exec(line)?.[1];
    const explicitId = ID_DIRECTIVE.exec(line)?.[1];
    EVENT_DIRECTIVE.lastIndex = 0;

    let occurrence = 0;
    for (const match of line.matchAll(EVENT_DIRECTIVE)) {
      occurrence += 1;
      const raw = match[1];
      if (!raw) continue;
      const prefix = cleanSummary(line.slice(0, match.index));
      const locator = explicitId
        ? occurrence === 1
          ? explicitId
          : `${explicitId}-${occurrence}`
        : `line-${lineIndex + 1}-${occurrence}`;
      addEvent(result, options, {
        raw,
        repeat,
        summary: prefix || options.basename,
        sourceKey: makeSourceKey(options.path, locator),
        location: `line ${lineIndex + 1}`,
      });
    }
  });
}

function addEvent(
  result: ParseResult,
  options: ParseFileOptions,
  input: {
    raw: string;
    repeat?: string;
    summary: string;
    sourceKey: string;
    location: string;
  },
): void {
  try {
    const schedule = parseSchedule(input.raw, options.timeZone, options.now);
    const recurrence = input.repeat ? [normalizeRecurrence(input.repeat)] : undefined;
    result.events.push({
      sourceKey: input.sourceKey,
      remoteSourceKey: makeRemoteSourceKey(options.vaultId, input.sourceKey),
      summary: input.summary,
      start: schedule.start,
      end: schedule.end,
      recurrence,
      ...(schedule.impliedDate ? { impliedDate: true as const } : {}),
    });
  } catch (error) {
    result.issues.push({
      sourcePath: options.path,
      location: input.location,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface EventSchedule {
  start: CalendarDateTime;
  end: CalendarDateTime;
  impliedDate?: boolean;
}

/**
 * Accepted forms, in order: a date (all-day), a timestamp with no UTC offset (read in `timeZone`),
 * a bare time (today in `timeZone`), and a timestamp carrying Z or an offset (an exact instant).
 * Times are written to the minute; Google is sent the RFC 3339 seconds it requires.
 */
export function parseSchedule(
  raw: string,
  timeZone: string,
  now: Date = new Date(),
): EventSchedule {
  const separator = raw.indexOf("/");
  const startValue = separator === -1 ? raw : raw.slice(0, separator);
  const durationValue = separator === -1 ? undefined : raw.slice(separator + 1);

  if (DATE.test(startValue)) {
    assertValidCalendarDate(startValue);
    const durationDays = durationValue ? parseAllDayDuration(durationValue) : 1;
    return {
      start: { date: startValue },
      end: { date: addUtcDays(startValue, durationDays) },
    };
  }

  const durationMs = durationValue ? parseDuration(durationValue) : DEFAULT_EVENT_MS;

  const impliedDate = LOCAL_TIME.test(startValue);
  if (impliedDate || LOCAL_DATE_TIME.test(startValue)) {
    const local = impliedDate ? `${currentDate(timeZone, now)}T${startValue}` : startValue;
    const start = withSeconds(local);
    assertValidCalendarDate(start.slice(0, 10));
    assertValidWallClock(start);
    return {
      start: { dateTime: start, timeZone },
      end: { dateTime: addWallClockMs(start, durationMs), timeZone },
      ...(impliedDate ? { impliedDate } : {}),
    };
  }

  const absolute = DATE_TIME.exec(startValue);
  if (!absolute?.[1] || !absolute[2]) {
    throw new Error(
      "Expected a date (2026-08-18), a time (14:00), a local timestamp (2026-08-18T14:00), or one with Z or a UTC offset",
    );
  }
  assertValidCalendarDate(startValue.slice(0, 10));
  assertValidWallClock(withSeconds(absolute[1]));

  const start = `${withSeconds(absolute[1])}${absolute[2]}`;
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) throw new Error("Invalid event timestamp");

  return {
    start: { dateTime: start, timeZone },
    end: { dateTime: toRfc3339(new Date(startMs + durationMs)), timeZone },
  };
}

/** Google requires RFC 3339, which mandates seconds, so a minute-precision value gains `:00`. */
function withSeconds(value: string): string {
  return `${value}:00`;
}

function toRfc3339(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function assertValidWallClock(value: string): void {
  const parsed = Date.parse(`${value}Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value) {
    throw new Error("Invalid time of day");
  }
}

/** Today's calendar date in the given time zone, which a bare time is measured against. */
function currentDate(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Adds a duration to a wall-clock timestamp without leaving the time zone. An event that spans a
 * daylight-saving change keeps its wall-clock length, which is how Google reads these values.
 */
function addWallClockMs(value: string, durationMs: number): string {
  return new Date(Date.parse(`${value}Z`) + durationMs).toISOString().slice(0, 19);
}

export function normalizeRecurrence(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^every-/, "");
  const named = NAMED_INTERVALS[normalized];
  if (named) return `RRULE:${named}`;

  const everyN = EVERY_N_UNITS.exec(normalized);
  if (everyN?.[1] && everyN[2]) {
    const interval = Number(everyN[1]);
    if (!Number.isInteger(interval) || interval < 1) {
      throw new Error("Repeat interval must be a whole number of units, such as every-2-weeks");
    }
    const frequency = UNIT_FREQUENCIES[everyN[2]];
    return interval === 1
      ? `RRULE:FREQ=${frequency}`
      : `RRULE:FREQ=${frequency};INTERVAL=${interval}`;
  }

  const everyUnit = EVERY_UNIT.exec(normalized);
  if (everyUnit?.[1]) return `RRULE:FREQ=${UNIT_FREQUENCIES[everyUnit[1]]}`;

  const range = /^([a-z]+)-([a-z]+)$/.exec(normalized);
  if (range?.[1] && range[2]) {
    const first = normalizeDayName(range[1]);
    const last = normalizeDayName(range[2]);
    const firstIndex = ORDERED_DAY_NAMES.indexOf(first);
    const lastIndex = ORDERED_DAY_NAMES.indexOf(last);
    if (firstIndex === -1 || lastIndex < firstIndex) {
      throw new Error("Invalid recurring weekday range");
    }
    const days = ORDERED_DAY_NAMES.slice(firstIndex, lastIndex + 1).map((day) => DAY_CODES[day]);
    return `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")}`;
  }

  const dayList = normalized.split(",");
  if (dayList.length > 0 && dayList.every((day) => DAY_CODES[day] !== undefined)) {
    return `RRULE:FREQ=WEEKLY;BYDAY=${dayList.map((day) => DAY_CODES[day]).join(",")}`;
  }

  const rrule = value.toUpperCase().replace(/^RRULE:/, "");
  if (!RRULE.test(rrule)) {
    throw new Error(
      "Invalid recurrence; use weekly, quarterly, every-2-weeks, monday-thursday, or an RRULE",
    );
  }
  return `RRULE:${rrule}`;
}

function parseAllDayDuration(value: string): number {
  const match = /^P(\d+)D$/.exec(value);
  const days = Number(match?.[1]);
  if (!match || days < 1) throw new Error("All-day durations must use PnD, such as P1D");
  return days;
}

function parseDuration(value: string): number {
  const match = DURATION.exec(value);
  if (!match) throw new Error("Invalid duration; use days, hours, and minutes such as PT90M");
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const durationMs = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
  if (durationMs <= 0) throw new Error("Event duration must be greater than zero");
  return durationMs;
}

function assertValidCalendarDate(value: string): void {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid calendar date");
  }
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function cleanSummary(value: string): string {
  return value
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/\s+#gcal-(?:repeat|id):[^\s#]+/gi, "")
    .trim();
}

function maskIgnoredMarkdown(content: string): string {
  return maskFencesAndComments(maskInlineCode(content));
}

function maskInlineCode(content: string): string {
  const runs: Array<{ start: number; end: number; length: number; canOpen: boolean }> = [];
  for (let index = 0; index < content.length; ) {
    if (content[index] !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    while (content[index] === "`") index += 1;
    runs.push({
      start,
      end: index,
      length: index - start,
      canOpen: !isEscaped(content, start),
    });
  }

  const nextByLength = new Map<number, number>();
  const nextSameLength = new Array<number | undefined>(runs.length);
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) continue;
    nextSameLength[index] = nextByLength.get(run.length);
    nextByLength.set(run.length, index);
  }

  const masked = content.split("");
  for (let index = 0; index < runs.length; index += 1) {
    const opening = runs[index];
    const closingIndex = nextSameLength[index];
    if (!opening?.canOpen || closingIndex === undefined) continue;
    const closing = runs[closingIndex];
    if (!closing) continue;
    maskRange(masked, opening.start, closing.end);
    index = closingIndex;
  }
  return masked.join("");
}

function maskFencesAndComments(content: string): string {
  const lines = content.split(/\r?\n/);
  let commentOpen = false;
  let fence: { marker: string; length: number } | undefined;

  return lines
    .map((line) => {
      if (fence) {
        if (isClosingFence(line, fence)) fence = undefined;
        return " ".repeat(line.length);
      }

      const commentResult = maskHtmlComments(line, commentOpen);
      commentOpen = commentResult.commentOpen;
      const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(commentResult.line)?.[1];
      if (!opening) return commentResult.line;

      fence = { marker: opening[0] ?? "", length: opening.length };
      return " ".repeat(line.length);
    })
    .join("\n");
}

function maskHtmlComments(
  line: string,
  initiallyOpen: boolean,
): { line: string; commentOpen: boolean } {
  const masked = line.split("");
  let commentOpen = initiallyOpen;
  let cursor = 0;

  while (cursor < line.length) {
    if (commentOpen) {
      const end = line.indexOf("-->", cursor);
      if (end === -1) {
        maskRange(masked, cursor, line.length);
        break;
      }
      maskRange(masked, cursor, end + 3);
      cursor = end + 3;
      commentOpen = false;
      continue;
    }

    const start = line.indexOf("<!--", cursor);
    if (start === -1) break;
    const end = line.indexOf("-->", start + 4);
    if (end === -1) {
      maskRange(masked, start, line.length);
      commentOpen = true;
      break;
    }
    maskRange(masked, start, end + 3);
    cursor = end + 3;
  }

  return { line: masked.join(""), commentOpen };
}

function isClosingFence(line: string, fence: { marker: string; length: number }): boolean {
  let cursor = 0;
  while (cursor < 3 && line[cursor] === " ") cursor += 1;
  const start = cursor;
  while (line[cursor] === fence.marker) cursor += 1;
  return cursor - start >= fence.length && line.slice(cursor).trim().length === 0;
}

function isEscaped(content: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function maskRange(content: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (content[index] !== "\n" && content[index] !== "\r") content[index] = " ";
  }
}

function makeSourceKey(path: string, locator: string): string {
  return `${path}::${locator}`;
}

export function makeRemoteSourceKey(vaultId: string, sourceKey: string): string {
  const digest = createHash("sha256")
    .update(vaultId)
    .update("\0")
    .update(sourceKey)
    .digest("base64url");
  return `v1:${digest}`;
}

function normalizeDayName(value: string): string {
  const code = DAY_CODES[value];
  const entry = Object.entries(DAY_CODES).find(([, candidate]) => candidate === code);
  return entry?.[0] ?? value;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

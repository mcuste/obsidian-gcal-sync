export interface CalendarDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface VaultCalendarEvent {
  sourceKey: string;
  sourcePath: string;
  summary: string;
  start: CalendarDateTime;
  end: CalendarDateTime;
  recurrence?: string[];
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
}

const EVENT_DIRECTIVE = /#gcal:([^\s#]+)/g;
const REPEAT_DIRECTIVE = /#gcal-repeat:([^\s#]+)/i;
const ID_DIRECTIVE = /#gcal-id:([a-zA-Z0-9_-]+)/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const RRULE = /^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;[A-Z]+=[A-Z0-9,+-]+)*$/;

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
  const lines = options.content.split(/\r?\n/);
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
    const schedule = parseSchedule(input.raw, options.timeZone);
    const recurrence = input.repeat ? [normalizeRecurrence(input.repeat)] : undefined;
    result.events.push({
      sourceKey: input.sourceKey,
      sourcePath: options.path,
      summary: input.summary,
      start: schedule.start,
      end: schedule.end,
      recurrence,
    });
  } catch (error) {
    result.issues.push({
      sourcePath: options.path,
      location: input.location,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseSchedule(
  raw: string,
  timeZone: string,
): { start: CalendarDateTime; end: CalendarDateTime } {
  const separator = raw.indexOf("/");
  const startValue = separator === -1 ? raw : raw.slice(0, separator);
  const durationValue = separator === -1 ? undefined : raw.slice(separator + 1);

  const dateMatch = DATE.exec(startValue);
  if (dateMatch) {
    assertValidCalendarDate(startValue);
    const durationDays = durationValue ? parseAllDayDuration(durationValue) : 1;
    return {
      start: { date: startValue },
      end: { date: addUtcDays(startValue, durationDays) },
    };
  }

  if (!DATE_TIME.test(startValue)) {
    throw new Error("Expected YYYY-MM-DD or an RFC 3339 timestamp with Z or a UTC offset");
  }
  assertValidCalendarDate(startValue.slice(0, 10));

  const durationMs = durationValue ? parseDuration(durationValue) : 60 * 60 * 1000;
  const startMs = Date.parse(startValue);
  if (!Number.isFinite(startMs)) throw new Error("Invalid event timestamp");

  return {
    start: { dateTime: startValue, timeZone },
    end: { dateTime: new Date(startMs + durationMs).toISOString(), timeZone },
  };
}

export function normalizeRecurrence(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^every-/, "");
  if (normalized === "daily") return "RRULE:FREQ=DAILY";
  if (normalized === "weekly") return "RRULE:FREQ=WEEKLY";
  if (normalized === "weekdays") {
    return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
  }

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
    throw new Error("Invalid recurrence; use weekly, monday-thursday, or an RRULE");
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
  if (!match) throw new Error("Invalid ISO 8601 duration");
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const durationMs = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
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

function makeSourceKey(path: string, locator: string): string {
  return `${path}::${locator}`;
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

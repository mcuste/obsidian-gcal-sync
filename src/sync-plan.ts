import type { CalendarDateTime, VaultCalendarEvent } from "./event-parser";

export interface GoogleEvent {
  id?: string;
  summary?: string;
  status?: string;
  /** When Google created the event. Decides which copy of an event is kept. */
  created?: string;
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  recurrence?: string[];
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

export interface ReconciliationPlan {
  creates: VaultCalendarEvent[];
  updates: Array<{ eventId: string; event: VaultCalendarEvent }>;
  deletes: string[];
  /**
   * Extra copies of an event that is being kept, left behind by two syncs running at once. One copy
   * always survives, so removing these deletes nothing the notes still declare.
   */
  duplicates: string[];
  /** Source keys already correct on Google, so they need no request. */
  unchanged: string[];
}

export function planReconciliation(
  desiredEvents: Iterable<VaultCalendarEvent>,
  remoteEvents: GoogleEvent[],
  affectedSourceKeys?: ReadonlySet<string>,
): ReconciliationPlan {
  const desiredByKey = new Map(
    Array.from(desiredEvents, (event) => [event.sourceKey, event] as const),
  );
  const remoteByKey = groupRemoteEvents(remoteEvents);
  const plan: ReconciliationPlan = {
    creates: [],
    updates: [],
    deletes: [],
    duplicates: [],
    unchanged: [],
  };

  for (const desired of desiredByKey.values()) {
    const keys = storedKeys(desired);
    if (affectedSourceKeys && !keys.some((key) => affectedSourceKeys.has(key))) continue;

    const matching = keys.flatMap((key) => remoteByKey.get(key) ?? []);
    const current = survivor(matching);
    if (!current) {
      plan.creates.push(desired);
    } else {
      const anchored = anchorImpliedDate(desired, current);
      if (remoteSourceKey(current) !== desired.remoteSourceKey || !eventsEqual(current, anchored)) {
        plan.updates.push({ eventId: requireEventId(current), event: anchored });
      } else {
        plan.unchanged.push(desired.sourceKey);
      }
    }

    for (const duplicate of matching) {
      if (duplicate !== current) plan.duplicates.push(requireEventId(duplicate));
    }
    for (const key of keys) remoteByKey.delete(key);
  }

  const stale: GoogleEvent[] = [];
  for (const [remoteKey, staleEvents] of remoteByKey) {
    if (affectedSourceKeys && !affectedSourceKeys.has(remoteKey)) continue;
    stale.push(...staleEvents);
  }

  reanchorMovedEvents(plan, stale);
  for (const event of stale) plan.deletes.push(requireEventId(event));
  return plan;
}

/**
 * A declaration's key includes its position, so moving a line or renaming the note produces a create
 * and a delete for what is really the same event. Recreating it on Google would lose its guest
 * replies and reminders, so a create matching exactly one stale event becomes an update that
 * rewrites the stored key in place.
 *
 * Two identical events are indistinguishable, so an ambiguous match claims neither.
 */
function reanchorMovedEvents(plan: ReconciliationPlan, stale: GoogleEvent[]): void {
  if (plan.creates.length === 0 || stale.length === 0) return;

  const unmatched: VaultCalendarEvent[] = [];
  for (const desired of plan.creates) {
    const candidates = stale.filter((candidate) =>
      eventsEqual(candidate, anchorImpliedDate(desired, candidate)),
    );
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (!only) {
      unmatched.push(desired);
      continue;
    }

    plan.updates.push({
      eventId: requireEventId(only),
      event: anchorImpliedDate(desired, only),
    });
    stale.splice(stale.indexOf(only), 1);
  }
  plan.creates = unmatched;
}

/** The keys a declaration may be stored under: its current key, then the older unhashed key. */
function storedKeys(desired: VaultCalendarEvent): string[] {
  if (desired.sourceKey === desired.remoteSourceKey) return [desired.remoteSourceKey];
  return [desired.remoteSourceKey, desired.sourceKey];
}

/**
 * Keeps the copy Google created first: it holds the guest replies and reminders, and every device
 * reads the same times, so no two devices keep a different copy and delete each other's.
 */
function survivor(matching: GoogleEvent[]): GoogleEvent | undefined {
  let kept = matching[0];
  for (const event of matching) {
    if (kept && createdAt(event) < createdAt(kept)) kept = event;
  }
  return kept;
}

function createdAt(event: GoogleEvent): number {
  const created = Date.parse(event.created ?? "");
  return Number.isNaN(created) ? Number.POSITIVE_INFINITY : created;
}

function groupRemoteEvents(events: GoogleEvent[]): Map<string, GoogleEvent[]> {
  const grouped = new Map<string, GoogleEvent[]>();
  for (const event of events) {
    const sourceKey = event.extendedProperties?.private?.obsidianSourceKey;
    if (!sourceKey) continue;
    const matching = grouped.get(sourceKey) ?? [];
    matching.push(event);
    grouped.set(sourceKey, matching);
  }
  return grouped;
}

function remoteSourceKey(event: GoogleEvent): string | undefined {
  return event.extendedProperties?.private?.obsidianSourceKey;
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pins a start resolved from today to the date the event already has on Google. The time of day
 * and duration still come from the note, so editing a bare-time event retimes it on its original
 * day. The same applies to a standalone recurrence, whose all-day start is initially today.
 */
function anchorImpliedDate(desired: VaultCalendarEvent, remote: GoogleEvent): VaultCalendarEvent {
  if (!desired.impliedDate) return desired;
  const desiredDate = WALL_CLOCK.exec(desired.start.dateTime ?? "")?.[1];
  const remoteDate = WALL_CLOCK.exec(remote.start?.dateTime ?? "")?.[1];
  if (desiredDate && remoteDate) {
    return anchorByDay(desired, desiredDate, remoteDate, shiftWallClock);
  }

  const desiredAllDay = desired.start.date;
  const remoteAllDay = remote.start?.date;
  if (desiredAllDay && remoteAllDay) {
    return anchorByDay(desired, desiredAllDay, remoteAllDay, shiftCalendarDate);
  }
  return desired;
}

function anchorByDay(
  desired: VaultCalendarEvent,
  desiredDate: string,
  remoteDate: string,
  shift: (value: CalendarDateTime, days: number) => CalendarDateTime,
): VaultCalendarEvent {
  if (desiredDate === remoteDate) return desired;

  const shiftDays =
    (Date.parse(`${remoteDate}T00:00:00Z`) - Date.parse(`${desiredDate}T00:00:00Z`)) / MS_PER_DAY;
  if (!Number.isInteger(shiftDays)) return desired;

  return {
    ...desired,
    start: shift(desired.start, shiftDays),
    end: shift(desired.end, shiftDays),
  };
}

function shiftWallClock(value: CalendarDateTime, days: number): CalendarDateTime {
  if (!value.dateTime) return value;
  const shifted = new Date(Date.parse(`${value.dateTime}Z`) + days * MS_PER_DAY);
  return { ...value, dateTime: shifted.toISOString().slice(0, 19) };
}

function shiftCalendarDate(value: CalendarDateTime, days: number): CalendarDateTime {
  if (!value.date) return value;
  const shifted = new Date(Date.parse(`${value.date}T00:00:00Z`) + days * MS_PER_DAY);
  return { ...value, date: shifted.toISOString().slice(0, 10) };
}

function eventsEqual(remote: GoogleEvent, desired: VaultCalendarEvent): boolean {
  return (
    remote.summary === desired.summary &&
    dateTimesEqual(remote.start, desired.start) &&
    dateTimesEqual(remote.end, desired.end) &&
    arraysEqual(remote.recurrence, desired.recurrence)
  );
}

function dateTimesEqual(first: CalendarDateTime | undefined, second: CalendarDateTime): boolean {
  if (!first) return false;
  if (first.date || second.date) return first.date === second.date;
  if (!first.dateTime || !second.dateTime) return false;
  return Date.parse(first.dateTime) === Date.parse(second.dateTime);
}

function arraysEqual(first?: string[], second?: string[]): boolean {
  const left = first ?? [];
  const right = second ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireEventId(event: GoogleEvent): string {
  if (!event.id) throw new Error("Google Calendar returned an event without an ID");
  return event.id;
}

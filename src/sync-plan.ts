import type { CalendarDateTime, VaultCalendarEvent } from "./event-parser";

export interface GoogleEvent {
  id?: string;
  summary?: string;
  status?: string;
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
    unchanged: [],
  };

  for (const [sourceKey, desired] of desiredByKey) {
    if (
      affectedSourceKeys &&
      !affectedSourceKeys.has(sourceKey) &&
      !affectedSourceKeys.has(desired.remoteSourceKey)
    ) {
      continue;
    }

    const currentEvents = remoteByKey.get(desired.remoteSourceKey) ?? [];
    const legacyEvents =
      desired.remoteSourceKey === sourceKey ? [] : (remoteByKey.get(sourceKey) ?? []);
    const matching = [...currentEvents, ...legacyEvents];
    const current = matching[0];
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

    for (const duplicate of matching.slice(1)) {
      plan.deletes.push(requireEventId(duplicate));
    }
    remoteByKey.delete(sourceKey);
    remoteByKey.delete(desired.remoteSourceKey);
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
 * Pins a start with no date to the date the event already has on Google. The time of day and the
 * duration still come from the note, so editing the time retimes the event on its original day.
 */
function anchorImpliedDate(desired: VaultCalendarEvent, remote: GoogleEvent): VaultCalendarEvent {
  if (!desired.impliedDate) return desired;
  const desiredDate = WALL_CLOCK.exec(desired.start.dateTime ?? "")?.[1];
  const remoteDate = WALL_CLOCK.exec(remote.start?.dateTime ?? "")?.[1];
  if (!desiredDate || !remoteDate || desiredDate === remoteDate) return desired;

  const shiftDays =
    (Date.parse(`${remoteDate}T00:00:00Z`) - Date.parse(`${desiredDate}T00:00:00Z`)) / MS_PER_DAY;
  if (!Number.isInteger(shiftDays)) return desired;

  return {
    ...desired,
    start: shiftWallClock(desired.start, shiftDays),
    end: shiftWallClock(desired.end, shiftDays),
  };
}

function shiftWallClock(value: CalendarDateTime, days: number): CalendarDateTime {
  if (!value.dateTime) return value;
  const shifted = new Date(Date.parse(`${value.dateTime}Z`) + days * MS_PER_DAY);
  return { ...value, dateTime: shifted.toISOString().slice(0, 19) };
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

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
  unchanged: number;
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
    unchanged: 0,
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
        plan.unchanged += 1;
      }
    }

    for (const duplicate of matching.slice(1)) {
      plan.deletes.push(requireEventId(duplicate));
    }
    remoteByKey.delete(sourceKey);
    remoteByKey.delete(desired.remoteSourceKey);
  }

  for (const [remoteKey, staleEvents] of remoteByKey) {
    if (affectedSourceKeys && !affectedSourceKeys.has(remoteKey)) continue;
    for (const stale of staleEvents) plan.deletes.push(requireEventId(stale));
  }
  return plan;
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
 * A note that gave a time but no date is anchored to the date the event already has on Google, so
 * it stays where it was first created instead of moving forward every day. The time of day and the
 * duration still come from the note, so editing the time retimes the event in place.
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

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
    } else if (
      remoteSourceKey(current) !== desired.remoteSourceKey ||
      !eventsEqual(current, desired)
    ) {
      plan.updates.push({ eventId: requireEventId(current), event: desired });
    } else {
      plan.unchanged += 1;
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

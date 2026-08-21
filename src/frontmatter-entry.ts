import type { DirectiveSource } from "./directive-draft";
import { toEntryArray } from "./event-parser";

/** One `gcal` entry as written. */
export interface EntrySource extends DirectiveSource {
  /**
   * The repeat came from the note-level `gcal-repeat`, which every entry shares. The picker shows
   * it but does not change it, so this entry does not get a copy of its own.
   */
  sharedRepeat?: true;
}

export function readEntrySource(
  frontmatter: Record<string, unknown> | undefined,
  index: number,
): EntrySource | undefined {
  const entries = toEntryArray(frontmatter?.gcal);
  const entry = entries[index];
  if (entry === undefined) return undefined;

  const shared = text(frontmatter?.["gcal-repeat"]);
  const inherited = shared === undefined ? {} : { repeat: shared, sharedRepeat: true as const };

  if (typeof entry === "string") {
    const when = entry.trim();
    return { ...(when ? { when } : {}), ...inherited };
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;

  const record = entry as Record<string, unknown>;
  const when = text(record.when);
  const repeat = text(record.repeat);
  return {
    ...(when === undefined ? {} : { when }),
    ...(repeat === undefined ? { ...inherited } : { repeat }),
  };
}

/**
 * Changes the `gcal` property in place. False when the entry is gone, so an edit cannot hit the
 * wrong one.
 */
export function writeEntrySource(
  frontmatter: Record<string, unknown>,
  index: number,
  next: DirectiveSource,
): boolean {
  const value = frontmatter.gcal;
  if (Array.isArray(value)) {
    if (index < 0 || index >= value.length) return false;
    value[index] = mergeEntry(value[index], next);
    return true;
  }
  if (index !== 0 || toEntryArray(value).length === 0) return false;
  frontmatter.gcal = mergeEntry(value, next);
  return true;
}

/** A plain value stays plain. It becomes a map only when there is a repeat to store. */
function mergeEntry(entry: unknown, next: DirectiveSource): unknown {
  const when = next.when ?? "";
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const record: Record<string, unknown> = { ...(entry as Record<string, unknown>), when };
    if (next.repeat === undefined) delete record.repeat;
    else record.repeat = next.repeat;
    return record;
  }
  return next.repeat === undefined ? when : { when, repeat: next.repeat };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

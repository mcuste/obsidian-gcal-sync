/** Where a start is written in the note properties, as offsets into the note text. */
export interface FrontmatterStart {
  /** Zero-based line in the note. */
  line: number;
  /** Offsets of the value inside that line, quotes included. */
  from: number;
  to: number;
  /** The value as the parser sees it, without surrounding quotes. */
  text: string;
  /** Matches `VaultCalendarEvent.entryIndex`. */
  entryIndex: number;
}

const OPENING_FENCE = /^---\s*$/;
const CLOSING_FENCE = /^(?:---|\.\.\.)\s*$/;
const TOP_LEVEL_KEY = /^([^\s:#][^:]*):(.*)$/;
const LIST_ITEM = /^(\s*-\s+)(.*)$/;
const WHEN_FIELD = /^(\s*when:\s*)(\S.*)$/;
const FIELD = /^[A-Za-z_][\w-]*:/;

/**
 * Obsidian gives the plugin the parsed properties with no positions, so the editor finds them here.
 * The nth start found is the nth `gcal` entry the parser reads. Only the plain `gcal:` and `when:`
 * forms are read, and callers check each value against its event, so odd YAML shows as written
 * rather than as the wrong event.
 */
export function findFrontmatterStarts(content: string): FrontmatterStart[] {
  const lines = content.split("\n");
  if (!lines[0] || !OPENING_FENCE.test(lines[0])) return [];

  const found: FrontmatterStart[] = [];
  let insideGcal = false;
  let entryIndex = -1;

  for (let line = 1; line < lines.length; line += 1) {
    const text = lines[line] ?? "";
    if (CLOSING_FENCE.test(text)) break;

    const key = TOP_LEVEL_KEY.exec(text);
    if (key) {
      insideGcal = key[1]?.trim() === "gcal";
      entryIndex = -1;
      if (!insideGcal) continue;

      // `gcal: <value>` is the one-event form. An empty value means the entries follow, indented.
      const value = key[2] ?? "";
      const start = text.length - value.length;
      if (record(found, line, start, value, 0)) entryIndex = 0;
      continue;
    }
    if (!insideGcal || text.trim() === "") continue;

    const item = LIST_ITEM.exec(text);
    if (item) {
      entryIndex += 1;
      const rest = item[2] ?? "";
      const when = WHEN_FIELD.exec(rest);
      if (when) {
        record(
          found,
          line,
          (item[1] ?? "").length + (when[1] ?? "").length,
          when[2] ?? "",
          entryIndex,
        );
      } else if (!FIELD.test(rest)) {
        record(found, line, (item[1] ?? "").length, rest, entryIndex);
      }
      continue;
    }

    const when = WHEN_FIELD.exec(text);
    if (!when) continue;
    // A `when` with no list item before it is the lone-map form, which is one entry.
    if (entryIndex < 0) entryIndex = 0;
    record(found, line, (when[1] ?? "").length, when[2] ?? "", entryIndex);
  }

  return found;
}

function record(
  found: FrontmatterStart[],
  line: number,
  start: number,
  value: string,
  entryIndex: number,
): boolean {
  const trimmed = value.trimEnd();
  const from = start + (trimmed.length - trimmed.trimStart().length);
  const written = trimmed.trimStart();
  if (written === "" || written.startsWith("#")) return false;

  found.push({ line, from, to: from + written.length, text: unquote(written), entryIndex });
  return true;
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

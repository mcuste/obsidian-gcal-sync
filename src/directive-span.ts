import type { DirectiveSource } from "./directive-draft";
import { findLineDirectives } from "./event-parser";

const TOKEN = /(\s*)(gcal(?:-[a-z]+)?):([^\s]+)/giy;
const EVENT_NAME = "gcal";
const REPEAT_NAME = "gcal-repeat";

interface SpanToken {
  name: string;
  value: string;
}

/**
 * The event and repeat a code span declares. Undefined for a span with two events, two repeats, or
 * a directive this version does not know, because a rewrite would have to guess.
 */
export function readSpanDirectives(inner: string): DirectiveSource | undefined {
  const tokens = tokenize(inner);
  if (!tokens) return undefined;

  const events = tokens.filter((token) => token.name === EVENT_NAME);
  const repeats = tokens.filter((token) => token.name === REPEAT_NAME);
  if (events.length + repeats.length !== tokens.length) return undefined;
  if (events.length > 1 || repeats.length > 1) return undefined;

  const when = events[0]?.value;
  const repeat = repeats[0]?.value;
  if (when === undefined && repeat === undefined) return undefined;
  return { ...(when === undefined ? {} : { when }), ...(repeat === undefined ? {} : { repeat }) };
}

/**
 * Undefined for a span `readSpanDirectives` does not accept. Spaces around the span are kept; the
 * directives inside get one space between them, which is all a span can hold anyway.
 */
export function rewriteSpan(inner: string, next: DirectiveSource): string | undefined {
  if (!readSpanDirectives(inner)) return undefined;

  const pieces = [
    ...(next.when === undefined ? [] : [`${EVENT_NAME}:${next.when}`]),
    ...(next.repeat === undefined ? [] : [`${REPEAT_NAME}:${next.repeat}`]),
  ];
  // An empty span would drop the declaration silently, so refuse rather than write one.
  if (pieces.length === 0) return undefined;

  const leading = /^\s*/.exec(inner)?.[0] ?? "";
  const trailing = /\s*$/.exec(inner)?.[0] ?? "";
  return `${leading}${pieces.join(" ")}${trailing}`;
}

/**
 * The whole note with one declaration rewritten. Undefined when that declaration is no longer at
 * that line, so an edit cannot hit the wrong one.
 */
export function rewriteDocument(
  text: string,
  lineIndex: number,
  occurrence: number,
  next: DirectiveSource,
): string | undefined {
  const range = lineRange(text, lineIndex);
  if (!range) return undefined;

  const line = text.slice(range.from, range.to);
  const found = findLineDirectives(line).find((span) => span.occurrence === occurrence);
  if (!found) return undefined;

  const inner = rewriteSpan(line.slice(found.innerFrom, found.innerTo), next);
  if (inner === undefined) return undefined;
  return (
    text.slice(0, range.from + found.innerFrom) + inner + text.slice(range.from + found.innerTo)
  );
}

/** Splits a span into its directives, or undefined when anything else sits between them. */
function tokenize(inner: string): SpanToken[] | undefined {
  const tokens: SpanToken[] = [];
  // Sticky, so each match must start where the last one ended. The end is tracked here, because a
  // failed sticky match resets lastIndex to zero.
  const pattern = new RegExp(TOKEN);
  let cursor = 0;

  for (let match = pattern.exec(inner); match; match = pattern.exec(inner)) {
    tokens.push({ name: (match[2] ?? "").toLowerCase(), value: match[3] ?? "" });
    cursor = pattern.lastIndex;
  }
  if (tokens.length === 0) return undefined;
  if (inner.slice(cursor).trim() !== "") return undefined;
  return tokens;
}

/** Where a zero-based line sits in the note, excluding its line break. */
function lineRange(text: string, lineIndex: number): { from: number; to: number } | undefined {
  let from = 0;
  for (let line = 0; line < lineIndex; line += 1) {
    const nextBreak = text.indexOf("\n", from);
    if (nextBreak === -1) return undefined;
    from = nextBreak + 1;
  }

  const nextBreak = text.indexOf("\n", from);
  const to = nextBreak === -1 ? text.length : nextBreak;
  return { from, to: to > from && text[to - 1] === "\r" ? to - 1 : to };
}

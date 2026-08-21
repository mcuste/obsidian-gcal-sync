import type { EditorSelection, Extension, Range, Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorInfoField, type MarkdownPostProcessor, Notice } from "obsidian";
import { buildChip, buildStatusMarker, chipKey } from "./directive-chip";
import {
  type DirectiveSource,
  readDraft,
  toDirectiveSource,
  type WrittenDirective,
} from "./directive-draft";
import { closeDirectivePicker, openDirectivePicker } from "./directive-picker";
import { readSpanDirectives, rewriteSpan } from "./directive-span";
import { type DisplayOptions, describeEvent, type EventDisplay } from "./event-display";
import {
  findLineDirectives,
  isDirectiveSpanText,
  parseSchedule,
  type VaultCalendarEvent,
} from "./event-parser";
import type { EntrySource } from "./frontmatter-entry";
import { findFrontmatterStarts } from "./frontmatter-scan";
import type { DirectiveStatus } from "./main";

/** No properties block runs this deep, so the search for its end stops here. */
const MAX_FRONTMATTER_LINES = 300;
const OPENING_FENCE = /^---\s*$/;
const CLOSING_FENCE = /^(?:---|\.\.\.)\s*$/;
const MOVED_NOTICE = "That declaration moved, so nothing was changed";

export interface DirectiveView {
  status: DirectiveStatus;
  /** Absent when the declaration could not be read, so there is nothing to draw. */
  event?: VaultCalendarEvent;
}

export interface DirectiveStatusSource {
  /** The declaration at this position, or undefined if there is not one. */
  directiveAt(path: string, line: number, occurrence: number): DirectiveView | undefined;
  /** The note-properties entry at this index, matching `VaultCalendarEvent.entryIndex`. */
  frontmatterAt(path: string, entryIndex: number): DirectiveView | undefined;
  displayOptions(): DisplayOptions;
  /** False leaves every declaration as written, with only a status marker beside it. */
  chipsEnabled(): boolean;
  /** False leaves every declaration read-only, with no picker on its icon. */
  pickerEnabled(): boolean;
  /** True when Obsidian leaves the note properties in the editor text, not in its widget. */
  propertiesInEditor(): boolean;
  /** Registers a callback for when any declaration changes, and returns its remover. */
  onStatusChange(listener: () => void): () => void;
  /** A note-properties entry as written, for the picker to start from. */
  entrySource(path: string, entryIndex: number): EntrySource | undefined;
  /** Writes a picked declaration back to the note. Reports its own failures. */
  applyToLine(
    path: string,
    line: number,
    occurrence: number,
    written: WrittenDirective,
  ): Promise<void>;
  applyToEntry(path: string, entryIndex: number, written: WrittenDirective): Promise<void>;
}

/** Opens the picker for one declaration, anchored to the icon that was clicked. */
type PickOpener = (anchor: HTMLElement) => void;

class ChipWidget extends WidgetType {
  constructor(
    private readonly status: DirectiveStatus,
    private readonly display: EventDisplay,
    private readonly pick: PickOpener | undefined,
  ) {
    super();
  }

  private key(): string {
    return chipKey(this.status, this.display, this.pick !== undefined);
  }

  override eq(other: ChipWidget): boolean {
    return other.key() === this.key();
  }

  override toDOM(view: EditorView): HTMLElement {
    const chip = buildChip(this.status, this.display, this.pick ? { onPick: this.pick } : {});
    // Moving the cursor here is what brings the text back; the click alone would not move it.
    chip.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(chip) } });
      view.focus();
    });
    return chip;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class StatusWidget extends WidgetType {
  constructor(
    private readonly status: DirectiveStatus,
    private readonly pick: PickOpener | undefined,
  ) {
    super();
  }

  override eq(other: StatusWidget): boolean {
    return other.status === this.status && (other.pick === undefined) === (this.pick === undefined);
  }

  override toDOM(): HTMLElement {
    return buildStatusMarker(this.status, this.pick);
  }
}

/**
 * Draws declarations while editing. One the cursor or selection touches is left as written, so
 * typing inside it behaves normally; every other one becomes a chip.
 */
export function directiveStatusExtension(source: DirectiveStatusSource): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;
      private readonly stopListening: () => void;

      constructor(private readonly view: EditorView) {
        this.decorations = decorate(view, source);
        // Recomputing needs an update cycle, so a status change dispatches an empty transaction.
        this.stopListening = source.onStatusChange(() => this.view.dispatch({}));
      }

      update(update: ViewUpdate): void {
        this.decorations = decorate(update.view, source);
      }

      destroy(): void {
        this.stopListening();
      }
    },
    { decorations: (value) => value.decorations },
  );
}

function decorate(view: EditorView, source: DirectiveStatusSource): DecorationSet {
  const path = view.state.field(editorInfoField, false)?.file?.path;
  if (!path) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  const context: RenderContext = {
    chips: source.chipsEnabled(),
    picker: source.pickerEnabled(),
    options: source.displayOptions(),
    selection: view.state.selection,
  };

  for (const { from, to } of view.visibleRanges) {
    let position = from;
    while (position <= to) {
      const line = view.state.doc.lineAt(position);
      for (const found of findLineDirectives(line.text)) {
        const declaration = source.directiveAt(path, line.number - 1, found.occurrence);
        if (!declaration) continue;
        const inner = line.text.slice(found.innerFrom, found.innerTo);
        addDeclaration(ranges, context, declaration, {
          from: line.from + found.from,
          to: line.from + found.to,
          innerFrom: line.from + found.innerFrom,
          innerTo: line.from + found.innerTo,
          pick: linePicker(view, context, found.occurrence, inner, declaration),
        });
      }
      position = line.to + 1;
    }
  }

  if (context.chips && source.propertiesInEditor()) {
    addFrontmatter(ranges, context, view.state.doc, path, source);
  }
  // Sorted here, since the properties come before the lines walked above.
  return Decoration.set(ranges, true);
}

interface RenderContext {
  chips: boolean;
  picker: boolean;
  options: DisplayOptions;
  selection: EditorSelection;
}

/** Where a declaration sits, with and without whatever delimits it, and how to pick it. */
interface DeclarationRange {
  from: number;
  to: number;
  innerFrom: number;
  innerTo: number;
  pick?: PickOpener;
}

function addDeclaration(
  ranges: Range<Decoration>[],
  context: RenderContext,
  declaration: DirectiveView,
  at: DeclarationRange,
): void {
  const display = chipFor(context, declaration, at);
  if (display) {
    ranges.push(
      Decoration.replace({ widget: new ChipWidget(declaration.status, display, at.pick) }).range(
        at.innerFrom,
        at.innerTo,
      ),
    );
    return;
  }
  ranges.push(
    Decoration.mark({ class: `gcal-directive gcal-directive-${declaration.status}` }).range(
      at.from,
      at.to,
    ),
  );
  ranges.push(
    Decoration.widget({ widget: new StatusWidget(declaration.status, at.pick), side: 1 }).range(
      at.to,
    ),
  );
}

/**
 * The chip to draw, or undefined to leave the text as written. Delimiters count as touched too, so
 * reaching either edge brings the text back.
 */
function chipFor(
  context: RenderContext,
  declaration: DirectiveView,
  at: DeclarationRange,
): EventDisplay | undefined {
  if (!context.chips || !declaration.event) return undefined;
  if (at.innerFrom >= at.innerTo) return undefined;
  if (touches(context.selection, at.from, at.to)) return undefined;
  return describeEvent(declaration.event, context.options);
}

function touches(selection: EditorSelection, from: number, to: number): boolean {
  return selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** Undefined for a span `readSpanDirectives` does not accept, which leaves it as written. */
function linePicker(
  view: EditorView,
  context: RenderContext,
  occurrence: number,
  inner: string,
  declaration: DirectiveView,
): PickOpener | undefined {
  if (!context.picker || !readSpanDirectives(inner)) return undefined;
  const elsewhere = repeatWrittenElsewhere(inner, declaration, context.options);

  return (anchor) => {
    const found = locateSpan(view, anchor, occurrence);
    if (!found) return;
    openLinePicker(anchor, found.inner, context.options, elsewhere, (written) =>
      applyInEditor(view, anchor, occurrence, written),
    );
  };
}

function openLinePicker(
  anchor: HTMLElement,
  inner: string,
  options: DisplayOptions,
  elsewhere: string | undefined,
  apply: (written: WrittenDirective) => void,
): void {
  const written = readSpanDirectives(inner);
  if (!written) return;
  openDirectivePicker({
    anchor,
    draft: readDraft(written, options),
    options,
    ...(elsewhere ? { lockedRepeat: `${elsewhere}, written elsewhere on this line` } : {}),
    apply,
  });
}

function repeatWrittenElsewhere(
  inner: string,
  declaration: DirectiveView,
  options: DisplayOptions,
): string | undefined {
  if (readSpanDirectives(inner)?.repeat !== undefined) return undefined;
  if (!declaration.event?.recurrence) return undefined;
  return describeEvent(declaration.event, options).repeat;
}

interface SpanLocation {
  from: number;
  to: number;
  inner: string;
}

/** Where the declaration sits now. Read again on apply, in case the note changed since. */
function locateSpan(
  view: EditorView,
  anchor: HTMLElement,
  occurrence: number,
): SpanLocation | undefined {
  const line = view.state.doc.lineAt(view.posAtDOM(anchor));
  const found = findLineDirectives(line.text).find((span) => span.occurrence === occurrence);
  if (!found) return undefined;
  return {
    from: line.from + found.innerFrom,
    to: line.from + found.innerTo,
    inner: line.text.slice(found.innerFrom, found.innerTo),
  };
}

/** Edits through the editor, not the file, so one undo takes the change back. */
function applyInEditor(
  view: EditorView,
  anchor: HTMLElement,
  occurrence: number,
  written: WrittenDirective,
): void {
  const found = locateSpan(view, anchor, occurrence);
  const inner = found ? rewriteSpan(found.inner, toDirectiveSource(written)) : undefined;
  if (!found || inner === undefined) {
    new Notice(MOVED_NOTICE);
    return;
  }
  if (inner === found.inner) return;
  view.dispatch({ changes: { from: found.from, to: found.to, insert: inner } });
}

/** Builds the panel for a `gcal` entry in the note properties. */
export function openEntryPicker(
  anchor: HTMLElement,
  path: string,
  entryIndex: number,
  source: DirectiveStatusSource,
): void {
  const entry = source.entrySource(path, entryIndex);
  if (!entry) return;

  const own: DirectiveSource = { ...entry };
  if (entry.sharedRepeat) delete own.repeat;
  const options = source.displayOptions();

  openDirectivePicker({
    anchor,
    draft: readDraft(own, options),
    options,
    ...(entry.sharedRepeat && entry.repeat
      ? { lockedRepeat: `${entry.repeat}, written for the whole note` }
      : {}),
    apply: (written) => {
      void source.applyToEntry(path, entryIndex, written);
    },
  });
}

/**
 * Draws the starts written in the note properties text. Only the start is replaced, so a title or
 * repeat on its own line stays editable, and an entry with no event keeps showing what you wrote.
 */
function addFrontmatter(
  ranges: Range<Decoration>[],
  context: RenderContext,
  doc: Text,
  path: string,
  source: DirectiveStatusSource,
): void {
  const properties = frontmatterText(doc);
  if (!properties) return;

  for (const start of findFrontmatterStarts(properties)) {
    const line = doc.line(start.line + 1);
    const from = line.from + start.from;
    const to = line.from + start.to;
    const declaration = source.frontmatterAt(path, start.entryIndex);
    if (!declaration?.event) continue;
    if (!writesTheSameEvent(declaration.event, start.text, context.options)) continue;
    // A property value has no delimiters to leave behind, so the whole of it is the chip.
    addDeclaration(ranges, context, declaration, {
      from,
      to,
      innerFrom: from,
      innerTo: to,
      ...(context.picker
        ? {
            pick: (anchor: HTMLElement) => openEntryPicker(anchor, path, start.entryIndex, source),
          }
        : {}),
    });
  }
}

function frontmatterText(doc: Text): string {
  if (doc.lines < 2 || !OPENING_FENCE.test(doc.line(1).text)) return "";
  const last = Math.min(doc.lines, MAX_FRONTMATTER_LINES);
  for (let line = 2; line <= last; line += 1) {
    if (CLOSING_FENCE.test(doc.line(line).text)) return doc.sliceString(0, doc.line(line).to);
  }
  return "";
}

/**
 * Whether this value really is the one that produced this event. The properties scan is shallow, so
 * this is what stops odd YAML being drawn as a neighbouring entry's event.
 */
function writesTheSameEvent(
  event: VaultCalendarEvent,
  text: string,
  options: DisplayOptions,
): boolean {
  try {
    const schedule = parseSchedule(text, options.timeZone, options.now);
    return (
      schedule.start.date === event.start.date &&
      schedule.start.dateTime === event.start.dateTime &&
      schedule.end.date === event.end.date &&
      schedule.end.dateTime === event.end.dateTime
    );
  } catch {
    return false;
  }
}

/**
 * Draws declarations in Reading view. With no cursor to bring the text back, the chip and the text
 * sit side by side and clicking swaps which one is shown.
 */
export function directiveStatusPostProcessor(source: DirectiveStatusSource): MarkdownPostProcessor {
  return (element, context) => {
    const spans = Array.from(element.querySelectorAll("code")).filter((code) =>
      isDirectiveSpanText(code.textContent ?? ""),
    );
    if (spans.length === 0) return;

    const section = context.getSectionInfo(element);
    if (!section) return;

    const lines = section.text.split("\n");
    const placements: Array<{ line: number; occurrence: number }> = [];
    for (let offset = section.lineStart; offset <= section.lineEnd; offset += 1) {
      for (const found of findLineDirectives(lines[offset] ?? "")) {
        placements.push({ line: offset, occurrence: found.occurrence });
      }
    }
    // Rendered code spans and source declarations share their document order, so the counts only
    // disagree if the section was re-rendered from stale text. Skip rather than mislabel.
    if (placements.length !== spans.length) return;

    const chips = source.chipsEnabled();
    const picker = source.pickerEnabled();
    const options = source.displayOptions();

    spans.forEach((span, index) => {
      const placement = placements[index];
      if (!placement) return;
      const declaration = source.directiveAt(
        context.sourcePath,
        placement.line,
        placement.occurrence,
      );
      if (!declaration) return;

      const inner = span.textContent ?? "";
      const pick: PickOpener | undefined =
        picker && readSpanDirectives(inner)
          ? (anchor) =>
              openLinePicker(
                anchor,
                inner,
                options,
                repeatWrittenElsewhere(inner, declaration, options),
                (written) => {
                  void source.applyToLine(
                    context.sourcePath,
                    placement.line,
                    placement.occurrence,
                    written,
                  );
                },
              )
          : undefined;

      const display =
        chips && declaration.event ? describeEvent(declaration.event, options) : undefined;
      if (!display) {
        span.addClass("gcal-directive", `gcal-directive-${declaration.status}`);
        span.insertAdjacentElement("afterend", buildStatusMarker(declaration.status, pick));
        return;
      }
      renderReadingChip(span, declaration.status, display, pick);
    });
  };
}

function renderReadingChip(
  span: HTMLElement,
  status: DirectiveStatus,
  display: EventDisplay,
  pick: PickOpener | undefined,
): void {
  const holder = createSpan({ cls: "gcal-declaration" });
  span.replaceWith(holder);

  const chip = buildChip(status, display, { focusable: true, ...(pick ? { onPick: pick } : {}) });
  span.addClass("gcal-declaration-source");
  holder.append(chip, span);

  const toggle = (): void => {
    closeDirectivePicker();
    holder.toggleClass("is-open", !holder.hasClass("is-open"));
  };
  chip.addEventListener("click", toggle);
  chip.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });
  span.addEventListener("click", toggle);
}

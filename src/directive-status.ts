import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorInfoField, type MarkdownPostProcessor, setIcon } from "obsidian";
import { findLineDirectives, isDirectiveSpanText } from "./event-parser";
import type { DirectiveStatus } from "./main";

const ICONS: Record<DirectiveStatus, string> = {
  synced: "calendar-check",
  pending: "calendar-clock",
  blocked: "calendar-minus",
  error: "calendar-x",
};
const LABELS: Record<DirectiveStatus, string> = {
  synced: "On your Google Calendar",
  pending: "Not synced yet",
  blocked: "Held back until the other declaration in this note is fixed",
  error: "Google Calendar Sync could not read this declaration",
};

export interface DirectiveStatusSource {
  /** The marker for the declaration at this position, or undefined if it is not one. */
  directiveStatus(path: string, line: number, occurrence: number): DirectiveStatus | undefined;
  /** Registers a callback for when any marker changes, and returns its remover. */
  onStatusChange(listener: () => void): () => void;
}

function buildMarker(status: DirectiveStatus): HTMLElement {
  const marker = createSpan({
    cls: ["gcal-directive-status", `gcal-directive-status-${status}`],
    attr: { "aria-label": LABELS[status] },
  });
  setIcon(marker, ICONS[status]);
  return marker;
}

class StatusWidget extends WidgetType {
  constructor(private readonly status: DirectiveStatus) {
    super();
  }

  override eq(other: StatusWidget): boolean {
    return other.status === this.status;
  }

  override toDOM(): HTMLElement {
    return buildMarker(this.status);
  }
}

/**
 * Marks declarations while editing. The text is left alone rather than replaced by a pill, so the
 * cursor and selection still behave normally inside a declaration you are typing.
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
  const builder = new RangeSetBuilder<Decoration>();
  if (!path) return builder.finish();

  for (const { from, to } of view.visibleRanges) {
    let position = from;
    while (position <= to) {
      const line = view.state.doc.lineAt(position);
      for (const found of findLineDirectives(line.text)) {
        const status = source.directiveStatus(path, line.number - 1, found.occurrence);
        if (!status) continue;
        builder.add(
          line.from + found.from,
          line.from + found.to,
          Decoration.mark({ class: `gcal-directive gcal-directive-${status}` }),
        );
        builder.add(
          line.from + found.to,
          line.from + found.to,
          Decoration.widget({ widget: new StatusWidget(status), side: 1 }),
        );
      }
      position = line.to + 1;
    }
  }
  return builder.finish();
}

/** Marks declarations in Reading view, where there is no cursor to work around. */
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

    spans.forEach((span, index) => {
      const placement = placements[index];
      if (!placement) return;
      const status = source.directiveStatus(
        context.sourcePath,
        placement.line,
        placement.occurrence,
      );
      if (!status) return;
      span.addClass("gcal-directive", `gcal-directive-${status}`);
      span.insertAdjacentElement("afterend", buildMarker(status));
    });
  };
}

import type { Component, Plugin } from "obsidian";
import { buildChip, chipKey } from "./directive-chip";
import { type DirectiveStatusSource, openEntryPicker } from "./directive-status";
import { describeEvent, type EventDisplay } from "./event-display";
import type { DirectiveStatus } from "./main";

const ROW = '.metadata-property[data-property-key="gcal"]';
const VALUE = ".metadata-property-value";
const TEXT_FIELD = ".metadata-input-longtext";
const UNKNOWN_FIELD = ".metadata-property-value-item.mod-unknown";
const CHIPS = "gcal-property-chips";
const SOURCE = "gcal-property-source";
const OPEN = "gcal-property-open";

/** Defers a redraw, through the plugin's own timers so tests can step it. */
export type RedrawScheduler = (redraw: () => void) => void;

/**
 * Chips over the `gcal` property in Obsidian's properties widget. The widget has no plugin API, so
 * this reads its markup, and only the two shapes that show the value as text: one value, and a list
 * of maps, which Obsidian can only print as JSON. A date or pill field is left to Obsidian.
 */
export class FrontmatterPropertyChips {
  private readonly observed = new WeakSet<Element>();
  private queued = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly source: DirectiveStatusSource,
    private readonly defer: RedrawScheduler,
  ) {}

  load(): void {
    const { workspace, metadataCache } = this.plugin.app;
    this.plugin.registerEvent(workspace.on("layout-change", () => this.schedule()));
    this.plugin.registerEvent(workspace.on("active-leaf-change", () => this.schedule()));
    this.plugin.registerEvent(metadataCache.on("changed", () => this.schedule()));
    this.plugin.register(this.source.onStatusChange(() => this.schedule()));
    this.schedule();
  }

  /** Several signals fire for one change, so they collapse into one redraw. */
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    this.defer(() => {
      this.queued = false;
      this.refresh();
    });
  }

  private refresh(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as Component & { containerEl?: HTMLElement; file?: { path: string } };
      const path = view.file?.path;
      if (!path || !view.containerEl) continue;

      for (const row of Array.from(view.containerEl.querySelectorAll<HTMLElement>(ROW))) {
        this.watch(row.parentElement);
        this.draw(row, path);
      }
    }
  }

  /** Obsidian rebuilds the rows on its own, which this notices without polling. */
  private watch(properties: HTMLElement | null): void {
    if (!properties || this.observed.has(properties)) return;
    this.observed.add(properties);
    const observer = new MutationObserver(() => this.schedule());
    observer.observe(properties, { childList: true, subtree: true });
    this.plugin.register(() => observer.disconnect());
  }

  private draw(row: HTMLElement, path: string): void {
    const value = row.querySelector<HTMLElement>(VALUE);
    const written = value?.querySelector<HTMLElement>(`${TEXT_FIELD}, ${UNKNOWN_FIELD}`);
    if (!value || !written) return;

    const chips = this.source.chipsEnabled() ? this.readEntries(path, written) : undefined;
    const holder = value.querySelector<HTMLElement>(`.${CHIPS}`);
    if (!chips) {
      holder?.remove();
      written.removeClass(SOURCE);
      value.removeClass(OPEN);
      return;
    }

    const pickable = this.source.pickerEnabled();
    const key = chips.map(([status, display]) => chipKey(status, display, pickable)).join(" | ");
    if (holder?.dataset.gcalChips === key) return;
    holder?.remove();
    this.attach(value, written, chips, key, path);
  }

  /** Undefined unless every entry has an event, since a partial answer would hide the rest. */
  private readEntries(
    path: string,
    written: HTMLElement,
  ): Array<[DirectiveStatus, EventDisplay]> | undefined {
    const count = entryCount(written);
    if (count === undefined) return undefined;

    const options = this.source.displayOptions();
    const chips: Array<[DirectiveStatus, EventDisplay]> = [];
    for (let index = 0; index < count; index += 1) {
      const declaration = this.source.frontmatterAt(path, index);
      if (!declaration?.event) return undefined;
      chips.push([declaration.status, describeEvent(declaration.event, options)]);
    }
    return chips.length > 0 ? chips : undefined;
  }

  private attach(
    value: HTMLElement,
    written: HTMLElement,
    chips: Array<[DirectiveStatus, EventDisplay]>,
    key: string,
    path: string,
  ): void {
    const holder = createSpan({ cls: CHIPS });
    holder.dataset.gcalChips = key;
    const pickable = this.source.pickerEnabled();
    chips.forEach(([status, display], index) => {
      holder.append(
        buildChip(status, display, {
          focusable: true,
          ...(pickable
            ? { onPick: (anchor) => openEntryPicker(anchor, path, index, this.source) }
            : {}),
        }),
      );
    });

    written.addClass(SOURCE);
    written.insertAdjacentElement("beforebegin", holder);

    const open = (): void => {
      value.addClass(OPEN);
      // Only the text field is editable; the JSON of a list of maps is not.
      if (written.isContentEditable) written.focus();
    };
    holder.addEventListener("click", open);
    holder.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    written.addEventListener("blur", () => value.removeClass(OPEN));
    written.addEventListener("click", () => {
      if (!written.isContentEditable) value.removeClass(OPEN);
    });
  }
}

/** How many entries the widget shows, or undefined when its markup is not one this reads. */
function entryCount(written: HTMLElement): number | undefined {
  if (written.hasClass("metadata-input-longtext")) {
    return written.textContent?.trim() ? 1 : undefined;
  }

  try {
    const parsed: unknown = JSON.parse(written.textContent ?? "");
    if (Array.isArray(parsed)) return parsed.length;
    return parsed !== null && typeof parsed === "object" ? 1 : undefined;
  } catch {
    return undefined;
  }
}

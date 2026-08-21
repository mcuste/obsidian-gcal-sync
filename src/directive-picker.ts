import {
  type DirectiveDraft,
  orderWeekdays,
  previewDirective,
  type RepeatDraft,
  type RepeatPeriod,
  type RepeatUnit,
  WEEKDAY_CODES,
  type WrittenDirective,
  writeDraft,
} from "./directive-draft";
import { type DisplayOptions, describeDirective, weekdayName } from "./event-display";

export interface PickerRequest {
  /** The icon that was clicked. The panel sits under it and closes if it is removed. */
  anchor: HTMLElement;
  draft: DirectiveDraft;
  options: DisplayOptions;
  /**
   * The repeat in words, when it is written outside this declaration. The panel shows it but does
   * not change it, so this declaration does not get a copy of a shared rule.
   */
  lockedRepeat?: string;
  apply(written: WrittenDirective): void;
}

const PERIODS: RepeatPeriod[] = [
  "daily",
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "yearly",
];
const PERIOD_LABELS: Record<RepeatPeriod, string> = {
  daily: "Every day",
  weekly: "Every week",
  fortnightly: "Every 2 weeks",
  monthly: "Every month",
  quarterly: "Every 3 months",
  yearly: "Every year",
};
const UNITS: RepeatUnit[] = ["day", "week", "month", "year"];
const UNIT_LABELS: Record<RepeatUnit, string> = {
  day: "days",
  week: "weeks",
  month: "months",
  year: "years",
};
const WORKING_WEEK = ["MO", "TU", "WE", "TH", "FR"];
const HIDDEN = "gcal-picker-hidden";
const PANEL_GAP = 4;
const MAX_HOURS = 8760;

interface OpenPicker {
  panel: HTMLElement;
  close(): void;
}

let current: OpenPicker | undefined;

/** Applying, clicking away, Escape, and unloading the plugin all end here. */
export function closeDirectivePicker(): void {
  current?.close();
}

/**
 * One panel at a time, anchored to the icon that opened it, and nothing is written until Apply.
 */
export function openDirectivePicker(request: PickerRequest): void {
  closeDirectivePicker();

  const draft: DirectiveDraft = { ...request.draft };
  const panel = document.body.createDiv({
    cls: "gcal-picker",
    attr: { role: "dialog", "aria-label": "Event date, time, and repeat" },
  });

  const controls = buildControls(panel, request, draft, () => redraw());
  function redraw(): void {
    controls.render(draft);
    place(panel, request.anchor);
  }

  const close = (): void => {
    if (current?.panel !== panel) return;
    current = undefined;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onReflow, true);
    window.removeEventListener("resize", onReflow);
    panel.remove();
  };

  // Closed before the note changes, since applying rebuilds the chip the panel is anchored to.
  const apply = (): void => {
    close();
    request.apply(writeDraft(draft));
  };

  function onPointerDown(event: PointerEvent): void {
    if (!panel.contains(event.target as Node)) close();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    // Enter applies, but only from a field.
    if (event.key !== "Enter" || !panel.contains(event.target as Node)) return;
    if ((event.target as HTMLElement).tagName !== "INPUT") return;
    event.preventDefault();
    apply();
  }

  function onReflow(): void {
    if (!request.anchor.isConnected) close();
    else place(panel, request.anchor);
  }

  controls.onApply(apply);
  controls.onCancel(close);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("scroll", onReflow, true);
  window.addEventListener("resize", onReflow);

  current = { panel, close };
  redraw();
  controls.focus();
}

interface Controls {
  render(draft: DirectiveDraft): void;
  focus(): void;
  onApply(handler: () => void): void;
  onCancel(handler: () => void): void;
}

/** A label and the controls beside it, kept together so a whole row can be hidden. */
interface Field {
  row: HTMLElement;
  control: HTMLElement;
}

/**
 * Builds every row once and hides the ones the draft does not use. Rebuilding the panel on each
 * change would interrupt typing in a field.
 */
function buildControls(
  panel: HTMLElement,
  request: PickerRequest,
  draft: DirectiveDraft,
  changed: () => void,
): Controls {
  const locked = request.lockedRepeat;

  const kind = field(panel, "Event");
  const allDayButton = choice(kind.control, "All day", () => {
    draft.allDay = true;
    changed();
  });
  const timedButton = choice(kind.control, "Timed", () => {
    draft.allDay = false;
    changed();
  });

  const date = field(panel, "Starts");
  const dateInput = date.control.createEl("input", { type: "date", cls: "gcal-picker-input" });
  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    draft.date = dateInput.value;
    // Picking a date is deliberate, so the start stops following today.
    draft.dateImplied = false;
    changed();
  });
  const timeInput = date.control.createEl("input", { type: "time", cls: "gcal-picker-input" });
  timeInput.addEventListener("change", () => {
    if (!timeInput.value) return;
    draft.time = timeInput.value.slice(0, 5);
    changed();
  });
  const offsetNote = date.control.createSpan({ cls: "gcal-picker-note" });
  const impliedHint = panel.createDiv({
    cls: "gcal-picker-hint",
    text: "Today. Not written in the note, so the event stays on the day it was created.",
  });

  const length = field(panel, "Lasts");
  const hoursInput = counter(length.control, "Hours", 0, MAX_HOURS, "h");
  const minutesInput = counter(length.control, "Minutes", 0, 59, "m");
  const daysInput = counter(length.control, "Days", 1, 366, "days");
  const setTimedLength = (): void => {
    draft.minutes = Math.max(1, count(hoursInput) * 60 + count(minutesInput));
    changed();
  };
  hoursInput.addEventListener("change", setTimedLength);
  minutesInput.addEventListener("change", setTimedLength);
  daysInput.addEventListener("change", () => {
    draft.days = Math.max(1, count(daysInput));
    changed();
  });

  const repeat = field(panel, "Repeats");
  const repeatSelect = repeat.control.createEl("select", { cls: "gcal-picker-input dropdown" });
  fillRepeatOptions(repeatSelect, draft.repeat);
  repeatSelect.addEventListener("change", () => {
    draft.repeat = repeatFor(repeatSelect.value, draft.repeat);
    changed();
  });
  const lockedNote = repeat.control.createSpan({ cls: "gcal-picker-note" });
  if (locked) {
    repeatSelect.disabled = true;
    lockedNote.setText(locked);
  }

  const weekdays = field(panel, "On");
  const dayButtons = WEEKDAY_CODES.map((code, index) =>
    choice(weekdays.control, weekdayName(index, request.options.locale), () => {
      draft.repeat = toggleWeekday(draft.repeat, code);
      changed();
    }),
  );

  const every = field(panel, "Every");
  const countInput = counter(every.control, "Interval", 1, 999);
  const unitSelect = every.control.createEl("select", { cls: "gcal-picker-input dropdown" });
  for (const unit of UNITS) {
    unitSelect.createEl("option", { value: unit, text: UNIT_LABELS[unit] });
  }
  const setInterval = (): void => {
    draft.repeat = {
      kind: "interval",
      count: Math.max(1, count(countInput)),
      unit: (unitSelect.value as RepeatUnit) || "week",
    };
    changed();
  };
  countInput.addEventListener("change", setInterval);
  unitSelect.addEventListener("change", setInterval);

  const rule = field(panel, "Rule");
  const ruleInput = rule.control.createEl("input", {
    type: "text",
    cls: "gcal-picker-input gcal-picker-rule",
    attr: { placeholder: "FREQ=MONTHLY;BYMONTHDAY=1" },
  });
  ruleInput.addEventListener("input", () => {
    draft.repeat = { kind: "raw", text: ruleInput.value };
    changed();
  });

  const preview = panel.createDiv({ cls: "gcal-picker-preview" });
  const words = preview.createDiv({ cls: "gcal-picker-words" });
  const written = preview.createEl("code", { cls: "gcal-picker-written" });

  const actions = panel.createDiv({ cls: "gcal-picker-actions" });
  const cancelButton = actions.createEl("button", { text: "Cancel" });
  const applyButton = actions.createEl("button", { text: "Apply", cls: "mod-cta" });

  return {
    render(next) {
      allDayButton.toggleClass("is-active", next.allDay);
      timedButton.toggleClass("is-active", !next.allDay);
      setValue(dateInput, next.date);
      setValue(timeInput, next.time);
      offsetNote.setText(next.offset === "Z" ? "UTC" : next.offset);

      setValue(hoursInput, String(Math.floor(next.minutes / 60)));
      setValue(minutesInput, String(next.minutes % 60));
      setValue(daysInput, String(next.days));
      setValue(countInput, String(next.repeat.kind === "interval" ? next.repeat.count : 1));
      if (next.repeat.kind === "interval") setValue(unitSelect, next.repeat.unit);
      setValue(ruleInput, next.repeat.kind === "raw" ? next.repeat.text : "");
      if (!locked) setValue(repeatSelect, repeatValue(next.repeat));

      const chosen = next.repeat.kind === "weekdays" ? next.repeat.days : [];
      dayButtons.forEach((button, index) => {
        const active = chosen.includes(WEEKDAY_CODES[index] ?? "");
        button.toggleClass("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });

      show(impliedHint, next.dateImplied);
      show(timeInput, !next.allDay);
      show(offsetNote, !next.allDay && next.offset !== "");
      show(hoursInput.parentElement, !next.allDay);
      show(minutesInput.parentElement, !next.allDay);
      show(daysInput.parentElement, next.allDay);
      show(weekdays.row, !locked && next.repeat.kind === "weekdays");
      show(every.row, !locked && next.repeat.kind === "interval");
      show(rule.row, !locked && next.repeat.kind === "raw");

      const directive = writeDraft(next);
      written.setText(previewDirective(directive));
      words.setText(describeDirective(directive, request.options));
      // A weekday list with nothing chosen, or an empty rule, has nothing to write.
      applyButton.disabled = directive.repeat === undefined && next.repeat.kind !== "none";
    },
    focus() {
      dateInput.focus();
    },
    onApply(handler) {
      applyButton.addEventListener("click", handler);
    },
    onCancel(handler) {
      cancelButton.addEventListener("click", handler);
    },
  };
}

function fillRepeatOptions(select: HTMLSelectElement, repeat: RepeatDraft): void {
  select.createEl("option", { value: "none", text: "Does not repeat" });
  for (const period of PERIODS) {
    select.createEl("option", { value: period, text: PERIOD_LABELS[period] });
  }
  select.createEl("option", { value: "weekdays", text: "Chosen weekdays" });
  select.createEl("option", { value: "interval", text: "Every few…" });
  // Offered only when the note already holds a rule the picker has no control for.
  if (repeat.kind === "raw") select.createEl("option", { value: "raw", text: "As written" });
}

function repeatValue(repeat: RepeatDraft): string {
  return repeat.kind === "period" ? repeat.period : repeat.kind;
}

/** Reuses the previous rule's values, so switching between choices loses nothing. */
function repeatFor(value: string, previous: RepeatDraft): RepeatDraft {
  if (value === "none") return { kind: "none" };
  if (value === "weekdays") {
    const kept =
      previous.kind === "weekdays" && previous.days.length > 0 ? previous.days : WORKING_WEEK;
    return { kind: "weekdays", days: [...kept] };
  }
  if (value === "interval") {
    return previous.kind === "interval" ? previous : { kind: "interval", count: 2, unit: "week" };
  }
  if (value === "raw") return previous.kind === "raw" ? previous : { kind: "raw", text: "" };
  return { kind: "period", period: value as RepeatPeriod };
}

function toggleWeekday(repeat: RepeatDraft, code: string): RepeatDraft {
  const days = repeat.kind === "weekdays" ? repeat.days : [];
  const next = days.includes(code) ? days.filter((day) => day !== code) : [...days, code];
  return { kind: "weekdays", days: orderWeekdays(next) };
}

function field(panel: HTMLElement, label: string): Field {
  const row = panel.createDiv({ cls: "gcal-picker-field" });
  row.createSpan({ cls: "gcal-picker-label", text: label });
  return { row, control: row.createDiv({ cls: "gcal-picker-control" }) };
}

function choice(parent: HTMLElement, label: string, onClick: () => void): HTMLElement {
  const button = parent.createEl("button", { cls: "gcal-picker-choice", text: label });
  button.addEventListener("click", onClick);
  return button;
}

function counter(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  unit?: string,
): HTMLInputElement {
  const holder = parent.createDiv({ cls: "gcal-picker-counter" });
  const input = holder.createEl("input", {
    type: "number",
    cls: "gcal-picker-input gcal-picker-number",
    attr: { min, max, step: 1, "aria-label": label },
  });
  if (unit) holder.createSpan({ cls: "gcal-picker-note", text: unit });
  return input;
}

function count(input: HTMLInputElement): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Only writes a field whose value changed, so a redraw does not move the cursor or clear typing. */
function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (input.value !== value) input.value = value;
}

function show(element: HTMLElement | null, visible: boolean): void {
  element?.toggleClass(HIDDEN, !visible);
}

/** Under the icon, flipped above it when there is no room, and always inside the window. */
function place(panel: HTMLElement, anchor: HTMLElement): void {
  const target = anchor.getBoundingClientRect();
  const size = panel.getBoundingClientRect();

  let top = target.bottom + PANEL_GAP;
  if (top + size.height > window.innerHeight - PANEL_GAP) {
    top = Math.max(PANEL_GAP, target.top - PANEL_GAP - size.height);
  }
  const rightmost = Math.max(PANEL_GAP, window.innerWidth - size.width - PANEL_GAP);
  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(Math.min(Math.max(PANEL_GAP, target.left), rightmost))}px`;
}

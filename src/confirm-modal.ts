import { type App, Modal, Setting } from "obsidian";
import type { ReconciliationSummary } from "./gcal";

/**
 * Asks the user to approve a large or destructive sync before it reaches Google Calendar.
 * Resolves false when the modal is dismissed without a choice.
 */
export function confirmReconciliation(app: App, summary: ReconciliationSummary): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  new ReconciliationModal(app, summary, resolve).open();
  return promise;
}

class ReconciliationModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly summary: ReconciliationSummary,
    private readonly decide: (approved: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Review Google Calendar changes");
    this.contentEl.createEl("p", {
      text: `This sync would create ${this.summary.creates}, update ${this.summary.updates}, and delete ${this.summary.deletes} events on the selected calendar.`,
    });
    this.contentEl.createEl("p", {
      text: "Every change comes from an event declaration in a vault note. Approve only if this matches edits you made.",
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish(false)))
      .addButton((button) =>
        button
          .setButtonText("Apply changes")
          .setWarning()
          .onClick(() => this.finish(true)),
      );
  }

  override onClose(): void {
    this.finish(false);
  }

  private finish(approved: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.decide(approved);
    this.close();
  }
}

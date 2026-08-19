import {
  type App,
  type ButtonComponent,
  type DropdownComponent,
  Notice,
  PluginSettingTab,
  SecretComponent,
  Setting,
} from "obsidian";
import { DEFAULT_MAX_CHANGES_PER_SYNC, type GcalInfo, revokeGoogleAuthorization } from "./gcal";
import {
  AUTHORIZATION_TIMEOUT_MS,
  authorizeGoogle,
  GOOGLE_AUTHORIZATION_VERSION,
} from "./gcal-oauth";
import type GcalSyncPlugin from "./main";

const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

export interface GcalSyncSettings {
  calendarId: string;
  clientIdSecret: string;
  clientSecretSecret: string;
  refreshTokenSecret: string;
  googleAuthorizationVersion: number;
  syncIntervalMinutes: number;
  timeZone: string;
  vaultId: string;
  /** Folders whose notes may declare events. Empty means the whole vault. */
  syncFolders: string[];
  /** Ceiling on how many events one sync may create, update, and delete. */
  maxChangesPerSync: number;
}

export function defaultSettings(vaultId: string): GcalSyncSettings {
  return {
    calendarId: "primary",
    clientIdSecret: "",
    clientSecretSecret: "",
    refreshTokenSecret: "",
    googleAuthorizationVersion: 0,
    syncIntervalMinutes: 15,
    timeZone: "",
    vaultId,
    syncFolders: [],
    maxChangesPerSync: DEFAULT_MAX_CHANGES_PER_SYNC,
  };
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The zone a start with no UTC offset is read in. Empty means follow this device. */
export function resolveTimeZone(timeZone: string): string {
  return timeZone || systemTimeZone();
}

/** Normalizes one folder per line into vault-relative paths without surrounding slashes. */
export function parseSyncFolders(value: string): string[] {
  const folders = value
    .split("\n")
    .map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
    .filter((line) => line.length > 0);
  return Array.from(new Set(folders));
}

export class GcalSettingTab extends PluginSettingTab {
  private authorization: AbortController | undefined;
  private countdownTimer: number | undefined;

  constructor(
    app: App,
    private readonly plugin: GcalSyncPlugin,
  ) {
    super(app, plugin);
  }

  /** Leaving the tab abandons any half-finished sign-in rather than leaving a listener open. */
  override hide(): void {
    this.cancelAuthorization();
  }

  override display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl).setName("Google OAuth").setHeading();
    new Setting(this.containerEl)
      .setName("OAuth client ID")
      .setDesc("Select or create an Obsidian secret containing the Desktop OAuth client ID.")
      .addComponent((element) =>
        new SecretComponent(this.app, element)
          .setValue(this.plugin.settings.clientIdSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientIdSecret = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(this.containerEl)
      .setName("OAuth client secret")
      .setDesc("Select or create the matching client secret. Leave empty if the client has none.")
      .addComponent((element) =>
        new SecretComponent(this.app, element)
          .setValue(this.plugin.settings.clientSecretSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecretSecret = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(this.containerEl)
      .setName("Google authorization")
      .setDesc(
        "Grants event, calendar-list, and calendar-creation access, then saves the refresh token in Obsidian SecretStorage.",
      )
      .addButton((button) => {
        this.resetAuthorizeButton(button);
        button.onClick(async () => {
          // While a sign-in is in flight the same button cancels it, so a browser tab the user
          // closed or never finished does not leave the setting stuck until the deadline.
          if (this.authorization) {
            this.cancelAuthorization();
            return;
          }
          await this.runAuthorization(button);
        });
      });

    if (this.plugin.settings.refreshTokenSecret) {
      new Setting(this.containerEl)
        .setName("Disconnect Google")
        .setDesc(
          `Revokes the stored refresh token with Google and clears it from this vault. If you are removing the plugin, also delete its access at ${GOOGLE_PERMISSIONS_URL}.`,
        )
        .addButton((button) =>
          button
            .setButtonText("Disconnect and revoke")
            .setWarning()
            .onClick(async () => {
              button.setDisabled(true).setButtonText("Revoking…");
              try {
                await this.disconnect();
                new Notice("Google Calendar authorization revoked");
              } catch (error) {
                new Notice(
                  `${errorMessage(error)}. The token was cleared from this vault; revoke it at ${GOOGLE_PERMISSIONS_URL}.`,
                  10_000,
                );
              } finally {
                this.display();
              }
            }),
        );
    }

    new Setting(this.containerEl).setName("Calendar sync").setHeading();
    this.displayCalendarSettings();

    new Setting(this.containerEl)
      .setName("Event time zone")
      .setDesc(
        `IANA time zone for starts written without a UTC offset, such as America/New_York. ` +
          `Leave empty to follow this device, currently ${systemTimeZone()}.`,
      )
      .addText((text) =>
        text
          .setPlaceholder(systemTimeZone())
          .setValue(this.plugin.settings.timeZone)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed && !isTimeZone(trimmed)) return;
            this.plugin.settings.timeZone = trimmed;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(this.containerEl)
      .setName("Full scan interval")
      .setDesc("Minutes between full vault reconciliations. File changes sync incrementally.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async (value) => {
          const minutes = Number.parseInt(value, 10);
          if (!Number.isInteger(minutes) || minutes < 1) return;
          this.plugin.settings.syncIntervalMinutes = minutes;
          await this.plugin.saveSettings();
          this.plugin.resetPeriodicSync();
        }),
      );

    new Setting(this.containerEl)
      .setName("Synced folders")
      .setDesc(
        "One vault-relative folder per line. Only notes inside these folders may declare events. " +
          "Leave empty to scan the whole vault. Use this when other people can write to the vault.",
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("Calendar\nProjects/Planning")
          .setValue(this.plugin.settings.syncFolders.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.syncFolders = parseSyncFolders(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(this.containerEl)
      .setName("Change limit per sync")
      .setDesc(
        "Stops a sync that would create, update, or delete more events than this. Guards against " +
          "a note that declares events in bulk.",
      )
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxChangesPerSync)).onChange(async (value) => {
          const limit = Number.parseInt(value, 10);
          if (!Number.isInteger(limit) || limit < 1) return;
          this.plugin.settings.maxChangesPerSync = limit;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(this.containerEl)
      .setName("Sync now")
      .setDesc("Scans every Markdown note and reconciles all managed Google Calendar events.")
      .addButton((button) =>
        button.setButtonText("Sync").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.syncNow(true);
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    new Setting(this.containerEl).setName("Event syntax").setHeading();
    new Setting(this.containerEl).setDesc(
      "Inline, in backticks, titled by the text before it: " +
        "Design review `gcal:2026-08-18T14:00/PT1H`. Add `gcal-repeat:weekly` to make it recur. " +
        "Only a code span holding nothing but directives counts, so a note can describe the " +
        "syntax safely. Events keep their identity when you move or rename things, with no id " +
        "to write. " +
        "In note properties, titled by the note name: gcal: 2026-08-18. For several events use a " +
        "list of maps with when, title, repeat, and id fields. " +
        "Starts: a date alone is all-day, a time alone is today, and a date with a time uses the " +
        "event time zone above unless you add Z or an offset. Times are written to the minute. " +
        "Duration follows a slash and defaults to one hour. " +
        "Repeat rules: daily, weekly, monthly, quarterly, yearly, weekdays, monday-thursday, " +
        "every-2-weeks, or an RRULE.",
    );

    new Setting(this.containerEl).setName("Trust model").setHeading();
    new Setting(this.containerEl).setDesc(
      "Any note in a synced folder can create, change, or delete events on the selected calendar, " +
        "using your Google authorization. Treat write access to those folders as write access to " +
        "the calendar. If other people or automations can write to this vault, restrict Synced " +
        "folders to notes you control. Note and folder names are hashed before they reach Google, " +
        "but event titles are uploaded as written.",
    );
  }

  private async disconnect(): Promise<void> {
    const secretId = this.plugin.settings.refreshTokenSecret;
    const refreshToken = secretId ? this.app.secretStorage.getSecret(secretId) : null;

    // Clear the local token first so a failed revocation still leaves the vault disconnected.
    this.plugin.settings.refreshTokenSecret = "";
    this.plugin.settings.googleAuthorizationVersion = 0;
    await this.plugin.saveSettings();
    if (secretId) this.app.secretStorage.setSecret(secretId, "");

    if (!refreshToken) return;
    await revokeGoogleAuthorization(refreshToken);
  }

  private displayCalendarSettings(): void {
    const selectedId = this.plugin.settings.calendarId;
    const calendarSetting = new Setting(this.containerEl)
      .setName("Calendar")
      .setDesc("Authorize Google to load writable calendars.");

    calendarSetting.addDropdown((dropdown) => {
      dropdown
        .addOption(selectedId, selectedId)
        .setValue(selectedId)
        .setDisabled(true)
        .onChange(async (value) => {
          this.plugin.settings.calendarId = value;
          await this.plugin.saveSettings();
        });
      if (!this.plugin.settings.refreshTokenSecret) return;
      if (this.plugin.settings.googleAuthorizationVersion < GOOGLE_AUTHORIZATION_VERSION) {
        calendarSetting.setDesc(
          "Authorize Google again to grant calendar selection and creation access.",
        );
        return;
      }

      calendarSetting.addButton((button) => {
        const loadCalendars = async (): Promise<void> => {
          button.setDisabled(true);
          dropdown.setDisabled(true);
          calendarSetting.setDesc("Loading writable calendars from Google…");
          try {
            const calendars = await this.plugin.listWritableCalendars();
            this.populateCalendarDropdown(dropdown, calendars, selectedId);
            calendarSetting.setDesc(
              "Select a writable calendar. Changing calendars does not remove events from the previous calendar.",
            );
          } catch (error) {
            calendarSetting.setDesc("Could not load calendars. Authorize Google again or retry.");
            new Notice(errorMessage(error), 10_000);
          } finally {
            button.setDisabled(false);
          }
        };

        button.setButtonText("Refresh").onClick(loadCalendars);
        void loadCalendars();
      });
    });

    if (
      !this.plugin.settings.refreshTokenSecret ||
      this.plugin.settings.googleAuthorizationVersion < GOOGLE_AUTHORIZATION_VERSION
    ) {
      return;
    }

    let calendarName = "";
    new Setting(this.containerEl)
      .setName("Create calendar")
      .setDesc("Creates a secondary Google Calendar and selects it for future syncs.")
      .addText((text) =>
        text.setPlaceholder("Obsidian").onChange((value) => {
          calendarName = value;
        }),
      )
      .addButton((button) =>
        button.setButtonText("Create").onClick(async () => {
          const normalizedName = calendarName.trim();
          if (!normalizedName) {
            new Notice("Enter a calendar name");
            return;
          }

          button.setDisabled(true).setButtonText("Creating…");
          try {
            const calendar = await this.plugin.createCalendar(normalizedName);
            this.plugin.settings.calendarId = calendar.id;
            await this.plugin.saveSettings();
            new Notice(`Created and selected ${calendar.name}. Sync now to populate it.`);
            this.display();
          } catch (error) {
            new Notice(errorMessage(error), 10_000);
            button.setDisabled(false).setButtonText("Create");
          }
        }),
      );
  }

  private populateCalendarDropdown(
    dropdown: DropdownComponent,
    calendars: GcalInfo[],
    selectedId: string,
  ): void {
    dropdown.selectEl.empty();
    let selectedAvailable = false;
    for (const calendar of calendars) {
      const value = calendar.primary ? "primary" : calendar.id;
      const label = calendar.primary ? `${calendar.name} (primary)` : calendar.name;
      dropdown.addOption(value, label);
      selectedAvailable ||= value === selectedId;
    }
    if (!selectedAvailable) {
      dropdown.addOption(selectedId, `${selectedId} (configured, unavailable)`);
    }
    dropdown.setValue(selectedId).setDisabled(false);
  }

  private async runAuthorization(button: ButtonComponent): Promise<void> {
    const controller = new AbortController();
    this.authorization = controller;
    button.removeCta();
    this.startCountdown(button);

    try {
      await this.authorize(controller.signal);
      this.finishAuthorization(button);
      new Notice("Google Calendar authorization saved");
      this.display();
    } catch (error) {
      this.finishAuthorization(button);
      new Notice(errorMessage(error), 10_000);
    }
  }

  /** Counts the sign-in deadline down on the button so the wait has a visible end. */
  private startCountdown(button: ButtonComponent): void {
    const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS;
    const render = (): void => {
      button.setButtonText(`Cancel (${formatRemaining(deadline - Date.now())})`);
    };
    render();
    this.countdownTimer = window.setInterval(render, 1_000);
  }

  private cancelAuthorization(): void {
    this.authorization?.abort();
    this.authorization = undefined;
    if (this.countdownTimer !== undefined) window.clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  private finishAuthorization(button: ButtonComponent): void {
    this.cancelAuthorization();
    this.resetAuthorizeButton(button);
  }

  private resetAuthorizeButton(button: ButtonComponent): void {
    button
      .setButtonText(this.plugin.settings.refreshTokenSecret ? "Authorize again" : "Authorize")
      .setCta();
  }

  private async authorize(signal: AbortSignal): Promise<void> {
    const clientId = this.readSecret(this.plugin.settings.clientIdSecret, "OAuth client ID");
    const clientSecret = this.plugin.settings.clientSecretSecret
      ? this.readSecret(this.plugin.settings.clientSecretSecret, "OAuth client secret")
      : undefined;
    const refreshToken = await authorizeGoogle({ clientId, clientSecret, signal });
    const secretId = `gcal-sync-${this.plugin.settings.vaultId}-refresh-token`;
    this.app.secretStorage.setSecret(secretId, refreshToken);
    this.plugin.settings.refreshTokenSecret = secretId;
    this.plugin.settings.googleAuthorizationVersion = GOOGLE_AUTHORIZATION_VERSION;
    await this.plugin.saveSettings();
  }

  private readSecret(secretId: string, label: string): string {
    if (!secretId) throw new Error(`${label} secret is not selected`);
    const value = this.app.secretStorage.getSecret(secretId);
    if (!value) throw new Error(`${label} secret is empty or missing`);
    return value;
  }
}

/** Formats a remaining duration as m:ss, floored at zero. */
function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

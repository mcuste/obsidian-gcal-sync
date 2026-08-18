import {
  type App,
  type DropdownComponent,
  Notice,
  PluginSettingTab,
  SecretComponent,
  Setting,
} from "obsidian";
import type { GoogleCalendarInfo } from "./google-calendar";
import { authorizeGoogle, GOOGLE_AUTHORIZATION_VERSION } from "./google-oauth";
import type GoogleCalendarSyncPlugin from "./main";

export interface GoogleCalendarSyncSettings {
  calendarId: string;
  clientIdSecret: string;
  clientSecretSecret: string;
  refreshTokenSecret: string;
  googleAuthorizationVersion: number;
  syncIntervalMinutes: number;
  timeZone: string;
  vaultId: string;
}

export function defaultSettings(vaultId: string): GoogleCalendarSyncSettings {
  return {
    calendarId: "primary",
    clientIdSecret: "",
    clientSecretSecret: "",
    refreshTokenSecret: "",
    googleAuthorizationVersion: 0,
    syncIntervalMinutes: 15,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    vaultId,
  };
}

export class GoogleCalendarSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: GoogleCalendarSyncPlugin,
  ) {
    super(app, plugin);
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
      .addButton((button) =>
        button
          .setButtonText(this.plugin.settings.refreshTokenSecret ? "Authorize again" : "Authorize")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Waiting for Google…");
            try {
              await this.authorize();
              new Notice("Google Calendar authorization saved");
              this.display();
            } catch (error) {
              new Notice(errorMessage(error), 10_000);
              button.setDisabled(false).setButtonText("Authorize");
            }
          }),
      );

    new Setting(this.containerEl).setName("Calendar sync").setHeading();
    this.displayCalendarSettings();

    new Setting(this.containerEl)
      .setName("Event time zone")
      .setDesc("IANA time zone used for timed and recurring events, such as America/New_York.")
      .addText((text) =>
        text.setValue(this.plugin.settings.timeZone).onChange(async (value) => {
          const trimmed = value.trim();
          if (!isTimeZone(trimmed)) return;
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
      "Inline: Meeting #gcal:2026-08-18T14:00:00-04:00/PT1H. " +
        "Note property: gcal: 2026-08-18. Recurrence: #gcal-repeat:weekly, " +
        "#gcal-repeat:monday-thursday, or an RRULE. Add #gcal-id:stable-name to keep " +
        "an inline event stable when lines move. Timed values require Z or a UTC offset.",
    );
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
    calendars: GoogleCalendarInfo[],
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

  private async authorize(): Promise<void> {
    const clientId = this.readSecret(this.plugin.settings.clientIdSecret, "OAuth client ID");
    const clientSecret = this.plugin.settings.clientSecretSecret
      ? this.readSecret(this.plugin.settings.clientSecretSecret, "OAuth client secret")
      : undefined;
    const refreshToken = await authorizeGoogle({ clientId, clientSecret });
    const secretId = `obsidian-gcloud-${this.plugin.settings.vaultId}-refresh-token`;
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

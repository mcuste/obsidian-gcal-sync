import {
  App,
  Notice,
  PluginSettingTab,
  SecretComponent,
  Setting
} from "obsidian";
import { authorizeGoogle } from "./google-oauth";
import type GoogleCalendarSyncPlugin from "./main";

export interface GoogleCalendarSyncSettings {
  calendarId: string;
  clientIdSecret: string;
  clientSecretSecret: string;
  refreshTokenSecret: string;
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
    syncIntervalMinutes: 15,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    vaultId
  };
}

export class GoogleCalendarSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GoogleCalendarSyncPlugin) {
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
          })
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
          })
      );

    new Setting(this.containerEl)
      .setName("Google authorization")
      .setDesc("Opens Google in your browser and saves the returned refresh token in Obsidian SecretStorage.")
      .addButton((button) =>
        button
          .setButtonText(
            this.plugin.settings.refreshTokenSecret ? "Authorize again" : "Authorize"
          )
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
          })
      );

    new Setting(this.containerEl).setName("Calendar sync").setHeading();
    new Setting(this.containerEl)
      .setName("Calendar ID")
      .setDesc("Use primary or a calendar ID from Google Calendar settings.")
      .addText((text) =>
        text
          .setPlaceholder("primary")
          .setValue(this.plugin.settings.calendarId)
          .onChange(async (value) => {
            this.plugin.settings.calendarId = value.trim() || "primary";
            await this.plugin.saveSettings();
          })
      );

    new Setting(this.containerEl)
      .setName("Event time zone")
      .setDesc("IANA time zone used for timed and recurring events, such as America/New_York.")
      .addText((text) =>
        text.setValue(this.plugin.settings.timeZone).onChange(async (value) => {
          const trimmed = value.trim();
          if (!isTimeZone(trimmed)) return;
          this.plugin.settings.timeZone = trimmed;
          await this.plugin.saveSettings();
        })
      );

    new Setting(this.containerEl)
      .setName("Full scan interval")
      .setDesc("Minutes between full vault reconciliations. File changes sync incrementally.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const minutes = Number.parseInt(value, 10);
            if (!Number.isInteger(minutes) || minutes < 1) return;
            this.plugin.settings.syncIntervalMinutes = minutes;
            await this.plugin.saveSettings();
            this.plugin.resetPeriodicSync();
          })
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
        })
      );

    new Setting(this.containerEl).setName("Event syntax").setHeading();
    new Setting(this.containerEl).setDesc(
      "Inline: Meeting #gcal:2026-08-18T14:00:00-04:00/PT1H. " +
        "Note property: gcal: 2026-08-18. Recurrence: #gcal-repeat:weekly, " +
        "#gcal-repeat:monday-thursday, or an RRULE. Add #gcal-id:stable-name to keep " +
        "an inline event stable when lines move. Timed values require Z or a UTC offset."
    );
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

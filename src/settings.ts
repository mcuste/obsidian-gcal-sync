import {
  type App,
  type ButtonComponent,
  type DropdownComponent,
  Notice,
  PluginSettingTab,
  SecretComponent,
  type Setting,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
} from "obsidian";
import { DEFAULT_MAX_CHANGES_PER_SYNC, type GcalInfo, revokeGoogleAuthorization } from "./gcal";
import {
  AUTHORIZATION_TIMEOUT_MS,
  authorizeGoogle,
  GOOGLE_AUTHORIZATION_VERSION,
} from "./gcal-oauth";
import type GcalSyncPlugin from "./main";

const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

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
    syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
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

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.googleOAuthGroup(),
      this.calendarSyncGroup(),
      eventSyntaxGroup(),
      trustModelGroup(),
    ];
  }

  /** Synced folders are stored as a list but edited as lines. */
  override getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    switch (key) {
      case "timeZone":
        return settings.timeZone;
      case "syncIntervalMinutes":
        return settings.syncIntervalMinutes;
      case "syncFolders":
        return settings.syncFolders.join("\n");
      case "maxChangesPerSync":
        return settings.maxChangesPerSync;
      default:
        return undefined;
    }
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key) {
      case "timeZone":
        settings.timeZone = String(value).trim();
        break;
      case "syncIntervalMinutes":
        settings.syncIntervalMinutes = Number(value);
        break;
      case "syncFolders":
        settings.syncFolders = parseSyncFolders(String(value));
        break;
      case "maxChangesPerSync":
        settings.maxChangesPerSync = Number(value);
        break;
      default:
        return;
    }

    await this.plugin.saveSettings();
    if (key === "syncIntervalMinutes") this.plugin.resetPeriodicSync();
  }

  private googleOAuthGroup(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Google OAuth",
      items: [
        {
          name: "OAuth client ID",
          desc: "Select or create an Obsidian secret containing the Desktop OAuth client ID.",
          render: (setting) => this.renderSecretPicker(setting, "clientIdSecret"),
        },
        {
          name: "OAuth client secret",
          desc: "Select or create the matching client secret. Leave empty if the client has none.",
          render: (setting) => this.renderSecretPicker(setting, "clientSecretSecret"),
        },
        {
          name: "Google authorization",
          desc: "Grants event, calendar-list, and calendar-creation access, then saves the refresh token in Obsidian SecretStorage.",
          render: (setting) => this.renderAuthorization(setting),
        },
        {
          name: "Disconnect Google",
          desc: `Revokes the stored refresh token with Google and clears it from this vault. If you are removing the plugin, also delete its access at ${GOOGLE_PERMISSIONS_URL}.`,
          visible: () => Boolean(this.plugin.settings.refreshTokenSecret),
          render: (setting) => this.renderDisconnect(setting),
        },
      ],
    };
  }

  private calendarSyncGroup(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Calendar sync",
      items: [
        {
          name: "Calendar",
          desc: "Authorize Google to load writable calendars.",
          render: (setting) => this.renderCalendarPicker(setting),
        },
        {
          name: "Create calendar",
          desc: "Creates a secondary Google Calendar and selects it for future syncs.",
          visible: () => this.canSelectCalendars(),
          render: (setting) => this.renderCalendarCreator(setting),
        },
        {
          name: "Event time zone",
          desc:
            `IANA time zone for starts written without a UTC offset, such as America/New_York. ` +
            `Leave empty to follow this device, currently ${systemTimeZone()}.`,
          control: {
            type: "text",
            key: "timeZone",
            placeholder: systemTimeZone(),
            validate: validateTimeZone,
          },
        },
        {
          name: "Full scan interval",
          desc: "Minutes between full vault reconciliations. File changes sync incrementally.",
          control: {
            type: "number",
            key: "syncIntervalMinutes",
            defaultValue: DEFAULT_SYNC_INTERVAL_MINUTES,
            min: 1,
            step: 1,
            validate: (value) => validateCount(value, "minutes"),
          },
        },
        {
          name: "Synced folders",
          desc:
            "One vault-relative folder per line. Only notes inside these folders may declare events. " +
            "Leave empty to scan the whole vault. Use this when other people can write to the vault.",
          control: {
            type: "textarea",
            key: "syncFolders",
            placeholder: "Calendar\nProjects/Planning",
          },
        },
        {
          name: "Change limit per sync",
          desc:
            "Stops a sync that would create, update, or delete more events than this. Guards against " +
            "a note that declares events in bulk.",
          control: {
            type: "number",
            key: "maxChangesPerSync",
            defaultValue: DEFAULT_MAX_CHANGES_PER_SYNC,
            min: 1,
            step: 1,
            validate: (value) => validateCount(value, "events"),
          },
        },
        {
          name: "Sync now",
          desc: "Scans every Markdown note and reconciles all managed Google Calendar events.",
          render: (setting) => this.renderSyncNow(setting),
        },
      ],
    };
  }

  private renderSecretPicker(setting: Setting, key: "clientIdSecret" | "clientSecretSecret"): void {
    setting.addComponent((element) =>
      new SecretComponent(this.app, element)
        .setValue(this.plugin.settings[key])
        .onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
        }),
    );
  }

  private renderAuthorization(setting: Setting): void {
    setting.addButton((button) => {
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
  }

  private renderDisconnect(setting: Setting): void {
    setting.addButton((button) =>
      button
        .setButtonText("Disconnect and revoke")
        .setDestructive()
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
            this.update();
          }
        }),
    );
  }

  private renderSyncNow(setting: Setting): void {
    setting.addButton((button) =>
      button.setButtonText("Sync").onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.syncNow(true);
        } finally {
          button.setDisabled(false);
        }
      }),
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

  /** Selecting and creating calendars needs the scopes granted by the current sign-in flow. */
  private canSelectCalendars(): boolean {
    return (
      Boolean(this.plugin.settings.refreshTokenSecret) &&
      this.plugin.settings.googleAuthorizationVersion >= GOOGLE_AUTHORIZATION_VERSION
    );
  }

  private renderCalendarPicker(setting: Setting): void {
    const selectedId = this.plugin.settings.calendarId;

    setting.addDropdown((dropdown) => {
      dropdown
        .addOption(selectedId, selectedId)
        .setValue(selectedId)
        .setDisabled(true)
        .onChange(async (value) => {
          this.plugin.settings.calendarId = value;
          await this.plugin.saveSettings();
        });
      if (!this.plugin.settings.refreshTokenSecret) return;
      if (!this.canSelectCalendars()) {
        setting.setDesc("Authorize Google again to grant calendar selection and creation access.");
        return;
      }

      setting.addButton((button) => {
        const loadCalendars = async (): Promise<void> => {
          button.setDisabled(true);
          dropdown.setDisabled(true);
          setting.setDesc("Loading writable calendars from Google…");
          try {
            const calendars = await this.plugin.listWritableCalendars();
            this.populateCalendarDropdown(dropdown, calendars, selectedId);
            setting.setDesc(
              "Select a writable calendar. Changing calendars does not remove events from the previous calendar.",
            );
          } catch (error) {
            setting.setDesc("Could not load calendars. Authorize Google again or retry.");
            new Notice(errorMessage(error), 10_000);
          } finally {
            button.setDisabled(false);
          }
        };

        button.setButtonText("Refresh").onClick(loadCalendars);
        void loadCalendars();
      });
    });
  }

  private renderCalendarCreator(setting: Setting): void {
    let calendarName = "";

    setting
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
            this.update();
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
      this.update();
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

/** Reference rows: text the tab ends with, carrying no controls. */
function eventSyntaxGroup(): SettingDefinitionGroup {
  return {
    type: "group",
    heading: "Event syntax",
    items: [
      {
        name: "Inline declarations",
        desc:
          "In backticks, titled by the text before it: " +
          "Design review `gcal:2026-08-18T14:00/PT1H`. Add `gcal-repeat:weekly` to make it recur. " +
          "Only a code span holding nothing but directives counts, so a note can describe the " +
          "syntax without declaring events.",
      },
      {
        name: "Note properties",
        desc:
          "In note properties, titled by the note name: gcal: 2026-08-18. For several events, use " +
          "a list of maps with when, title, and repeat fields.",
      },
      {
        name: "Starts and durations",
        desc:
          "A date alone is all-day, a time alone is today, and a date with a time uses the event " +
          "time zone above unless you add Z or an offset. Times are written to the minute. " +
          "A duration follows a slash and defaults to one hour.",
      },
      {
        name: "Repeat rules",
        desc:
          "daily, weekly, monthly, quarterly, yearly, weekdays, monday-thursday, every-2-weeks, " +
          "or an RRULE.",
      },
      {
        name: "Event identity",
        desc: "Moving a declaration or renaming a note keeps its events, so there is no id to write.",
      },
    ],
  };
}

function trustModelGroup(): SettingDefinitionGroup {
  return {
    type: "group",
    heading: "Trust model",
    items: [
      {
        name: "Notes can change your calendar",
        desc:
          "Any note in a synced folder can create, change, or delete events on the selected calendar, " +
          "using your Google authorization. Treat write access to those folders as write access to " +
          "the calendar. If other people or automations can write to this vault, restrict Synced " +
          "folders to notes you control. Note and folder names are hashed before they reach Google, " +
          "but event titles are uploaded as written.",
      },
    ],
  };
}

function validateTimeZone(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed && !isTimeZone(trimmed)) {
    return "Not an IANA time zone. Try America/New_York, or leave it empty.";
  }
  return undefined;
}

function validateCount(value: number, unit: string): string | undefined {
  if (Number.isInteger(value) && value >= 1) return undefined;
  return `Enter a whole number of ${unit}, 1 or more.`;
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

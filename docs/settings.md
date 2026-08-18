# Settings

Open **Settings → Google Calendar Sync**.

## Google OAuth

**OAuth client ID** and **OAuth client secret** point at Obsidian secrets holding your Google Cloud
Desktop client credentials. Leave the secret empty if your client has none. See
[Getting started](getting-started.md) for how to create them.

**Google authorization** starts sign-in. Your browser opens Google's consent screen while the
plugin listens on a local callback port. The resulting refresh token goes into Obsidian's secret
storage. While sign-in is in flight the button counts down and doubles as a cancel button, and the
attempt is abandoned after 2 minutes or when you leave the settings tab.

**Disconnect and revoke** clears the token from the vault and revokes it with Google. The local
token is cleared first, so a failed revocation still leaves the vault disconnected. If you are
removing the plugin entirely, also remove its access at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Calendar sync

**Calendar** lists every calendar you can write to, loaded from Google. **Refresh** reloads the
list. Switching calendars does not move or remove events already on the old one.

**Create calendar** makes a new secondary calendar and selects it. This is the easiest way to keep
synced events separate from your everyday calendar.

**Event time zone** is the IANA zone that starts written without `Z` or a UTC offset are read in,
for example `America/New_York`. That includes a bare time such as `14:00`, whose date is today in
this zone. Leave it empty to follow whatever zone this device is in, which is what the placeholder
shows. Invalid values are ignored, and changing it moves every event that does not pin its own
offset.

**Full scan interval** is how many minutes pass between full vault reconciliations. Default 15.
Edits to individual notes sync within about a second regardless of this setting.

**Synced folders** limits which notes may declare events, one vault-relative folder per line. Empty
means the whole vault. Set this when anyone or anything other than you can write to the vault.

```
Calendar
Projects/Planning
```

**Change limit per sync** caps how many events one sync may create, update, and delete. Default
200. A sync that would exceed it stops without changing anything and reports the count, which
protects you from a note or script that generates events in bulk.

**Sync now** runs a full scan immediately, the same as the **Sync now** command in the command
palette. This is the only path that can approve a plan waiting for review.

The tab ends with two reference sections rather than settings: **Event syntax** is a one-paragraph
summary of [Event syntax](event-syntax.md), and **Trust model** restates who can change your
calendar, covered in [Security and privacy](security-and-privacy.md).

## Where settings live

Plain settings are stored in `<vault>/.obsidian/plugins/gcal-sync/data.json`, including a random
vault ID that marks the events belonging to this vault. Credentials and the refresh token are kept
in Obsidian's secret storage, outside the vault.

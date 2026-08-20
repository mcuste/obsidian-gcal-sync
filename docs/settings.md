# Settings

Open **Settings → Google Calendar Sync**.

## Google OAuth

![The OAuth client, authorization, and calendar settings](images/settings-google.png)

**OAuth client ID** and **OAuth client secret** point at Obsidian secrets holding your Google Cloud
Desktop client credentials. Leave the secret empty if your client has none. [Setup](setup.md)
covers creating them.

**Google authorization** starts sign-in. Your browser opens Google's consent screen while the
plugin listens on a local callback port, and the resulting refresh token goes into Obsidian's
secret storage. While sign-in is in flight the button counts down and doubles as a cancel button.
The attempt is abandoned after 2 minutes, or when you leave the settings tab.

**Disconnect Google** appears once you are connected. Its **Disconnect and revoke** button clears
the token from the vault and revokes it with Google. See
[Security and privacy](security-and-privacy.md#revoking-access) for what to check afterwards.

**Calendar** lists every calendar you can write to, loaded from Google. **Refresh** reloads the
list. Switching calendars leaves events on the old one where they are.

**Create calendar** makes a new secondary calendar and selects it. This is the easiest way to keep
synced events apart from your everyday calendar.

## Calendar sync

![The time zone, interval, folder, and change limit settings](images/settings-sync.png)

**Event time zone** is the IANA zone that starts written without `Z` or a UTC offset are read in,
for example `America/New_York`. Leave it empty to follow whatever zone this device is in, which is
what the placeholder shows. An unrecognized zone is rejected with a message under the setting.
Changing it moves every event that does not pin its own offset.
[Event syntax](event-syntax.md#start-and-duration) has the rules it applies to.

**Full scan interval** is how many minutes pass between full vault reconciliations. Default 15.
Edits to individual notes sync within about a second whatever this is set to.

**Synced folders** limits which notes may declare events, one vault-relative folder per line. Empty
means the whole vault. Set it when anyone or anything other than you can write to the vault.

```
Calendar
Projects/Planning
```

**Change limit per sync** caps how many events one sync may create, update, and delete, 200 by
default. A sync that would exceed it stops without changing anything and reports the count, which
protects you from a note or script that generates events in bulk.

**Sync now** runs a full scan immediately, the same as the **Sync now** command in the command
palette. This is the only path that can approve a plan waiting for review.

The tab then ends with two reference sections rather than settings: **Event syntax** summarizes
[Event syntax](event-syntax.md) across a few rows, and **Trust model** restates who can change your
calendar, covered in [Security and privacy](security-and-privacy.md#trust-model).

## Where settings live

Plain settings sit in `<vault>/.obsidian/plugins/gcal-sync/data.json`, including the vault ID that
marks the events belonging to this vault. Credentials and the refresh token are kept in Obsidian's
secret storage, outside the vault.

The vault ID is a hash of the vault name, so a vault opened where that `data.json` is missing finds
its events instead of duplicating them. An ID already stored is left alone. Vaults with different
names stay separate on one calendar, so renaming a vault leaves its old events behind: sync once
from the old name first, or delete them in Google Calendar.

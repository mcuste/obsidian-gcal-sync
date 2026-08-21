# Security and privacy

## What leaves your device

Only what is needed to build the event on Google Calendar:

- The event title, which is the text before the directive, or the note name.
- Start time, end time, and the time zone they are read in.
- The repeat rule, if there is one.
- A SHA-256 hash of the vault ID and the note path with locator, used to recognize the event later,
  and the same hash re-encoded as the event's Google ID.
- The vault ID, a SHA-256 hash of the vault name.

Note paths, folder names, tags, and the rest of your note content are never uploaded. Titles go up
exactly as written, so keep anything sensitive out of the text before a directive.

Google is the only host contacted, and there is no telemetry and no third-party server. The
[network use table in the README](../README.md#network-use) lists each host and why.

## Credentials

You supply your own Google Cloud OAuth client, so the plugin has no shared or bundled credentials
and no server of its own.

Sign-in uses the authorization code flow with PKCE. While it runs, the plugin listens on a random
loopback port on `127.0.0.1` for Google's redirect, checks the `state` value, and closes the server
as soon as the code arrives, you cancel, you leave the settings tab, or 2 minutes pass.

The client ID, client secret, and refresh token live in Obsidian's secret storage, not in your vault
and not in `data.json`. Access tokens are requested per sync and kept in memory only.

## Scopes

| Scope | Used for |
| --- | --- |
| `calendar.events` | Create, update, and delete events on the selected calendar. |
| `calendar.calendarlist.readonly` | Show the list of calendars you can write to. |
| `calendar.app.created` | Create a calendar from the settings tab. |

The plugin cannot read your email, files, or contacts.

## Trust model

Any note in a synced folder can create, change, or delete events on the selected calendar, using your
Google authorization. Treat write access to those folders as write access to the calendar.

The plugin writes to a note only when you press Apply in the date picker, and then only inside the
declaration you opened. Turn **Pick dates from a declaration** off to remove that path entirely.

If other people, synced devices, or automation can write to the vault, set **Synced folders** to the
folders you control. Sync to a dedicated calendar rather than your main one, and keep **Change limit
per sync** low enough that a bulk change stops for review. The other guard rails are in
[How sync works](how-sync-works.md#guard-rails).

## Revoking access

**Settings → Google Calendar Sync → Disconnect and revoke** clears the token from the vault and
revokes it with Google. The local token is cleared first, so a failed revocation still leaves the
vault disconnected.

To confirm it is gone, or to clean up after uninstalling the plugin, remove the client at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Reporting a vulnerability

Open a [security advisory](https://github.com/mcuste/obsidian-gcal-sync/security/advisories/new)
rather than a public issue.

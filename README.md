# Google Calendar Sync for Obsidian

Write events in your notes, get them on your Google Calendar.

Add `gcal:2026-08-18T14:00/PT1H` to a line, and the plugin creates that event on the calendar you
selected. Edit the line and the event changes. Delete the line and the event is removed. Nothing is
written back into your notes.

```markdown
Design review `gcal:2026-08-18T14:00/PT1H`
Standup `gcal:2026-08-18T09:15/PT15M gcal-repeat:weekdays`
Conference `gcal:2026-09-14/P3D`
Coffee with Sam `gcal:16:00/PT30M`
```

A date is an all-day event, a timestamp is a timed one, and a time on its own means today. Times
are read in your time zone, or you can pin an exact instant with `Z` or an offset.

Sync goes one way, from vault to calendar. The plugin only ever touches events it created for this
vault, so events you add in Google Calendar are left alone.

**Documentation:** [Getting started](docs/getting-started.md) ·
[Event syntax](docs/event-syntax.md) · [Settings](docs/settings.md) ·
[How sync works](docs/how-sync-works.md) · [Security and privacy](docs/security-and-privacy.md) ·
[Troubleshooting](docs/troubleshooting.md) · [Publishing](docs/publishing.md)

## Requirements

- Obsidian 1.11.5 or later, on desktop. The plugin is desktop only because it runs a local
  callback server during Google sign-in.
- A Google account.
- **Your own Google Cloud OAuth client.** The plugin ships no shared credentials, so before the
  first sync you create a Desktop OAuth client in the Google Cloud console and paste its client ID
  into settings. It takes a few minutes and is the one real setup cost.
  [Getting started](docs/getting-started.md) walks through it step by step.

  In exchange, nothing is proxied through anyone else's project: your calendar access is a grant
  from you to an app you created, visible and revocable at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Network use

The plugin contacts Google, and nothing else. There is no telemetry and no third-party server.

| Host | Why |
| --- | --- |
| `accounts.google.com` | Sign-in during authorization. |
| `oauth2.googleapis.com` | Exchange, refresh, and revoke your token. |
| `www.googleapis.com` | Read and write events on the Google Calendar API. |

Event titles, times, and recurrence rules are uploaded. Note paths and folder names are hashed
before they are sent, and the rest of your note content never leaves the device. See
[Security and privacy](docs/security-and-privacy.md).

## Install

The plugin is not in the community directory yet.

**From a release:** download `main.js` and `manifest.json` from the
[latest release](https://github.com/mcuste/obsidian-gcal-sync/releases), put them in
`<vault>/.obsidian/plugins/gcal-sync/`, then enable the plugin in
**Settings → Community plugins**.

**From source:**

```bash
git clone https://github.com/mcuste/obsidian-gcal-sync
cd obsidian-gcal-sync
pnpm install
pnpm build
```

Copy `main.js` and `manifest.json` into the plugin folder above.

## Quick start

1. Create a Google Cloud OAuth client of type **Desktop app** and enable the Google Calendar API.
   See [Getting started](docs/getting-started.md).
2. In **Settings → Google Calendar Sync**, store the client ID as an Obsidian secret and click
   **Authorize**.
3. Pick a calendar, or create a new one so synced events stay separate from the rest of your
   calendar.
4. Add `gcal:2026-08-18T14:00/PT1H` to a note and run the **Sync now** command.

## Safety

Any note in a synced folder can create and delete events using your Google authorization, so the
plugin holds back changes that look unintended:

- Syncs that delete 5 or more events, or change 25 or more, wait for your approval in a dialog.
- A sync above the change limit (200 by default) is refused outright.
- If a note cannot be parsed, its last synced events are kept and deletions are held back.
- **Synced folders** restricts event declarations to folders you choose.

Details in [How sync works](docs/how-sync-works.md).

## Development

```bash
pnpm install
pnpm dev     # rebuild main.js on change
pnpm test    # unit tests
pnpm check   # lint, tests, dead code, audit, build
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).

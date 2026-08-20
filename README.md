# Google Calendar Sync for Obsidian

[![CI](https://github.com/mcuste/obsidian-gcal-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/mcuste/obsidian-gcal-sync/actions/workflows/ci.yml)

An [Obsidian](https://obsidian.md) plugin that turns lines in your notes into Google Calendar
events. Add `` `gcal:2026-08-18T14:00/PT1H` `` to a line and that line becomes an event on the
calendar you picked. Edit the line and the event changes. Delete the line and the event goes away.
Nothing is ever written back into your notes.

![A note with four event declarations, three marked as synced and one still pending](docs/images/note-live-preview.png)

The marker after each declaration says where it stands: a green tick means the event is on your
calendar, grey means the sync has not caught up yet.

## Why

Planning already happens in your notes, next to the task the meeting is about. Retyping it into a
calendar is the tedious part. A plugin that syncs both ways solves that but turns your notes into a
mirror of your calendar and edits them behind your back.

So this one goes in a single direction. Your notes are the source of truth, every sync makes the
calendar match them, and your notes are never modified. It also touches nothing but the events it
created for this vault, so events you keep in Google Calendar are left alone even on the same
calendar.

## Requirements

- Obsidian 1.13.0 or newer, on desktop. Desktop only, because signing in to Google needs a local
  callback server.
- A Google account.
- **Your own Google Cloud OAuth client.** The plugin ships no credentials of its own, so before the
  first sync you create a Desktop OAuth client in the Google Cloud console and paste its client ID
  into settings. It takes a few minutes and is the one real setup cost.

  In exchange, nothing is proxied through anyone else's project. Your calendar access is a grant
  from you to an app you created, which you can inspect and revoke at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
  [Setup](docs/setup.md) walks through it step by step.

## Install

In Obsidian, go to **Settings → Community plugins → Browse**, search for **Google Calendar Sync**,
then install and enable it.

To pin a specific version instead, download `main.js`, `manifest.json`, and `styles.css` from a
[release](https://github.com/mcuste/obsidian-gcal-sync/releases) into
`<vault>/.obsidian/plugins/gcal-sync/`. Building from source is covered in
[Development](docs/development.md).

## Quick start

1. Create a Google Cloud OAuth client of type **Desktop app** and enable the Google Calendar API.
   See [Setup](docs/setup.md).
2. In **Settings → Google Calendar Sync**, store the client ID in an Obsidian secret and click
   **Authorize**.
3. Under **Calendar**, click **Create calendar** to make a dedicated one, so synced events stay
   apart from the rest of your calendar.
4. Add `` `gcal:2026-08-18T14:00/PT1H` `` to a line in any note and save. The sync runs about a
   second later.

## Writing events

A declaration is `gcal:<start>[/<duration>]` inside backticks. The text in front of it becomes the
event title.

| You write | You get |
| --- | --- |
| ``Design review `gcal:2026-08-18T14:00/PT1H` `` | One hour at 14:00 on 18 August |
| ``Offsite `gcal:2026-09-14/P3D` `` | A three day all-day event |
| ``Coffee with Sam `gcal:16:00/PT30M` `` | Half an hour at 16:00 today |
| ``Standup `gcal:09:15/PT15M gcal-repeat:weekdays` `` | 15 minutes every weekday at 09:15 |
| ``Take medication `gcal-repeat:daily` `` | An all-day event repeating every day, beginning today |

A date on its own is an all-day event, a timestamp is a timed one, and a time on its own means
today. Times are read in your time zone unless you add `Z` or a UTC offset. Events can also be
declared in a note's properties, for when the note itself is the event.

Backticks are required, and only a code span holding nothing but directives counts. That is how a
note can write about the syntax without declaring events.

Everything you can write is in [Event syntax](docs/event-syntax.md).

## Safety

Any note in a synced folder can create and delete events using your Google authorization, so the
plugin holds back changes that look unintended.

![The review dialog, reporting a sync that would create 3, update 2, and delete 7 events](docs/images/review-changes.png)

- A sync that deletes 5 or more events, or changes 25 or more, waits for your approval.
- A sync above the change limit, 200 events by default, is refused outright.
- If a note cannot be parsed, its last synced events are kept and its deletions are held back.
- **Synced folders** restricts declarations to folders you choose.

[How sync works](docs/how-sync-works.md) covers each guard rail, and
[Security and privacy](docs/security-and-privacy.md) the trust model behind them.

## Network use

The plugin contacts Google, and nothing else. There is no telemetry and no third-party server.

| Host | Why |
| --- | --- |
| `accounts.google.com` | Sign-in during authorization. |
| `oauth2.googleapis.com` | Exchange, refresh, and revoke your token. |
| `www.googleapis.com` | Read and write events on the Google Calendar API. |

Event titles, times, and recurrence rules are uploaded. Note paths and folder names are hashed
before they are sent, and nothing else in your notes leaves the device.

## Documentation

- [Setup](docs/setup.md)
- [Event syntax](docs/event-syntax.md)
- [Settings](docs/settings.md)
- [How sync works](docs/how-sync-works.md)
- [Security and privacy](docs/security-and-privacy.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development and release](docs/development.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)

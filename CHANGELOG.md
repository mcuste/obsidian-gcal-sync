# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-20

### Added

- Standalone inline recurrence declarations, such as `` `gcal-repeat:daily` ``, create an all-day
  event beginning today. `everyday` is accepted as an alias for `daily`.

## [0.2.0] - 2026-08-20

### Changed

- The settings tab is built with Obsidian's declarative settings API, so its settings are found by
  Obsidian's settings search. The event syntax and trust model text is split into named rows.
- An unrecognized event time zone, or an interval or change limit below 1, is rejected with a
  message under the setting instead of being ignored.
- `minAppVersion` is now 1.13.0, the first Obsidian version with the declarative settings API.
- OAuth authorization deadlines use the active window's timers, so sign-in also works from a
  popout window.
- Status markers and destructive actions use Obsidian's current UI helpers and button styling.

## [0.1.0] - 2026-08-19

### Added

- One-way sync from vault notes to Google Calendar. Notes are the source of truth, each sync makes
  the calendar match them, nothing is written back into a note, and only events the plugin created
  for this vault are ever touched.
- Inline declarations in backticks, `` `gcal:2026-08-18T14:00/PT1H` ``, titled by the text in front
  of them. Only a code span holding nothing but directives counts, so a note can describe the
  syntax without declaring events.
- Note-property declarations, as a single value or a list of `when`, `title`, and `repeat` maps,
  with a note-level `gcal-repeat` that every entry inherits.
- Starts as a date for an all-day event, a local timestamp read in the event time zone, a bare time
  meaning today, or an exact instant carrying `Z` or a UTC offset. A bare time is pinned to the
  date its event already has on Google, so it does not walk forward day after day.
- Recurrence by name (`daily`, `weekdays`, `quarterly`), weekday lists and ranges,
  `every-N-day/week/month/year` intervals, or a raw RRULE.
- Status markers on each declaration in Live Preview and Reading view: synced, pending, blocked by
  a sibling, and error with the reason on hover.
- Event identity from a declaration's position, hashed with the vault ID before upload so note and
  folder names stay on the device. A declaration that only moved is rekeyed in place rather than
  deleted and recreated, so guest replies and reminders survive.
- Guard rails against a note changing the calendar unintentionally: approval for large or
  destructive plans, a per-sync change limit, deletions held back while any note is unreadable, and
  a synced-folder allowlist.
- Google sign-in with the authorization code flow and PKCE over a loopback callback, storing the
  client credentials and refresh token in Obsidian's secret storage. Calendar selection and
  creation from the settings tab, and a disconnect action that revokes the refresh token with
  Google.
- Setup, event syntax, settings, sync, security, troubleshooting, and development documentation
  under `docs/`.

First public release. The plugin ships no Google credentials, so each user supplies their own
Google Cloud OAuth client.

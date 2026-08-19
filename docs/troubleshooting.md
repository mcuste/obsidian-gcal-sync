# Troubleshooting

## Authorization

**"Google did not return a refresh token"** means Google still has an active grant for this client.
Remove it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then
authorize again.

**"Google OAuth token refresh failed (400): invalid_grant"** usually means the refresh token
expired or was revoked. An External OAuth client left in **Testing** expires refresh tokens after
7 days. Set the consent screen to **In production** to stop this, then click **Authorize again**.

**"Google authorization timed out"** means the browser flow was not completed within 2 minutes.
Click **Authorize** again.

**"Google authorization was cancelled"** means you pressed the button again during sign-in, or left
the settings tab. Nothing was saved.

**"Google returned an invalid OAuth callback"** means the redirect did not match the request. Close
any stale consent tabs and start over.

**"Could not open the local OAuth callback"** means the plugin could not listen on a loopback port.
Check whether a firewall or security tool blocks Obsidian from binding local ports.

**"Authorize Google again to grant calendar selection and creation access"** appears after an
upgrade added scopes. Click **Authorize again**.

**"The configured OAuth client ID secret is missing"** means the selected Obsidian secret is empty
or was deleted. Re-select or recreate it in settings.

## Events are not created

Work through these in order:

1. The note is inside **Synced folders**, or that setting is empty.
2. The directive is wrapped in backticks and those backticks hold nothing but directives. A
   directive in plain text, in a fenced code block, or in an HTML comment is ignored.
3. A notice did not report a parse problem for that note. One invalid declaration skips the whole
   note.
4. A calendar is selected under **Calendar**, and it is the one you are looking at in Google.
5. Run **Sync now** to force a full scan and see the result in a notice.

## Notices about declarations

**"Some event declarations were skipped"** lists the note, the location, and the reason. Common
reasons:

| Message | Fix |
| --- | --- |
| Expected a date (2026-08-18), a time (14:00), a local timestamp (2026-08-18T14:00), or one with Z or a UTC offset | The start is not one of the accepted forms. A time zone on its own, such as `+02:00`, is not a start. |
| Invalid time of day | The hours or minutes are out of range, for example `25:00`. |
| Invalid calendar date | The date does not exist, for example `2026-02-30`. |
| Invalid duration; use days, hours, and minutes such as PT90M | Use `PT30M`, `PT1H30M`, `P1DT2H`. Seconds are not accepted. |
| All-day durations must use PnD, such as P1D | An all-day event cannot have hours. |
| Event duration must be greater than zero | Use a positive duration. |
| Invalid recurrence | See the rules in [Event syntax](event-syntax.md#recurrence). |
| Repeat interval must be a whole number of units | `every-2-weeks` works, `every-1.5-weeks` does not. |
| Invalid recurring weekday range | Ranges run forward from Monday to Sunday, so `friday-monday` is rejected. |
| A gcal entry needs when | A note-property entry map must have a `when` field. |
| Unknown gcal field … | A note-property entry only takes `when`, `title`, and `repeat`. Check for a typo. |
| Unknown directive gcal-… | An inline declaration only takes `gcal` and `gcal-repeat`. Check for a typo. |
| gcal-repeat is no longer matched to gcal by position | Replace the parallel lists with a list of maps. See [Event syntax](event-syntax.md#note-properties). |
| Another note already declares this event key | Two notes produce the same identity. Move one declaration. |
| A note can declare at most 100 calendar events | Split the note. |

## Sync stopped or is waiting

**"Google Calendar sync needs review"** means the plan deletes 5 or more events or changes 25 or
more, and a background sync cannot ask you. Run **Sync now** to see the counts and
approve or cancel.

**"...changes exceed the per-sync limit of 200"** means nothing was applied. Check which notes
produced that many events. Raise **Change limit per sync** if the change is intended.

**"N deletion(s) held back until every note parses"** means a note could not be read, so deletions
were skipped for safety. Fix the reported note and sync again.

## Duplicate or recreated events

**An event was recreated instead of moved.** Moving a line, reordering declarations, and renaming a
note are all safe on their own. The two cases that recreate an event are a declaration that moves
**and** changes content in the same sync, and two identical events, where the match is ambiguous.
See [How an event keeps its identity](event-syntax.md#how-an-event-keeps-its-identity).

**An event written as a bare time reappeared today.** A time with no date keeps the date of the
event on Google. Delete that event and there is no date left to read, so the next sync recreates it
at today's date. Write the date out if it should stay on a fixed day.

## Other

**Nothing works on mobile.** The plugin is desktop only, because sign-in needs a local callback
server.

**"Could not load calendars"** on the calendar dropdown means the API call failed. Retry, and if it
persists, confirm the Google Calendar API is still enabled on your Cloud project and authorize
again.

**Events remain after uninstalling.** They are ordinary Google Calendar events. Delete them in
Google, or delete the declarations and sync before uninstalling.

Still stuck? Open an issue at
[github.com/mcuste/obsidian-gcal-sync/issues](https://github.com/mcuste/obsidian-gcal-sync/issues)
with the notice text and a minimal example of the declaration.

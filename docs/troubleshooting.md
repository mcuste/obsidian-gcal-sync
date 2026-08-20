# Troubleshooting

## Authorization

| Notice | What to do |
| --- | --- |
| "Google did not return a refresh token" | Google still has an active grant for this client. Remove it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then authorize again. |
| "Google OAuth token refresh failed (400): invalid_grant" | The refresh token expired or was revoked. An External client left in **Testing** expires them after 7 days, so set the consent screen to **In production**, then click **Authorize again**. |
| "Google authorization timed out" | The browser flow was not finished within 2 minutes. Click **Authorize** again. |
| "Google authorization was cancelled" | You pressed the button again during sign-in, or left the settings tab. Nothing was saved. |
| "Google returned an invalid OAuth callback" | The redirect did not match the request. Close any stale consent tabs and start over. |
| "Could not open the local OAuth callback" | The plugin could not listen on a loopback port. Check whether a firewall or security tool stops Obsidian from opening local ports. |
| "Authorize Google again to grant calendar selection and creation access" | An upgrade added scopes. Click **Authorize again**. |
| "OAuth client ID secret is empty or missing", or the same for the client secret | The Obsidian secret is empty or was deleted. Re-select or recreate it in settings. |

## Events are not created

Check these in order:

1. The note is inside **Synced folders**, or that setting is empty.
2. The directive is inside backticks, and those backticks hold nothing but directives. A directive in
   plain text, in a fenced code block, or in an HTML comment is ignored.
3. No notice reported a problem with that note. One bad declaration skips the whole note.
4. A calendar is selected under **Calendar**, and it is the one you are looking at in Google.
5. Run **Sync now** to force a full sync and read the result in the notice.

## Notices about declarations

**"Some event declarations were skipped"** names the note, the place, and the reason. Common ones:

| Message | Fix |
| --- | --- |
| Expected a date (2026-08-18), a time (14:00), a local timestamp (2026-08-18T14:00), or one with Z or a UTC offset | The start is not one of the accepted forms. An offset on its own, such as `+02:00`, is not a start. |
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
| gcal-repeat is no longer matched to gcal by position | Replace the parallel lists with a list of maps. See [Event syntax](event-syntax.md#note-level-gcal-repeat). |
| Another note already declares this event key | Two notes produce the same identity. Move one declaration. |
| A note can declare at most 100 calendar events | Split the note. |

## Sync stopped or is waiting

| Notice | What it means |
| --- | --- |
| "Google Calendar sync needs review" | The sync deletes 5 or more events, or changes 25 or more, and a background sync cannot ask you. Run **Sync now** to see the counts and approve or cancel. |
| "…changes exceed the per-sync limit of 200" | Nothing was applied. Check which notes made that many events, and raise **Change limit per sync** if the change is intended. |
| "N deletion(s) held back until every note parses" | A note could not be read, so deletions were skipped to be safe. Fix the note named in the notice and sync again. |

## Duplicate or recreated events

**Every event exists twice.** Two devices synced the same vault under different vault IDs, which
happened when one of them stored a random ID from an earlier release. Every device now takes the ID
from the vault name, so new duplicates cannot appear, and each declaration also reserves one Google
event ID, which stops two devices creating the same event at once. Copies stamped with the old
random ID are invisible to the plugin: delete them in Google Calendar. Copies that both carry the
current ID are removed by the next sync, keeping the one Google created first; if that passes the
change limit, the notice says by how much, so raise **Change limit per sync** and sync again.

The name of the vault folder is what the ID comes from, so give the folder the same name on every
device.

**An event was recreated instead of moved.** Moving a line, reordering declarations, and renaming a
note are all safe on their own. The two cases that recreate an event are a declaration that moves
**and** changes in the same sync, and two identical events, where the match is ambiguous. See
[How an event keeps its identity](how-sync-works.md#how-an-event-keeps-its-identity).

**An event written as a bare time came back today.** A time with no date keeps the date of the event
on Google. Delete that event and there is no date left to read, so the next sync makes it again at
today's date. Write the date out if it should stay on a fixed day.

## Other

| Problem | Cause |
| --- | --- |
| Nothing works on mobile | The plugin is desktop only, because sign-in needs a local callback server. |
| "Could not load calendars" | The API call failed. Retry, and if it keeps failing, check that the Google Calendar API is still enabled on your Cloud project and authorize again. |
| Markers have no color | `styles.css` is missing from the plugin folder, which only happens after installing by hand. Copy it in next to `main.js` and `manifest.json`. |
| Events remain after uninstalling | They are ordinary Google Calendar events. Delete them in Google, or delete the declarations and sync before uninstalling. |

Still stuck? Open an issue at
[github.com/mcuste/obsidian-gcal-sync/issues](https://github.com/mcuste/obsidian-gcal-sync/issues)
with the notice text and a small example of the declaration.

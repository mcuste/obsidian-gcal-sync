# How sync works

Sync goes one way. Your notes are the source of truth, and each sync makes the calendar match them.

```
your notes ──> plugin compares ──> Google Calendar
                                   ├─ event missing    -> create
                                   ├─ event different  -> update
                                   └─ line gone        -> delete
```

## When it runs

| Trigger | Scope |
| --- | --- |
| Obsidian finishes loading | Whole vault |
| Every 15 minutes, configurable | Whole vault |
| A note is changed, created, renamed, or deleted | That note's events, about a second later |
| **Sync now**, or **Sync** in settings | Whole vault, and can approve waiting changes |

Only one sync runs at a time. The rest wait in line.

## What the plugin can touch

Every event the plugin creates carries three hidden markers: a flag, this vault's ID, and a hashed key
for the declaration it came from. Each sync asks Google only for events carrying this vault's ID, then
checks the markers again before planning anything. Events you made in Google Calendar carry none of
these, so the plugin cannot see them, and neither can it see events from another vault on the same
calendar.

## How an event keeps its identity

You never write an id. Each declaration gets a key of `<note path>::<locator>`, where the locator is
the line number or the property index, and what goes to Google is a SHA-256 hash of that key and the
vault ID. Lines move, so a changed key looks at first like one event disappearing and another
appearing. Before acting on that, the plugin compares title, start, end, and repeat rule; if exactly
one old event matches, its key is patched instead of deleting and recreating the event, so guest
replies and reminders survive.

| You do this | What happens |
| --- | --- |
| Insert a paragraph above a declaration | key patched in place |
| Reorder declarations | key patched in place |
| Rename or move the note | key patched in place |
| Change only the title or time | event patched, the key never moved |
| Move a declaration **and** change it in one edit | recreated, nothing left to match on |
| Two identical events, one moves | recreated, the match is ambiguous |

The last two are the real limits, and both are rare, because a sync runs about a second after you stop
typing, so an edit and a move seldom land in the same sync.

## What counts as a change

An event is updated when its title, start, end, or repeat rule differ. Times are compared as exact
moments, so the same time written a different way is not a change. Updates only patch those four
fields, so guests, descriptions, colors, and reminders you added in Google survive. One case reads
from Google instead of overwriting it: a start with a time but no date, such as `gcal:09:00`, covered
in [Event syntax](event-syntax.md#a-bare-time-means-today-once).

## Guard rails

Any note in a synced folder can change your calendar through your Google authorization, so a sync
stops for review when it looks unintended.

- **Approval.** A sync that deletes 5 or more events, or changes 25 or more, needs your approval. An
  interactive sync opens a dialog with the counts. A background sync cannot ask, so it changes nothing
  and shows a notice once, telling you to run **Sync now** to review it.
- **Change limit.** A sync larger than the limit, 200 events by default, is refused outright, with a
  notice giving the count. Nothing is applied and there is no dialog. Fix the notes, or raise the
  limit in settings if the change is expected.
- **Notes that cannot be read.** If a note has never been read successfully, the plugin cannot know
  which events belong to it, so no deletions run in that sync. Creates and updates still apply, and
  the notice counts the deletions held back. A note that used to work keeps its last good events, so
  one broken line cannot strand every other note.
- **Duplicate keys.** If two notes produce the same key, the first one scanned keeps it and the other
  is skipped, so a note cannot take over another note's event.
- **Synced folders.** Limits declarations to folders you control when the vault is shared or written
  to by automation.

## Removing everything

Delete the declarations and sync, and the events go away. To disconnect without deleting them, use
**Disconnect and revoke** in settings and leave the notes alone. Uninstalling the plugin leaves
existing events on the calendar untouched.

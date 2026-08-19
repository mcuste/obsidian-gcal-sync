# How sync works

Sync goes one way. Your notes are the source of truth, and each sync makes the calendar match them.

```
notes ──parse──> desired events ──compare──> Google Calendar
                                   │
                                   ├─ missing             -> create
                                   ├─ different           -> update
                                   └─ no longer in a note -> delete
```

## When it runs

| Trigger | Scope |
| --- | --- |
| Obsidian finishes loading | Full vault |
| Every 15 minutes, configurable | Full vault |
| A note is changed, created, renamed, or deleted | Only that note's events, about a second later |
| **Sync now**, or **Sync** in settings | Full vault, and can approve pending changes |

Only one sync runs at a time. The rest queue.

## What the plugin can touch

Every event the plugin creates carries three private markers: a flag, this vault's random ID, and a
hashed key identifying the declaration it came from. Each sync lists only events carrying this
vault's ID, then re-checks both markers before planning anything.

Events you create in Google Calendar carry none of these, so they are invisible to the plugin. So
are events synced from a different vault, even on the same calendar.

## How an event keeps its identity

You never write an id. Each declaration gets a key of `<note path>::<locator>`, where the locator
is the line number or the property index. What reaches Google is a SHA-256 hash of that key and the
vault ID, so paths and folder names are not uploaded.

Positions move, so anything that changes the key first looks like one event disappearing and
another appearing. Before acting on that, the plan checks whether the pair is really one event that
moved, by comparing title, start, end, and recurrence. If exactly one stale event matches, it is
rekeyed with a patch instead of being deleted and recreated, so guest replies and reminders
survive.

| You do this | What happens |
| --- | --- |
| Insert a paragraph above a declaration | rekeyed in place |
| Reorder declarations | rekeyed in place |
| Rename or move the note | rekeyed in place |
| Change only the title or time | patched, the key never moved |
| Move a declaration **and** change its content in one edit | recreated, nothing is left to match on |
| Two identical events, one moves | recreated, the match is ambiguous |

The last two are the honest limits. Both are rare, because a sync runs about a second after you
stop typing, so an edit and a move seldom land in the same sync.

## What counts as a change

An event is updated when its title, start, end, or recurrence differ. Times are compared as
instants, so an equivalent timestamp written a different way is not a change. Updates are sent as a
patch of those four fields only, so guests, descriptions, colors, and reminders you added in Google
survive.

One case reads back from Google rather than overwriting it: a start that gives a time but no date,
such as `gcal:09:00`, covered in [Event syntax](event-syntax.md#a-bare-time-means-today-once).

## Guard rails

Any note in a synced folder can change your calendar through your Google authorization, so a sync
stops for review when it looks unintended.

**Approval.** A plan that deletes 5 or more events, or changes 25 or more, needs your approval. An
interactive sync opens a dialog with the counts. A background sync cannot prompt, so it changes
nothing and shows a notice once, telling you to run **Sync now** to review it.

**Change limit.** A plan larger than the limit, 200 events by default, is refused entirely, with a
notice naming the count. Nothing is applied and there is no approval dialog. Fix the notes, or
raise the limit in settings if the change is expected.

**Unreadable notes.** If a note has never parsed successfully, the plugin cannot know which events
it owns, so no deletions run in that sync. Creates and updates still apply, and the notice counts
the deletions held back. A note that used to parse keeps its last good events instead, so one
broken line cannot strand every other note.

**Duplicate keys.** If two notes produce the same key, the first one scanned keeps it and the other
is skipped, so a note cannot take over another note's event.

**Synced folders.** Restrict declarations to folders you control when the vault is shared or
written to by automation.

## Removing everything

Deleting the declarations and syncing removes the events. To disconnect without deleting them, use
**Disconnect and revoke** in settings and leave the notes alone. Uninstalling the plugin leaves
existing events on the calendar untouched.

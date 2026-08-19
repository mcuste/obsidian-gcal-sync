# How sync works

Sync is one way. Your notes are the source of truth, and each sync makes the calendar match them.

```
notes ──parse──> desired events ──compare──> Google Calendar
                                   │
                                   ├─ missing      -> create
                                   ├─ different    -> update
                                   └─ no longer in a note -> delete
```

## When it runs

| Trigger | Scope |
| --- | --- |
| Obsidian finishes loading | Full vault |
| Every 15 minutes, configurable | Full vault |
| A note is changed, created, renamed, or deleted | Only the events on that note, about a second later |
| **Sync now**, or **Sync** in settings | Full vault, and can approve pending changes |

Only one sync runs at a time. The others queue.

## What the plugin can touch

Every event the plugin creates carries three private markers: a flag, this vault's random ID, and a
hashed key identifying the declaration it came from. Each sync lists only events carrying this
vault's ID, and re-checks both markers before planning anything.

Events you create in Google Calendar have none of these markers, so they are invisible to the
plugin. So are events synced from a different vault, even on the same calendar.

## Matching notes to events

Each declaration gets a key of `<note path>::<locator>`, where the locator is the line number or the
property index. The key sent to Google is a SHA-256 hash of that key and the vault ID, so paths and
folder names are not uploaded.

Anything that changes the key, such as renaming the note or moving a line, first looks like one
event disappearing and another appearing. Before acting on that, the plan checks whether the pair is
really one event that moved, by comparing title, start, end, and recurrence. If exactly one stale
event matches, it is rekeyed with a patch instead of being deleted and recreated, so guest replies
and reminders survive. An ambiguous match is never claimed.

An event is updated when its title, start, end, or recurrence differ. Times are compared as
instants, so an equivalent timestamp written a different way is not a change. Updates are sent as a
patch of those fields only, so guests, descriptions, colors, and reminders you added in Google
survive.

One case reads back from Google rather than overwriting it. When a note gives a time but no date,
such as `gcal:09:00`, the date is filled in from today only the first time. After that the event
keeps the date it already has, so it does not walk forward every day. The time of day and duration
still come from the note, so editing the time moves the event within its original day.

## Guard rails

Any note in a synced folder can change your calendar through your Google authorization, so a sync
stops for review when it looks unintended.

**Approval.** A plan that deletes 5 or more events, or changes 25 or more, needs your approval. An
interactive sync opens a dialog with the counts. A background sync cannot prompt, so it changes
nothing and shows a notice once, telling you to run **Sync now** to review it.

**Change limit.** A plan larger than the limit (200 by default) is refused entirely, with a notice
naming the count. Nothing is applied, and there is no approval dialog. Fix the notes, or raise the
limit in settings if the change is expected.

**Unreadable notes.** If a note has never parsed successfully, the plugin cannot know which events
it owns, so no deletions run in that sync. Creates and updates still apply. The notice counts the
deletions held back. A note that used to parse keeps its last good events instead, so one broken
line cannot strand every other note.

**Duplicate keys.** If two notes produce the same key, the first one scanned keeps it and the other
is skipped, so a note cannot take over another note's event.

**Synced folders.** Restrict declarations to folders you control when the vault is shared or
written to by automation.

## Removing everything

Deleting the declarations and syncing removes the events. To disconnect without deleting them, use
**Disconnect and revoke** in settings and leave the notes alone. Uninstalling the plugin leaves
existing events on the calendar untouched.

# Event syntax

An event can be declared in two places, and the two are independent:

| Level | Where | Title comes from | Use it for |
| --- | --- | --- | --- |
| **Inline** | anywhere in the note's text, in backticks | the prose before it | events that belong to a line, a task, or a bullet |
| **Note properties** | the note's YAML frontmatter | the note name, or a `title` field | the note *being* the event, or a fixed set of events |

Both accept the same start and duration values, and the same recurrence rules. Only the wrapping
differs.

## Inline

```
<title> `gcal:<start>[/<duration>]`
```

Everything must sit inside backticks:

```markdown
# Sprint planning

- [ ] Design review `gcal:2026-08-18T14:00/PT1H`
- Retro `gcal:2026-08-21T16:00`
Offsite `gcal:2026-09-14/P3D`
Coffee with Sam `gcal:16:00/PT30M`
```

### The two inline directives

| Directive | Purpose | Required |
| --- | --- | --- |
| `gcal:<start>[/<duration>]` | Declares the event | yes |
| `gcal-repeat:<rule>` | Makes it recur | no |

There are only these two. Any other `gcal-…` token is reported as an unknown directive, so a typo
such as `gcal-repat:` is caught instead of quietly producing no recurrence.

They can share one code span or sit in separate ones on the same line. These are equivalent:

```markdown
Standup `gcal:09:00 gcal-repeat:weekdays`
Standup `gcal:09:00` `gcal-repeat:weekdays`
```

### Where the title comes from

The prose since the start of the line, or since the previous declaration on that line. Leading
bullets, checkboxes, numbers, and heading markers are stripped, and directive text never leaks in.
If nothing is left, the note name is used.

### Several declarations on one line

Each takes the prose before it as its title, and the repeat that follows it as its own:

```markdown
Standup `gcal:09:00 gcal-repeat:daily` Retro `gcal:11:00 gcal-repeat:weekly`
```

That is two events titled "Standup" and "Retro". A repeat written once on the line applies to every
declaration on it.

### Why backticks are required

Obsidian ends a tag at the first `:`, so a tag-shaped `#gcal:2026-08-18T14:00` would render as a
stray `#gcal` pill trailed by loose text, and would add `#gcal` to your tag pane for every note.
Backticks render the whole thing as one clean token and keep your tags to the ones you meant.

A code span counts as a declaration only when it holds **nothing but directives**. Everything else
is inert, so you can write about the syntax without creating events:

| Written | Result |
| --- | --- |
| `` `gcal:2026-08-18` `` | declares an event |
| `` `Standup gcal:not-a-date` `` | inert, prose is mixed in |
| a plain `gcal:2026-08-18` in a sentence | inert, no backticks |
| a directive in a fenced block or an HTML comment | inert |

## Note properties

The simplest form is one value. The note name becomes the title:

```yaml
---
gcal: 2026-08-18T14:00/PT1H
---
```

For several events, or to set a title, use a list of maps:

```yaml
---
gcal:
  - when: 2026-08-18T09:15/PT15M
    title: Standup
    repeat: weekdays
  - when: 2026-08-20/P1D
---
```

### Entry fields

| Field | Meaning | Required |
| --- | --- | --- |
| `when` | Start and optional duration, same as inline | yes |
| `title` | Event title. Defaults to the note name | no |
| `repeat` | Recurrence rule, same vocabulary as `gcal-repeat` | no |

A single entry may be a lone map rather than a list:

```yaml
---
gcal:
  when: 2026-08-18
  title: Launch day
---
```

### Note-level gcal-repeat

`gcal-repeat` as a plain value applies to **every** entry, and an entry's own `repeat` overrides it:

```yaml
---
gcal:
  - when: 2026-08-18
  - when: 2026-08-25
gcal-repeat: weekly
---
```

### Mistakes are reported, not ignored

An unknown field or a missing `when` produces a notice naming the note and the entry, so a typo
cannot silently drop an event. The only fields are `when`, `title`, and `repeat`.

`gcal-repeat` **lists** are no longer accepted. They used to be matched to `gcal` by position, which
meant reordering `gcal` without reordering the other lists silently swapped the events' identities,
and the form could not express a title at all. A note still using it reports:

> gcal-repeat is no longer matched to gcal by position; give each gcal entry its own repeat field

Rewrite it as a list of maps:

```yaml
# before                          # after
gcal:                             gcal:
  - 2026-10-01/P2D                  - when: 2026-10-01/P2D
  - 2026-11-01                        repeat: weekdays
gcal-repeat:                        - when: 2026-11-01
  - weekdays
  - ""
```

## Start and duration

| Form | Meaning |
| --- | --- |
| `2026-08-18` | All-day event on that date. |
| `2026-08-18/P3D` | All-day event over 3 days. |
| `2026-08-18T14:00` | Timed event at 14:00 in the event time zone, 1 hour by default. |
| `14:00` | Timed event at 14:00 today, in the event time zone. |
| `2026-08-18T14:00-04:00` | Timed event at an exact instant, 1 hour by default. |
| `2026-08-18T14:00Z/PT90M` | Timed event, 90 minutes. |
| `2026-08-18T14:00-04:00/P1DT2H` | Timed event, 1 day and 2 hours. |

Rules:

- **Times are written to the minute.** Seconds and milliseconds are not accepted in a start or in
  a duration. Google is sent the seconds its own format requires.
- A start with no `Z` and no UTC offset is read in the **Event time zone** setting. Leave that
  setting empty and it follows this device.
- Add `Z` or an offset such as `-04:00` to pin an exact instant regardless of that setting.
- A time on its own means today's date in the event time zone, fixed once. See below.
- A time zone on its own, such as `+02:00`, is not a start and is rejected. Neither is a bare time
  carrying one, such as `14:00+02:00`; write the date out to use an offset.
- All-day durations use `PnD` only, and default to `P1D`.
- Timed durations use `P#DT#H#M`, default to `PT1H`, and must be longer than zero.
- The **Event time zone** setting travels with timed events, which is what Google uses to expand
  recurring ones.

### A bare time means today, once

`Standup gcal:09:00` creates the event today at 09:00, and it stays there. Later syncs read the
date back from the event on Google instead of resolving "today" again, so the event does not walk
forward day after day. Editing the time to `gcal:10:00` retimes it on its original day.

Delete the event in Google and the next sync recreates it at today's date, because there is no
longer a date to read back. Pair a bare time with `gcal-repeat` when you want it to recur rather
than happen once.

A start with no offset keeps its wall-clock length across a daylight-saving change: `14:00/PT1H`
is 14:00 to 15:00 on both sides of the transition. Use `Z` or an offset when you need exactly
3600 seconds.

## Recurrence

Add `gcal-repeat:<rule>` after the declaration it belongs to, or use a `repeat` field in note
properties. A rule written once on a line applies to every declaration on that line.

| Rule | Result |
| --- | --- |
| `daily` | Every day. |
| `weekly` | Every week on the start day. |
| `fortnightly` | Every 2 weeks. |
| `monthly` | Every month. |
| `quarterly` | Every 3 months. |
| `yearly`, `annually` | Every year. |
| `weekdays` | Monday through Friday. |
| `monday`, `mon` | Every Monday. |
| `mon,wed,fri` | Those weekdays. |
| `monday-thursday` | That range of weekdays. |
| `every-2-weeks` | Every 2 weeks. |
| `every-10-days` | Every 10 days. |
| `every-3-months` | Every 3 months. |
| `FREQ=MONTHLY;BYMONTHDAY=1` | Used as an RRULE. |

Interval rules are `every-<n>-<unit>`, where the unit is `day`, `week`, `month`, or `year`, plural
or singular. The count may be left out (`every-week`), and `every-1-week` is just `weekly`.

An `every-` prefix is accepted throughout, so `every-weekly` and `weekly` are the same. Ranges must
run forward within Monday to Sunday. RRULEs accept a `RRULE:` prefix and require `FREQ` to be
`DAILY`, `WEEKLY`, `MONTHLY`, or `YEARLY`.

```markdown
Standup `gcal:2026-08-18T09:15/PT15M gcal-repeat:weekdays`
Rent `gcal:2026-09-01 gcal-repeat:FREQ=MONTHLY;BYMONTHDAY=1`
```

## Status markers

Each declaration carries a small calendar icon in both Live Preview and Reading view, so you can
see at a glance whether it reached Google.

| Marker | Meaning |
| --- | --- |
| Calendar with a tick | The event is on your calendar. |
| Calendar with a clock | Parsed, but not synced yet. Sync is queued, or not configured. |
| Calendar with a minus | Valid, but held back because another declaration in the same note is broken. |
| Calendar with a cross | This declaration could not be read. Hover it for the reason. |

A note syncs all or nothing, which is why one bad declaration shows a cross on itself and a minus on
its siblings rather than marking the whole note as broken.

In Live Preview the declaration text is left as written so the cursor and selection keep working
inside it; only the marker is added.

## How an event keeps its identity

You never name an event. The plugin keys each declaration by its position and stores that key,
hashed, on the Google event. Nothing about it appears in your note.

Positions move, so a sync about to delete one event and create another first checks whether they are
the same event that moved, and rekeys it in place if so. That covers the cases you would expect to
break:

| You do this | What happens |
| --- | --- |
| Insert a paragraph above an event | rekeyed in place |
| Reorder declarations | rekeyed in place |
| Rename or move the note | rekeyed in place |
| Change only the title or time | patched, the key never moved |
| Move a declaration **and** change its content in one edit | recreated, because nothing is left to match on |
| Two identical events, one moves | recreated, because the match is ambiguous |

The last two are the honest limits. Both are rare, because a sync runs about a second after you stop
typing, so an edit and a move seldom land in the same sync.

## Limits and error handling

- A note may declare at most 100 events.
- Two notes cannot claim the same identity. The first one scanned wins, and the other is skipped.
- If any declaration in a note is invalid, the whole note is skipped for that sync and its last
  synced events are kept. A notice names the note, the line, and the problem.

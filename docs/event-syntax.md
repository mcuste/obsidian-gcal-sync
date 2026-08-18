# Event syntax

An event is declared either inline in a note's text or in the note's properties. Both use the same
value format.

## Inline

```
<title> #gcal:<start>[/<duration>]
```

The title is the text on the line before the tag. Leading bullets, checkboxes, numbers, and heading
markers are stripped. Text after the tag is ignored. If nothing is left, the note name is used.

```markdown
# Sprint planning

- [ ] Design review #gcal:2026-08-18T14:00/PT1H
- Retro #gcal:2026-08-21T16:00
Offsite #gcal:2026-09-14/P3D
Coffee with Sam #gcal:16:00/PT30M
```

Tags inside inline code, fenced code blocks, and HTML comments are ignored, so you can write about
the syntax without creating events.

## Note properties

```yaml
---
gcal: 2026-08-18T14:00/PT1H
---
```

The event title is the note name. Use a list for several events, and the plugin matches
`gcal-repeat` and `gcal-id` by position:

```yaml
---
gcal:
  - 2026-08-18T09:15/PT15M
  - 2026-08-20/P1D
gcal-repeat:
  - weekdays
  - ""
gcal-id:
  - standup
  - review-day
---
```

Use `""` to skip an entry, as above, so the positions stay aligned. With exactly one `gcal` value,
a single `gcal-repeat` or `gcal-id` applies to it without a list.

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

`Standup #gcal:09:00` creates the event today at 09:00, and it stays there. Later syncs read the
date back from the event on Google instead of resolving "today" again, so the event does not walk
forward day after day. Editing the time to `#gcal:10:00` retimes it on its original day.

Delete the event in Google and the next sync recreates it at today's date, because there is no
longer a date to read back. Pair a bare time with `#gcal-repeat:` when you want it to recur rather
than happen once.

A start with no offset keeps its wall-clock length across a daylight-saving change: `14:00/PT1H`
is 14:00 to 15:00 on both sides of the transition. Use `Z` or an offset when you need exactly
3600 seconds.

## Recurrence

Add `#gcal-repeat:<rule>` anywhere on the same line, or `gcal-repeat` in the note properties. One
rule per line, applying to every event declared on it.

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
Standup #gcal:2026-08-18T09:15/PT15M #gcal-repeat:weekdays
Rent #gcal:2026-09-01 #gcal-repeat:FREQ=MONTHLY;BYMONTHDAY=1
```

## Stable IDs

By default an inline event is identified by its line number. Moving the line deletes the old event
and creates a new one, which loses guest responses and reminders set in Google.

Add `#gcal-id:<name>` to pin the identity to a name instead. Use letters, digits, `-`, and `_`. The
name only has to be unique within its note.

```markdown
Standup #gcal:2026-08-18T09:15/PT15M #gcal-repeat:weekdays #gcal-id:standup
```

The identity still includes the note path, so renaming or moving the note recreates its events.

## Limits and error handling

- A note may declare at most 100 events.
- Two notes cannot claim the same ID. The first one scanned wins, and the other is skipped.
- If any declaration in a note is invalid, the whole note is skipped for that sync and its last
  synced events are kept. A notice names the note, the line, and the problem.

## Multiple events on one line

Several `#gcal:` tags on a line each become an event, all sharing the line's title and repeat rule.
With `#gcal-id:name`, the second and later events get `name-2`, `name-3`, and so on.

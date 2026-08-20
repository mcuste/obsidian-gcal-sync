# Event syntax

An event can be declared in two places, and they work independently:

| Where | Title comes from | Use it for |
| --- | --- | --- |
| **Inline**, a code span anywhere in the note | the text before the directive | an event on a line, task, or bullet |
| **Note properties**, the YAML frontmatter | the note name, or a `title` field | the note itself being the event |

Both take the same start, duration, and repeat values. Only the wrapping differs.

## Inline

```markdown
- [ ] Design review `gcal:2026-08-18T14:00/PT1H gcal-repeat:weekdays`
      ^^^^^^^^^^^^^       ^^^^^^^^^^^^^^^^ ^^^^             ^^^^^^^^
      title               start            duration         repeat
```

Everything except the title sits inside the backticks:

```markdown
- [ ] Design review `gcal:2026-08-18T14:00/PT1H`
- Retro `gcal:2026-08-21T16:00`
Offsite `gcal:2026-09-14/P3D`
Coffee with Sam `gcal:16:00/PT30M`
```

There are only two directives: `gcal:<start>[/<duration>]` declares the event, and
`gcal-repeat:<rule>` repeats it. Only `gcal:` is required. Any other `gcal-…` token is reported as an
unknown directive, so a typo such as `gcal-repat:` is caught instead of silently doing nothing.

The two can share one code span or sit in separate ones on the same line, so
`` `gcal:09:00 gcal-repeat:weekdays` `` and `` `gcal:09:00` `gcal-repeat:weekdays` `` are the same.

`gcal-repeat` can also stand alone, as in ``- [ ] Take medication `gcal-repeat:daily` ``. That is an
all-day event starting today, and after the first sync the start date stays put instead of moving
forward each day.

### Titles, and several events on one line

The title is the text from the start of the line, or from the previous directive on that line.
Bullets, checkboxes, numbers, and heading marks are removed, and directive text is never included. If
nothing is left, the note name is used. So this line makes two events, "Standup" and "Retro":

```markdown
Standup `gcal:09:00 gcal-repeat:daily` Retro `gcal:11:00 gcal-repeat:weekly`
```

A repeat written once on a line applies to every event on that line.

### Why backticks are required

Obsidian ends a tag at the first `:`, so a tag-shaped `#gcal:2026-08-18T14:00` would show up as a
stray `#gcal` pill with loose text after it, and would add `#gcal` to your tag pane for every note.
Backticks keep the whole thing as one token and leave your tags alone.

A code span counts as an event only when it holds **nothing but directives**, so you can write about
the syntax without creating events:

| Written | Result |
| --- | --- |
| `` `gcal:2026-08-18` `` | declares an event |
| `` `Standup gcal:not-a-date` `` | ignored, text is mixed in |
| a plain `gcal:2026-08-18` in a sentence | ignored, no backticks |
| a directive in a fenced block or an HTML comment | ignored |

## Note properties

One value uses the note name as the title. A list of maps sets titles and holds several events:

```yaml
---
gcal: 2026-08-18T14:00/PT1H
---
```

```yaml
---
gcal:
  - when: 2026-08-18T09:15/PT15M
    title: Standup
    repeat: weekdays
  - when: 2026-08-20/P1D
---
```

An entry takes three fields and no others: `when` for the start and optional duration, written the
same as inline and required, `title` which defaults to the note name, and `repeat` which takes the
same rules as `gcal-repeat`. An unknown field or a missing `when` is reported by name, so a typo
cannot drop an event without telling you. A single entry may be a lone map instead of a list.

### Note-level gcal-repeat

`gcal-repeat` as a plain value applies to **every** entry, and an entry's own `repeat` wins over it:

```yaml
---
gcal:
  - when: 2026-08-18
  - when: 2026-08-25
gcal-repeat: weekly
---
```

`gcal-repeat` **lists** are no longer accepted. They were matched to `gcal` by position, so
reordering one list without the other swapped the events' identities, and they could not hold a
title. A note still using one reports:

> gcal-repeat is no longer matched to gcal by position; give each gcal entry its own repeat field

Replace the two lists with a list of maps:

```yaml
# before
gcal:
  - 2026-10-01/P2D
  - 2026-11-01
gcal-repeat:
  - weekdays
  - ""

# after
gcal:
  - when: 2026-10-01/P2D
    repeat: weekdays
  - when: 2026-11-01
```

## Start and duration

| Form | Meaning |
| --- | --- |
| `2026-08-18` | All-day event on that date. |
| `2026-08-18/P3D` | All-day event over 3 days. |
| `2026-08-18T14:00` | 14:00 in the event time zone, 1 hour by default. |
| `14:00` | 14:00 today, in the event time zone. |
| `2026-08-18T14:00-04:00` | An exact moment, 1 hour by default. |
| `2026-08-18T14:00Z/PT90M` | Timed event, 90 minutes. |
| `2026-08-18T14:00-04:00/P1DT2H` | Timed event, 1 day and 2 hours. |

- Times go down to the minute. Seconds are not accepted, in a start or a duration.
- A start with no `Z` and no offset is read in the **Event time zone** setting, which follows this
  device while it is empty. Add `Z` or an offset such as `-04:00` to fix an exact moment whatever
  that setting says. Timed events carry the setting to Google, which uses it to work out repeats.
- An offset on its own, such as `+02:00`, is not a start, and neither is `14:00+02:00`. Write the
  date out to use an offset.
- All-day durations use `PnD` only, and default to `P1D`. Timed durations use `P#DT#H#M`, default to
  `PT1H`, and must be more than zero.

### A bare time means today, once

`Standup gcal:09:00` creates the event today at 09:00, and it stays there. Later syncs read the date
back from the event on Google instead of working out "today" again, so the event does not walk
forward day after day. Change it to `gcal:10:00` and it moves to 10:00 on its original day. Add
`gcal-repeat` if you want it to recur rather than happen once.

Delete the event in Google and the next sync makes it again at today's date, because there is no date
left to read back. A start with no offset also keeps its wall-clock length across a daylight-saving
change: `14:00/PT1H` is 14:00 to 15:00 on both sides. Use `Z` or an offset when you need exactly 3600
seconds.

## Recurrence

Add `gcal-repeat:<rule>` after the event it belongs to, or use a `repeat` field in note properties:

| Rule | Result |
| --- | --- |
| `daily`, `everyday` | Every day. |
| `weekly` | Every week on the start day. |
| `fortnightly` | Every 2 weeks. |
| `monthly` | Every month. |
| `quarterly` | Every 3 months. |
| `yearly`, `annually` | Every year. |
| `weekdays` | Monday to Friday. |
| `monday`, `mon` | Every Monday. |
| `mon,wed,fri` | Those weekdays. |
| `monday-thursday` | That range of weekdays. |
| `every-2-weeks`, `every-10-days`, `every-3-months` | Every n days, weeks, months, or years. |
| `FREQ=MONTHLY;BYMONTHDAY=1` | Used as an RRULE. |

Interval rules are `every-<n>-<unit>`, where the unit is `day`, `week`, `month`, or `year`, plural or
singular. The number can be left out (`every-week`), and `every-1-week` is just `weekly`. An `every-`
prefix is allowed everywhere, so `every-weekly` and `weekly` are the same. Ranges must run forward
within Monday to Sunday. An RRULE may start with `RRULE:` and needs `FREQ` to be `DAILY`, `WEEKLY`,
`MONTHLY`, or `YEARLY`.

```markdown
Standup `gcal:2026-08-18T09:15/PT15M gcal-repeat:weekdays`
Rent `gcal:2026-09-01 gcal-repeat:FREQ=MONTHLY;BYMONTHDAY=1`
```

## How a declaration is shown

A declaration you are not editing becomes a chip with the date, the time, and the repeat in words,
led by an icon showing whether it reached Google:

```markdown
- [ ] Design review `gcal:2026-08-18T14:00/PT1H gcal-repeat:weekdays`
```

> - [ ] Design review  &nbsp;`✅ Tue 18 Aug, 14:00–15:00 · ↻ Mon–Fri`

Click a chip to get the text back and edit it. In Live Preview the cursor lands in the declaration
and the chip returns when you move away. In Reading view clicking swaps between the two.

The text still shows while the cursor is inside it, and when the declaration could not be read, so a
typo shows you the typo. Turn **Render declarations** off to always see the text.

A chip shows what the plugin understood, so a wrong date or repeat shows up before your calendar
does.

| Wording | Meaning |
| --- | --- |
| `Today`, `Tomorrow`, `Yesterday` | A one-off event on that day. A repeating one shows its date, since the rule says when it happens. |
| `Tue 18 Aug` | An all-day event. No weekday when it repeats. |
| `18 – 20 Aug` | An all-day event over several days, ending on the last day it covers. |
| `Tue 18 Aug, 14:00–15:00` | A timed event, in the event time zone. |
| `Mon–Fri`, `every 2 weeks`, `monthly on day 1` | The repeat rule in words. |
| `FREQ=WEEKLY;UNTIL=…` | A rule too detailed to put in words, shown as you wrote it. |

Dates and times follow your system language and region.

### Note properties

The `gcal` property gets the same chips. Where depends on Obsidian's **Properties in document**
setting:

| Setting | What you get |
| --- | --- |
| Source | The properties stay as YAML, and each start becomes a chip. |
| Visible | `gcal` becomes chips when it holds one value or a list of maps. |
| Hidden | Nothing to draw. |

Under **Visible**, a `gcal` that Obsidian has typed as a date or a list of text keeps Obsidian's own
field, which already reads well and can be edited.

### Status icons

| Icon | Meaning |
| --- | --- |
| Green tick | The event is on your calendar. |
| Grey clock | Read correctly, but not synced yet. The sync is queued, or not set up. |
| Orange minus | Fine, but held back because another declaration in the same note is broken. |
| Red cross | This declaration could not be read. Hover it for the reason. |

A note syncs all or nothing, which is why one bad line shows a cross on itself and a minus on the
others instead of marking the whole note as broken.

## Limits

- A note may declare at most 100 events.
- If any declaration in a note is invalid, the whole note is skipped for that sync and its last
  synced events are kept. A notice names the note, the line, and the problem.
- Two notes cannot claim the same event. The first one scanned wins and the other is skipped.

You never write an id. The plugin identifies each declaration by where it sits and copes with you
moving or renaming things, which
[How sync works](how-sync-works.md#how-an-event-keeps-its-identity) explains, along with the two
cases where an event is made again instead of moved.

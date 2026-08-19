# Getting started

The plugin ships no Google credentials, so the first step is creating an OAuth client of your own.
It stays private to you, and Google treats the plugin as an app you wrote.

## 1. Create a Google Cloud OAuth client

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project, or
   select an existing one.
2. Go to **APIs & Services → Library**, search for **Google Calendar API**, and enable it.
3. Go to **APIs & Services → OAuth consent screen** and configure it. Choose **External** unless
   you have a Google Workspace account and want **Internal**. Add your own Google account under
   **Test users**.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID** and choose
   application type **Desktop app**.
5. Copy the client ID. Google may also show a client secret; copy it if there is one.

Desktop clients accept a loopback redirect, so there is no redirect URI to register.

> An External client left in **Testing** issues refresh tokens that expire after 7 days. To stop
> reauthorizing every week, set the consent screen to **In production**. Google shows an
> "unverified app" warning during sign-in, which you can accept for an app you built yourself.

## 2. Connect Obsidian

Open **Settings → Google Calendar Sync**.

1. **OAuth client ID**: create an Obsidian secret and paste the client ID into it.
2. **OAuth client secret**: do the same for the secret, if your client has one. Leave it empty
   otherwise.
3. Click **Authorize**. Your browser opens Google's consent screen. Approve, and the tab confirms
   the authorization. The refresh token is saved in Obsidian's secret storage, not in your vault.

The plugin requests three scopes: read and write calendar events, read your list of calendars, and
create calendars.

## 3. Choose a calendar

Under **Calendar**, the dropdown lists every calendar you can write to. Pick one.

Prefer a dedicated calendar. Use **Create calendar**, name it something like `Obsidian`, and the
plugin selects it for you. Synced events then stay separate from everything else, and a mistake in
a note cannot disturb your main calendar.

Changing calendars later does not remove events from the previous one. Clear the note declarations
first, sync, then switch.

## 4. Declare your first event

Add a line to any note:

```markdown
Design review `gcal:2026-08-18T14:00/PT1H`
```

Save the note. The plugin syncs about a second later and shows a notice with what changed. You can
also run the **Sync now** command from the command palette, or click **Sync** in settings.

The event title is the text before the declaration, so this creates a one hour "Design review".

Next: [Event syntax](event-syntax.md) for everything you can write, and
[Settings](settings.md) for the rest of the options.

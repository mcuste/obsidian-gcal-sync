# Development and release

## Setup

Needs Node 22 or newer and pnpm.

```bash
pnpm install
pnpm dev      # rebuild main.js on every change
pnpm check    # Biome, tests, dead code, dependency audit, production build
pnpm fix      # apply Biome's formatting and lint fixes
```

To try changes in Obsidian, use a scratch vault and symlink the repository into
`<vault>/.obsidian/plugins/gcal-sync`, or copy `main.js`, `manifest.json`, and `styles.css` there
after a build. Reload the plugin in Obsidian to pick up a rebuild.

`pnpm check` must pass before you open a pull request. Its steps also run on their own:
`pnpm quality`, `pnpm test`, `pnpm deadcode`, `pnpm security`, `pnpm build`.

## Layout

| File | Contents |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, vault scanning, and sync scheduling. |
| `src/event-parser.ts` | Turns note text and properties into event declarations. |
| `src/sync-plan.ts` | Compares declared events with remote events, with no I/O. |
| `src/gcal.ts` | Google Calendar and OAuth token HTTP calls. |
| `src/gcal-oauth.ts` | Authorization code flow with PKCE and the loopback callback. |
| `src/settings.ts` | Settings tab. |
| `src/directive-status.ts` | Status markers in Live Preview and Reading view. |
| `src/confirm-modal.ts` | Approval dialog for large or destructive syncs. |

Tests live in `tests/` and run on the Node test runner through tsx. `tests/obsidian-stub.ts` stands in
for the Obsidian API. Parsing and planning are pure, so test behavior there rather than mocking the
plugin.

## Pull requests

- Keep the change focused, and add tests for parsing or planning changes.
- Update the docs in `docs/` when behavior, settings, or messages change.
- Do not bump the version in `manifest.json` or `versions.json`. That happens at release.

## How releases reach users

Obsidian does not host plugin code. The community directory is an index pointing at a GitHub
repository, and Obsidian installs from that repository's releases.

```
your repo ──manifest.json at HEAD──> community directory (name, description, id, versions)
    │
    └──GitHub release tagged <version>──> main.js + manifest.json + styles.css ──> vault
```

So `manifest.json` on the default branch and a GitHub release tagged with that same version have to
agree, or installs fail. The tag carries no `v` prefix, the files are attached separately rather than
zipped, and the release workflow checks all of this before building. `versions.json` maps each plugin
version to the Obsidian version it needs, so older Obsidian installs fall back to an older plugin
release instead of a broken one.

## Cutting a release

Maintainers only.

```bash
pnpm check                                 # must pass first
pnpm version patch --no-git-tag-version    # bumps package.json, manifest.json, versions.json
$EDITOR CHANGELOG.md                       # add a "## [0.1.1] - <date>" section
git commit -am "release: 0.1.1"
git tag 0.1.1                              # no v prefix
git push && git push --tags
```

`--no-git-tag-version` matters: on its own, `pnpm version` commits and tags as `v0.1.1`, and the
workflow rejects a tag that does not match the manifest version exactly.

Pushing the tag runs `.github/workflows/release.yml`, which checks the tag against `manifest.json`,
builds, attests the artifacts, and publishes a release with the three files attached. Nothing is left
to click, so the tag is the point of no return: Obsidian can offer the update as soon as the job
finishes.

The release body is the matching section of [CHANGELOG.md](../CHANGELOG.md), which follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The workflow reads everything between
`## [<tag>]` and the next `## [`, so the heading has to use the tag exactly. Obsidian shows these
notes when it offers the update, so write them for users, not as a commit log. If no section matches,
the workflow says so and falls back to notes generated from commits, which means the changelog was
forgotten.

### Checklist

- [ ] `pnpm check` passes.
- [ ] `CHANGELOG.md` has a section whose heading matches the tag exactly.
- [ ] Docs match behavior, including settings names and error messages.
- [ ] `manifest.json`, `versions.json`, and the tag agree, and the tag has no `v` prefix.
- [ ] The release has `main.js`, `manifest.json`, and `styles.css` attached as separate files.
- [ ] The README still lists every host the plugin contacts.

## Publishing to the community directory

The repository root needs `README.md`, `LICENSE`, and `manifest.json`. The README is shown on the
plugin's listing page, so it has to explain what the plugin does and disclose anything the
[developer policies](https://docs.obsidian.md/Community+directory/Developer+policies) call out. Rules
that shaped this repository:

| Rule | Here |
| --- | --- |
| The id cannot contain `obsidian` and must be unique | `gcal-sync` |
| Description under 250 characters, ending with a period | "Sync Google Calendar events declared in vault notes." |
| Node and Electron APIs mean desktop only | `isDesktopOnly: true`, for `node:http` and `node:crypto` |
| `minAppVersion` is the oldest version that works | `1.13.0`, the first with declarative settings |
| Network use must be disclosed in the README | The [network use table](../README.md#network-use) |
| An account requirement must be disclosed | The same table, plus the OAuth client note below |
| A license file is required | MIT |
| Command ids already carry the plugin id | The command is `sync-now`, not `gcal-sync-now` |

### First submission

Once, after the first release is published. Sign in at
[community.obsidian.md](https://community.obsidian.md) with an Obsidian account, link the GitHub
account that owns the repository, add the plugin with the description below, and publish the listing.
An automated review runs, and the listing is not installable until it is clean; if it reports
problems, fix them, cut a new release with a higher version, and resubmit. Later releases need no
resubmission.

The plugin needs a Google Cloud OAuth client that the user creates, because it bundles no shared
credentials. That is allowed, but it is real setup work and reviewers look for it, so the listing says
so too:

> Declare calendar events inline in your notes and sync them to Google Calendar. Add
> `gcal:2026-08-18T14:00/PT1H` to a line and the event appears on the calendar you selected; edit or
> delete the line and the event follows. Sync is one way, and the plugin only touches events it
> created.
>
> Desktop only. Requires a Google account and your own Google Cloud OAuth client, which takes a few
> minutes to create and is covered in the setup guide. The plugin ships no shared credentials and
> contacts no server other than Google.

### Beta testing

To hand a build to testers before submitting, publish a GitHub release as usual and point them at
[BRAT](https://github.com/TfTHacker/obsidian42-brat), which installs plugins straight from a
repository. Nothing about the release process changes.

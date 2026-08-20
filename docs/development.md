# Development and release

## Setup

Requires Node 22 or newer and pnpm.

```bash
pnpm install
pnpm dev     # rebuild main.js on every change
```

To try changes in Obsidian, work in a scratch vault and symlink the repository into
`<vault>/.obsidian/plugins/gcal-sync`, or copy `main.js`, `manifest.json`, and `styles.css` there
after a build. Reload the plugin in Obsidian to pick up a rebuild.

## Checks

```bash
pnpm check
```

That runs Biome, the tests, the dead code check, a dependency audit, and a production build. Run it
before opening a pull request.

Individual steps: `pnpm quality`, `pnpm test`, `pnpm deadcode`, `pnpm security`, `pnpm build`.
`pnpm fix` applies Biome's formatting and lint fixes.

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

Tests live in `tests/` and run on the Node test runner through tsx. `tests/obsidian-stub.ts` stands
in for the Obsidian API. Parsing and planning are pure, so prefer testing behavior there over
mocking the plugin.

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

Two places have to agree:

- **`manifest.json` on the default branch** is what the directory reads for the id, name,
  description, `minAppVersion`, and current version.
- **A GitHub release whose tag equals that version** is what Obsidian downloads the files from. The
  tag carries no `v` prefix, and the assets are attached as separate files, not zipped.

If the versions disagree, installs fail. The release workflow checks it before building.

`versions.json` maps each plugin version to the Obsidian version it needs, which lets older
Obsidian installs fall back to an older plugin release instead of a broken one.

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

`--no-git-tag-version` matters: left to itself, `pnpm version` commits and tags as `v0.1.1`, and
the release workflow rejects a tag that does not equal the manifest version exactly.

Pushing the tag runs `.github/workflows/release.yml`, which verifies the tag against
`manifest.json`, builds, attests the artifacts, and publishes a release with `main.js`,
`manifest.json`, and `styles.css` attached. There is nothing left to click, so the tag is the point
of no return: Obsidian can offer the update as soon as the job finishes.

### Release notes

The release body is the matching section of [CHANGELOG.md](../CHANGELOG.md), which follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The workflow reads everything between
`## [<tag>]` and the next `## [`, so the heading has to use the tag verbatim, with no `v` prefix.
Obsidian shows these notes to users when it offers the update, so write them for users rather than
as a commit log.

If no section matches the tag, the workflow logs that and falls back to notes generated from
commits, which is a signal that the changelog was forgotten rather than an intended outcome.

### Checklist

- [ ] `pnpm check` passes.
- [ ] `CHANGELOG.md` has a section whose heading matches the tag exactly.
- [ ] Docs match behavior, including settings names and error messages.
- [ ] `manifest.json`, `versions.json`, and the tag agree, and the tag has no `v` prefix.
- [ ] The release has `main.js`, `manifest.json`, and `styles.css` attached as separate files.
- [ ] The README still discloses every host the plugin contacts.

## Publishing to the community directory

The repository root needs `README.md`, `LICENSE`, and `manifest.json`. The README is shown on the
plugin's listing page, so it has to explain what the plugin does and disclose anything the
[developer policies](https://docs.obsidian.md/Community+directory/Developer+policies) call out.

Requirements that shaped this repository:

| Rule | Here |
| --- | --- |
| The id cannot contain `obsidian` and must be unique | `gcal-sync` |
| Description under 250 characters, ending with a period | "Sync Google Calendar events declared in vault notes." |
| Node and Electron APIs mean desktop only | `isDesktopOnly: true`, for `node:http` and `node:crypto` |
| `minAppVersion` is the oldest version that works | `1.13.0`, the first with declarative settings |
| Network use must be disclosed in the README | The [network use table](../README.md#network-use) |
| An account requirement must be disclosed | The same table, plus the OAuth client note below |
| A license file is required | MIT |
| Command ids are already prefixed with the plugin id | The command is `sync-now`, not `gcal-sync-now` |

### First submission

Do this once, after the first release is published.

1. Sign in at [community.obsidian.md](https://community.obsidian.md) with an Obsidian account.
2. Link the GitHub account that owns the repository, so the directory can verify ownership.
3. Add the plugin and paste the directory description below.
4. An automated review runs. If it reports problems, fix them, cut a new release with a higher
   version, and resubmit. The listing is not installable until the review is clean.
5. Publish the listing.

Later releases need no resubmission. Tag, release, and Obsidian offers users the update.

### Directory description

The plugin needs a Google Cloud OAuth client that the user creates, because it bundles no shared
credentials. That is allowed, but it is real setup work and reviewers will look for it, so say so
in the listing rather than only in the README:

> Declare calendar events inline in your notes and sync them to Google Calendar. Add
> `gcal:2026-08-18T14:00/PT1H` to a line and the event appears on the calendar you selected; edit
> or
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

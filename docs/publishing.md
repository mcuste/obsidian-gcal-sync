# Publishing

Maintainer notes. How an Obsidian plugin reaches users, and what this repository does about it.

## How it works

Obsidian does not host plugin code. The community directory is an index that points at a GitHub
repository, and Obsidian installs from that repository's releases.

```
your repo ──manifest.json at HEAD──> community directory (name, description, id, versions)
    │
    └──GitHub release tagged <version>──> main.js + manifest.json ──> user's vault
```

Two places have to agree:

- **`manifest.json` on the default branch** is what the directory reads for the id, name,
  description, `minAppVersion`, and current version.
- **A GitHub release whose tag equals that version** is what Obsidian downloads `main.js`,
  `manifest.json`, and optionally `styles.css` from. The tag carries no `v` prefix, and the assets
  are attached as files, not zipped.

If the versions disagree, installs fail. The release workflow in this repository checks that before
building.

## Repository requirements

The root needs `README.md`, `LICENSE`, and `manifest.json`. The README is shown on the plugin's
listing page, so it has to explain what the plugin does and disclose anything the
[developer policies](https://docs.obsidian.md/Community+directory/Developer+policies) call out.

Requirements that shaped this repository:

| Rule | Here |
| --- | --- |
| The id cannot contain `obsidian` and must be unique | `gcal-sync` |
| Description under 250 characters, ending with a period | "Sync Google Calendar events declared in vault notes." |
| Node and Electron APIs mean desktop only | `isDesktopOnly: true`, for `node:http` and `node:crypto` |
| `minAppVersion` is the oldest version that works | `1.11.5`, the first with `SecretComponent` |
| Network use must be disclosed in the README | The network use table in [README.md](../README.md) |
| An account requirement must be disclosed | Same table, plus the OAuth client note below |
| A license file is required | MIT |
| Command ids are already prefixed with the plugin id | The command is `sync-now`, not `gcal-sync-now` |

## Cutting a release

```bash
pnpm check                    # must pass first
pnpm version patch            # bumps package.json, manifest.json, versions.json, stages them
git commit -m "release: 0.1.1"
git tag 0.1.1
git push && git push --tags
```

Pushing the tag runs `.github/workflows/release.yml`, which verifies the tag against
`manifest.json`, builds, attests the artifacts, and opens a draft release with `main.js`,
`manifest.json`, and `styles.css` attached. Review the generated notes and publish it.

`versions.json` maps each plugin version to the Obsidian version it needs, which lets older
Obsidian installs fall back to an older plugin release instead of a broken one.

## First submission

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
> `gcal:2026-08-18T14:00/PT1H` to a line and the event appears on the calendar you selected;
> edit or delete the line and the event follows. Sync is one way, and the plugin only touches
> events it created.
>
> Desktop only. Requires a Google account and your own Google Cloud OAuth client, which takes a
> few minutes to create and is covered in the setup guide. The plugin ships no shared credentials
> and contacts no server other than Google.

## Beta testing

To hand a build to testers before submitting, publish a GitHub release as usual and point them at
[BRAT](https://github.com/TfTHacker/obsidian42-brat), which installs plugins straight from a
repository. Nothing about the release process changes.

## Checklist

- [ ] `pnpm check` passes.
- [ ] Docs match behavior, including settings names and error messages.
- [ ] `manifest.json`, `versions.json`, and the tag agree.
- [ ] The release has `main.js`, `manifest.json`, and `styles.css` attached as separate files.
- [ ] The README still discloses every host the plugin contacts.

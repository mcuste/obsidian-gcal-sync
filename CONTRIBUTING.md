# Contributing

## Setup

Requires Node 22 or later and pnpm.

```bash
pnpm install
pnpm dev     # rebuild main.js on every change
```

To try changes in Obsidian, work in a scratch vault and symlink the repository into
`<vault>/.obsidian/plugins/gcal-sync`, or copy `main.js` and `manifest.json` there after
a build. Reload the plugin in Obsidian to pick up a rebuild.

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
| `src/confirm-modal.ts` | Approval dialog for large or destructive syncs. |

Tests live in `tests/` and run on the Node test runner through tsx. `tests/obsidian-stub.ts` stands
in for the Obsidian API. Parsing and planning are pure, so prefer testing behavior there over
mocking the plugin.

## Pull requests

- Keep the change focused, and add tests for parsing or planning changes.
- Update the docs in `docs/` when behavior or settings change.
- Do not bump the version in `manifest.json` or `versions.json`. That happens at release.

## Releasing

Maintainers only:

```bash
pnpm version <patch|minor|major>   # updates package.json, manifest.json, versions.json
git push && git push --tags
```

Pushing the tag runs the release workflow, which builds the plugin and creates a draft GitHub
release with `main.js` and `manifest.json` attached. Add release notes and publish it.

[docs/publishing.md](docs/publishing.md) covers how the community directory picks this up.

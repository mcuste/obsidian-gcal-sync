# Contributing

Setup, checks, code layout, and pull request expectations are in
[docs/development.md](docs/development.md), together with the release process.

The short version:

```bash
pnpm install
pnpm dev      # rebuild main.js on every change
pnpm check    # lint, tests, dead code, audit, build
```

`pnpm check` must pass before you open a pull request. Add tests for parsing or planning changes,
update the docs in `docs/` when behavior changes, and leave the version in `manifest.json` alone.

Security issues go to a
[security advisory](https://github.com/mcuste/obsidian-gcal-sync/security/advisories/new) rather
than a public issue.

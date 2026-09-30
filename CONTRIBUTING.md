# Contributing

Thanks for helping. This plugin measures a live session and must never change
it, so the bar for a patch is: **no model calls, no token spend, no writes into
the session**.

## Development setup

The plugin is a DSH bundle. For local work, install the checkout into a profile
as a link so edits apply without reinstalling:

```sh
git clone git@github.com:mpinaev/dsh-context-governor.git
cd dsh-context-governor
npm test
dsh plugin --profile web add "link:$PWD"
```

Then restart `dsh web` (the host half is read at startup) and reload the page
(the client half is served as a revision snapshot).

If the profile already mounts the plugin by absolute path in
`~/.dsh/profiles/<profile>/cordis.patch.yml`, remove that `insert` first, or the
plugin mounts twice.

## Checks before a pull request

```sh
npm test              # smoke test, no network, no model calls
npm pack --dry-run    # the published file list must stay intended
./scripts/compat-check.sh   # boots a spare instance and asks the live API
```

## What to keep in mind

- **Never add a model call.** No review, no summarization, no background agent.
  The whole point of the plugin is that it is free.
- **Keep the compaction formula in sync** with `@deepseek-ai/dsh-compaction-basic`
  (`min(thresholdRatio * window, window - reserve - headroom)`, headroom 65536).
- **Keep the peer range current.** When a new DSH line appears, widen
  `peerDependencies` — otherwise the version gate silently disables the plugin.
- The status payload is an API: add fields deliberately, and update `test/smoke.mjs`.

## Releases

1. Move entries from the unreleased section of `CHANGELOG.md` under the new version.
2. Bump `version` in `package.json` (patch for DSH compatibility, minor for
   features) **and** in the `version` assertion of `test/smoke.mjs`, which pins
   the released version on purpose.
3. `npm test` and `npm pack --dry-run`.
4. Commit, and push `main` and the tag.

Pushing the tag **is** the release: `.github/workflows/publish.yml` runs the smoke
test, checks that the tag matches `package.json`, and publishes through npm trusted
publishing — so no token is stored in this repository, in Actions secrets, or on
anyone's machine. npm attaches provenance attestations on its own; do not pass
`--provenance`.

This relies on a trusted publisher configured once on npmjs.com for the package:
GitHub Actions, repository `mpinaev/dsh-context-governor`, workflow file
`publish.yml`, permission "Allow npm publish".

Publishing by hand from a laptop still works, but only with a token that has 2FA
bypass enabled — and npm retires that path for direct publishing in January 2027.

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
4. Commit, tag `vX.Y.Z`, push the tag.
5. `npm publish`.

Publishing requires either 2FA on the npm account or a granular access token with
2FA bypass enabled; npm turns the request down without one of them. `--provenance`
is deliberately not used here — it needs an OIDC identity that only a supported CI
system (GitHub Actions, GitLab, CircleCI) can provide, so a publish from a laptop
cannot carry it. Releases stay unsigned until a release workflow exists.

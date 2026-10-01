# Changelog

## Unreleased

- The peak/off-peak tariff now honours Chinese public holidays. DeepSeek's rule
  is peak on weekdays **excluding Chinese public holidays**, and off-peak all day
  on those holidays — but the plugin only knew weekdays and hours, so on the
  National Day holidays (1–7 October 2026) it reported `peak (×2)` and doubled
  the rates and the step cost while DeepSeek was charging the off-peak half.
  The year's calendar is fetched in the background from a maintained source
  (`holidayUrl`, default `chinese-days` data), cached on disk under
  `<DSH_HOME>/cache/context-governor`, and refreshed on its own — no yearly code
  edit. `holidays` config takes `'YYYY-MM-DD'` dates or ranges and wins over the
  source; `holidayFetch: false` keeps the plugin fully offline. Until the
  calendar is known the weekday rule applies and the panel says so
  (`season.holidayKnown`); the countdown now skips whole holidays to the next
  working peak, and the tariff row reads "off-peak (Chinese holiday)".
- `README.zh.md`: a full Chinese translation of the README, since the plugin
  already ships a Chinese interface. The language switcher in both existing
  READMEs links to it, and the stale assertion count in the dev section was
  corrected to match the smoke test.
- The balance is printed to the cent. `fmtMoney` used three decimals below 100
  (a leftover from the step-cost formatter `fmtUsd`, where a step can cost a
  fraction of a cent), so a `¥8.95` balance read `¥8.950` while the tooltip
  printed the raw `8.95`. Money is now two decimals everywhere — chip, panel and
  tooltip, in every currency.
- The READMEs state plainly that the step cost and the rates are in US dollars
  while the balance is shown in the source currency (USD or CNY) without
  conversion, so the two must not be compared directly.

## 0.2.3

- Documentation release, no code changes. The npm page renders the README from
  the published tarball rather than from the repository, so badges, screenshots
  and the corrected install section only reach it with a new version.
- Screenshots of the panel in all three UI languages (English, Chinese, Russian)
  and of the handoff button, shown in both READMEs.
- `screenshots.json` declares those images for storefronts such as dsh-market and
  the plugin catalog, which read them straight from this repository — the order
  is set here instead of being extracted from the README.
- The install section no longer says "once published", and the release steps in
  `CONTRIBUTING.md` no longer instruct a local `--provenance` publish, which
  needs a CI OIDC identity. They now also mention that `test/smoke.mjs` pins the
  released version and has to be bumped alongside `package.json` — the omission
  is what a version bump without it fails on.

## 0.2.2

- Do not invent prices for providers the plugin has no rates for. DSH does not
  expose token cost anywhere (not in the model info, not in the token meter,
  not in any service) — the only rates are the plugin's own, and they are
  DeepSeek's. From a non-DeepSeek provider (cline, OpenRouter, pi-ai, …) the
  chip and panel now read "price unavailable" instead of a fake `$`, and the
  `cost`/`relative`/`rates` fields are `null`; `expensiveStep`/`coldPrefill`
  stop reporting a dollar amount there. The peak/off-peak (⚡/🌙) marker is
  still shown: it is a clock reading, not a price. `pricedProviders` config
  (default `['deepseek-official']`) controls who is known.
- New i18n keys `noPrice` and `balanceUnknown`.

## 0.2.1

- Cache-hit is now computed from the session totals and formatted like the
  harness: a partial hit is never rounded up to 100. Previously the last step was
  rounded with `Math.round`, so a session at 99.8% showed `100%` while the
  harness showed `99.8%`. The panel row is labelled "cache-hit (session)" and the
  status payload carries a display-ready `cacheHitText`.
- The `windowSource` field in the status payload is now a stable code
  (`catalog` / `request`) instead of a Russian phrase, and the client renders it
  in the selected language. Previously "каталог" and "резолв запроса" stayed
  Russian in the English and Chinese interfaces.

## 0.2.0

- Token usage now comes from the harness projection `tokenUsage`
  (`ctx.sessionProjections`) instead of a private fold of `llm/stream`; the
  fallback fold is kept for builds without projections.
- The model window and pressure come from the `contextPressure` projection.
- The compaction threshold and the bands are computed per session; a session whose
  route is unknown no longer inherits another model's threshold, and bands are no
  longer invented when the window is unknown.
- Cache input is split into cache read and cache write, each with its own rate
  (`cacheWriteRate` added, defaulting to `freshRate`); cache-hit counts reads
  only.
- The balance is read from the harness `deepseekAccount` service first and falls
  back to the DeepSeek API key; the response carries its `source`.
- The balance is shown only for DeepSeek providers (`balanceProviders`), so a
  Cline session no longer displays a DeepSeek total.
- The status payload was trimmed to the fields consumers actually read.
- Added a bundle patch, declared harness peer dependencies, an English README,
  a LICENSE and a smoke test (`npm test`).

## 0.1.0

- Initial version: context chip with bands, cache-aware step cost, cache-hit,
  cold input per step, DeepSeek balance, peak/off-peak tariff and handoff button.

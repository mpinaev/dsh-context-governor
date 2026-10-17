# Changelog

## 0.3.3

- The handoff document now covers the whole session instead of its tail. It used
  to take the last user message as the task and the last assistant message as
  the state, so a long session read as "what happened at the end" with no path
  to it. The host now walks the model surface in order: the first task, then
  every user request with the last assistant answer to it (the session arc),
  then the current state and the touched files.
- Injected harness messages are not requests. AGENTS.md, the runtime-context
  snapshot, the skill catalog and the time snapshot arrive as `user/message`
  events whose `source.kind` is not `user`; before, they became arc steps and the
  answer to the previous turn stuck to them. Now only real user messages — or
  messages from an older host without a source — start a step.
- Several messages of one turn fold into one step: a user who sends text and then
  an image is one request, and the image is marked `[изображение]` / `[image]` /
  `[图片]`. Touched files are reduced to one form (relative to cwd), so a file no
  longer appears twice under two different paths.
- A very long session keeps its beginning and its end (24 steps) and says how
  many middle requests were skipped, instead of dumping everything.
- The smoke suite covers the arc: first task versus last, the middle, numbering,
  en/zh localization, injected-message filtering, image steps, same-turn merging
  and the long-session gap marker.

## 0.3.2

- The balance is no longer short by the granted wallet on the platform-account
  path. The account service returns topped-up wallets in `value` and granted
  ones in `bonusWallets`; the plugin summed only `value` and reported it as the
  total, so a $29.53 grant next to a $19.26 top-up read "$19.26, granted
  $29.53, topped up $0" — smaller than the real balance and internally absurd.
  The total is now topped-up plus granted in the primary wallet's currency
  ($48.79 in that example), with the two parts still shown separately.
- Wallets in another currency are surfaced instead of discarded. DeepSeek keeps
  yuan and dollar wallets side by side, and the DSH account panel shows them as
  "$29.53 + ¥1.45"; the plugin used to drop everything but the first currency.
  The status payload now carries an `others` list (also filled from the extra
  `balance_infos` of `/user/balance`), and the chip, the panel row and the
  tooltip append it as "+ ¥1.45". Yuan and dollars are still never added to one
  another.
- The smoke suite pins the account arithmetic against the real wallet shape
  (topped-up 19.26 + granted 29.53 + CNY 1.45 -> 48.79 USD + ¥1.45) and the
  multi-currency `/user/balance` response; all three READMEs document the suffix
  and the assertion count.

## 0.3.1

- DSH 0.2.1 support declared. The 0.2.1 line needs no code change: every host
  contract the plugin touches is unchanged there — `session/event` with
  `request/context` and `request/header` (same payload fields, same
  `contextWindow` and `config.maxTokens`), the `tokenUsage` / `contextPressure`
  projections (`onChanged`, `stateOf`), the session query surface (`readSurface`,
  `filterEvents`), `credentials.resolve`, the account balance shapes
  (`credential-stored`, `value` / `bonusWallets`), `webServer.register`, the
  model catalog (`llm.resolveModelInfo`) and both client slots
  (`conversation.session.header.utilities`, `conversation.input.right`) — and
  `uiWorkspace.startSession` only gained an optional argument. The compaction
  formula in `dsh-compaction-basic` is byte-for-byte identical between
  `0.2.0-rc.2` and `0.2.1-rc.1`, so the threshold and the bands stay right.
- The compatibility range now lives in `engines.dsh`. DSH 0.2.1 checks that field
  and ignores `peerDependencies` once it is present, so this is the declaration
  that actually decides; the peers stay so package managers and older hosts keep
  reading a range. The same range still matches `0.2.1-rc.1` because the host
  compares prereleases included, which is what the plugin quietly relied on
  before.
- On Web, DSH 0.2.1 resolves a stored credential before the environment. The
  balance follows with no code change — it resolves the key through
  `credentials.resolve('DEEPSEEK_API_KEY')` and only then falls back to
  `DEEPSEEK_API_KEY` from the environment — so the documented order now matches
  the host's.
- The DSH compatibility tables in all three READMEs name `0.2.1-rc.1`, and the
  development section's assertion count now matches the smoke test (101, not the
  stale 58).

## 0.3.0

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
- At peak the balance and the time indicators are red. The host's `season.color`
  is now red during peak (it was amber), and the client paints the chip balance,
  the chip tariff marker, and the panel's tariff / countdown / Beijing-time /
  balance rows with it, so the expensive hours read at a glance.
- Fixed a literal "undefined" in the English and Chinese interfaces. The client's
  `balanceUnknown` string existed only in the Russian dictionary, so on a
  non-DeepSeek provider the panel's balance row and the chip tooltip rendered
  `undefined` instead of text. A smoke test now compares each language's keys
  against English recursively, so a missing key fails the suite instead of
  leaking into the UI.
- No price UI at all on providers the plugin has no rates for. Previously the
  chip and the panel wrote "price unavailable" for cline and friends, which was
  noise around numbers that do not exist. The status payload now carries
  `config.priced`, and the client drops the whole price block when it is false:
  the chip loses its cost segment, and the panel loses the step-cost,
  relative-to-base and rates rows. The peak marker stays (it is a clock reading),
  but its `×N` multiplier appears only where rates are known.
- Rates and the seasonal tariff are now per provider. `providerRates.<id>`
  overrides the default `freshRate` / `cacheReadRate` / `cacheWriteRate` /
  `outputRate` (and `peakMultiplier`), so a second provider can carry its own
  numbers, and a provider with explicit rates is priced even if it is not in
  `pricedProviders`. The DeepSeek season — peak/off-peak, the `×N` multiplier and
  the Chinese holidays — now applies only to a *seasonal* provider, by default an
  id starting with `deepseek`; a foreign provider declares `seasonal: true` in its
  `providerRates` entry to opt in. Behaviour change: a non-DeepSeek provider no
  longer has its rates doubled in DeepSeek's peak hours, and it gets neither the
  tariff marker nor the tariff rows.
- `providerRates.<id>.cached: false` for a provider with no prompt cache. The
  arithmetic already worked (zero cache buckets contribute nothing), but the UI
  and the signals did not know: the rates row still listed cache-read/cache-write
  prices, the panel showed cache rows and a permanent 0% cache-hit, and the
  `cacheHitLow` warning fired on every step because 0% is below the 90% floor —
  plus a cold-prefill alarm on each request, since every token is fresh by
  definition there. With the flag the cache rows, the cache rates, the chip's
  cache-hit marker and both warnings go away; a caching provider is unaffected.

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

# dsh-context-governor

**English** | [Русский](README.ru.md) | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-context-governor)](https://www.npmjs.com/package/dsh-context-governor)
[![CI](https://github.com/mpinaev/dsh-context-governor/actions/workflows/ci.yml/badge.svg)](https://github.com/mpinaev/dsh-context-governor/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-context-governor)](LICENSE)

A DeepSeek Harness plugin: a session context indicator — prompt size, step cost,
cache-hit, bands and the compaction threshold, DeepSeek balance and the
peak/off-peak tariff, plus a handoff button.

**It never calls a model and spends no tokens at all** — details below.

## What it looks like

The chip in the session header opens the panel below. The same panel is available
in English, Chinese and Russian:

| English | 中文 | Русский |
|---|---|---|
| ![Session context panel in English](https://raw.githubusercontent.com/mpinaev/dsh-context-governor/main/assets/screenshot-1.png) | ![会话上下文面板（中文）](https://raw.githubusercontent.com/mpinaev/dsh-context-governor/main/assets/screenshot-2.png) | ![Панель контекста сессии (русский)](https://raw.githubusercontent.com/mpinaev/dsh-context-governor/main/assets/screenshot-3.png) |

The handoff button sits next to the model selector:

![Handoff button](https://raw.githubusercontent.com/mpinaev/dsh-context-governor/main/assets/screenshot-4.png)

## No tokens, no model calls

Everything the plugin shows is **measurement and arithmetic**. It reads tokens and
the window from harness projections, computes the cost with the configured rates
and fetches the balance over HTTP.

- **No generation requests.** Not for review, not for summarization, not in the
  background: the plugin never asks a model to compute anything.
- **Zero tokens.** The plugin sends no provider requests and spends none of your
  budget. Its only touch of the LLM layer is reading the model catalog
  (`resolveModelInfo`) for the window and limits; that is not generation and not
  billable tokens.
- **Nothing is modified.** It does not touch the history, the system prompt or the
  prefix cache, so it cannot affect prompt caching.
- **The network is used for the balance only.** The harness account service (when
  signed in) and `api.deepseek.com/user/balance` are not a model. Plus `git status`
  on a handoff click, locally.

## Install

As a package:

```sh
dsh plugin --profile web add dsh-context-governor
```

From source:

```sh
dsh plugin --profile web add github:mpinaev/dsh-context-governor
```

Locally, without installing: drop the directory into
`~/.dsh/profiles/web/plugins/` and reference the file from the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: context-governor
      name: /absolute/path/to/dsh-context-governor/index.js
```

Installed as a package, the host half is read at startup, so restart `dsh web`
and reload the page — the client half is served as a revision snapshot.

Check it with `npm test`: the smoke test runs the host half against a stub
harness, with no network and no model calls, and pins the compaction threshold,
the cache buckets, the step cost and the balance provider gate.

## Supported DSH versions

| DSH version | State |
|---|---|
| `0.1.7-rc.2` … `<0.2.0` | supported, verified live |
| `0.2.0-rc.1` … `<0.3.0` | range declared; probed weekly by CI |

DSH **disables** the plugin when its declared range does not cover the running
version (peer ranges are matched with prereleases included). That is why the host
logs its token source and tariff at startup: if those lines are missing, the plugin
is probably disabled, and `dsh --dump-config` will say so.

## Development

```sh
git clone https://github.com/mpinaev/dsh-context-governor.git
cd dsh-context-governor
npm test                     # 58 assertions: no network, no model calls
./scripts/compat-check.sh    # boots a spare instance on 3099 and asks its API
dsh plugin --profile web add "link:$PWD"
```

Rules and the release flow live in [CONTRIBUTING.md](CONTRIBUTING.md).

## What it shows

- prompt size (uncached input + cache tokens) and an **estimated step cost in USD**
  (DeepSeek only; for other providers no price is shown at all);
- a cost multiplier relative to `base` (fresh input = 1.0, cache read =
  `cacheReadRate/freshRate`, about 0.02 for deepseek-flash);
- cache-hit over the session totals, % (a partial hit is never rounded up to 100);
- cold input per step (fresh tokens in the last request);
- a band: 0 = normal, 1 = warn, 2 = high, 3 = critical;
- **DeepSeek balance** (numbers only; the key never reaches the client);
- **peak/off-peak tariff** with a countdown to the switch.

**Why a multiplier over the raw prompt lies.** For deepseek-flash a cache read is
50 times cheaper than fresh input ($0.003 versus $0.15 per 1M off-peak). At 99%
cache-hit a 260k context costs about $0.0015 per step, while `prompt/base` would
report x2.6. That is why the cost is computed per bucket: fresh x `freshRate`,
cache read x `cacheReadRate`, cache write x `cacheWriteRate`, output x
`outputRate`.

## Data sources

**Tokens.** Prompt size, cache-hit and output come from the harness projection
`tokenUsage` (service `ctx.sessionProjections`): `uncachedInputTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `outputTokens`. These are the
provider's authoritative numbers: they survive paging and compaction and close the
slot correctly on a retry (`llm/retry-started`), so a repeated attempt does not
double count. Without projections in the build, the plugin falls back to its own
fold of `llm/stream`.

Cache-hit is computed from the session totals, not from the last step alone, so
it agrees with the harness cache-hit pill. A partial hit is never rounded up to
100 — extra decimals are added instead, and only a miss-free hit shows exactly
`100%`.

**Window and threshold.** The model window and pressure come from the
`contextPressure` projection (`contextWindow`, `pressureTokens`); the output
reserve comes from `request/header` (the request `maxTokens`). The compaction
threshold is computed exactly as the harness does (`dsh-compaction-basic`):

```
threshold = min(thresholdRatio * window, window - reserve - headroom)
```

**The threshold belongs to its own session.** Window and reserve are kept per
session: a session whose route is not known yet reports a window unknown instead
of another model's threshold. No bands are invented while the window is unknown.

**Three input buckets, each with its own rate.** A cache read (default $0.003/1M)
is 50 times cheaper than fresh input, while a cache write on DeepSeek is billed as
ordinary input (`cacheWriteRate`, default = `freshRate`). Cache-hit is the
share of the prompt served from cache **on read**; a cache write does not count as
a hit.

**Money.** Neither DSH nor the provider reports token cost in dollars anywhere, so
the plugin keeps its own rates table (off by default for providers it does not
know). The chip/balance logic is therefore:

- the price is shown **only where the plugin has rates for the provider** — today
  that is DeepSeek (`deepseek-official`, ids starting with `deepseek`). For any
  other provider (cline, clinebot, OpenRouter, pi-ai, …) nothing price-related is
  computed or displayed: the chip drops the cost segment, and the panel drops the
  step-cost, relative-to-base and rates rows — no invented dollar figure and no
  "price unavailable" placeholder either;
- the peak/off-peak time marker (⚡/🌙) is shown always, because it is just a clock
  reading, not a per-provider cost; its `×N` multiplier appears only where the
  rates are known.


## Signals

- a server log entry when a session enters a band, on a cold prefill and on an
  expensive step;
- a client chip in the session header, coloured by band, with a details panel;
- on the chip: balance and the tariff marker (peak / off-peak with countdown).

## Peak/off-peak tariff and balance

**Tariff.** The DeepSeek rule is fixed: peak is Beijing time (UTC+8), on weekdays,
09:00–12:00 and 14:00–18:00; everything else, weekends included, is off-peak and
costs half. The local timezone plays no part in the decision, only in the display.
The configured rates (freshRate, cacheReadRate, cacheWriteRate, outputRate) are
off-peak; at peak they are multiplied by peakMultiplier (2 by default), so the
step cost and the warnings follow the tariff of the moment. The countdown runs to
the next real switch: boundaries inside a weekend are skipped, so after Friday
18:00 it counts to Monday 09:00, not to Saturday. At peak the tariff marker, the
Beijing time and the balance are drawn in red, in both the chip and the panel, so
the expensive hours are visible at a glance.

**Chinese public holidays.** The official rule has an easy-to-miss caveat: peak is
weekdays **excluding Chinese public holidays**, and on those holidays DeepSeek
stays off-peak around the clock. The plugin takes the year's calendar from a
maintained source (`holidayUrl`, by default the data of the `chinese-days`
package), caches it on disk once (`holidayCacheDir`, default
`<DSH_HOME>/cache/context-governor`) and refreshes itself — no code to edit every
year. The network is used in the background only: if the calendar has not arrived,
the tariff falls back to the weekday rule and the panel honestly says the holiday
calendar is not loaded. Your own dates can be set with the `holidays` config — an
array of `'YYYY-MM-DD'` or `'YYYY-MM-DD..YYYY-MM-DD'` ranges; they apply
immediately, take priority over the source and work without a network. On a
holiday the tariff row reads "off-peak (Chinese holiday)" and the countdown skips
the whole holiday to the next working peak. The network can be turned off
entirely: `holidayFetch: false`.

**Balance.** Sources in order:

1. **The official platform account** — the harness service `ctx.deepseekAccount`
   (`getBalance`). It works when the account is signed in and the client has sent
   its build version; wallets arrive as strings, the currency may be CNY or USD,
   and bonus wallets come as a separate list.
2. **The API key** — `GET https://api.deepseek.com/user/balance`, with the key
   from the credentials seam (`DEEPSEEK_API_KEY`) or from the environment.

The `source` field says where the numbers came from: `account` or `api-key`.
The fallback to the second source is deliberate: another build may have no platform
sign-in, and the balance must not disappear because of that.

**The balance is shown only for DeepSeek providers.** On cline, clinebot and any
other provider a foreign total on the chip is plain misinformation: no balance is
displayed there, and the panel shows a DeepSeek-only note instead of a number. The
provider list is configurable through `balanceProviders` (default
`['deepseek-official']`), and any id starting with `deepseek` is accepted. If a
session has no route of its own yet, the provider is not guessed and the balance
stays hidden.

The key **never leaves the host**: only numbers reach the client (total, bonus,
top-up, currency, availability). Concurrent reads collapse, and failures degrade
into a state (no-credential, error, disabled) rather than an exception. The
refresh button clears the cache and re-reads the balance and the tariff.

**The currency is not converted.** The step cost and the configured rates
(`freshRate`, `cacheReadRate`, `cacheWriteRate`, `outputRate` — all $/1M) are in
US dollars, while the balance is printed in whatever currency the source reports
(USD or CNY for DeepSeek), to the cent. The plugin never converts between them, so
a `¥` balance and a `$` step cost in the same chip are different units — compare
them only after converting yourself.

**Route access.** `/context-governor/api/*` are closed by a guard header and an
Origin check: a request must carry `x-dsh-context-governor: 1` (only the plugin
client sets it) and must not be cross-origin. Without the header — 403, with a
foreign `Origin` — 403. A plain loopback GET without `Origin` is allowed, which
keeps `curl` diagnostics convenient.

The practical point: at 99% cache-hit an expensive step is not a large context but
fresh input or a cache miss, and the tariff doubles that difference.

## Handoff button

One click: the host assembles a session summary (task, state, cwd, touched files,
child sessions), the client opens a **new session in the same workspace** through
`ctx.uiWorkspace.startSession()` and puts the summary into its draft. There are
no branches or fallbacks: no Alt+click, no insertion into the current session, no
clipboard.

Two declared services keep it reliable:

- the client declares `inject = ['slots', 'uiWorkspace']`: without the declaration
  Cordis does not hand over the service, and the button used to slip into the
  fallback paths instead of opening a session;
- the host declares `inject = [... 'sessionQuery']`: without it the summary came
  out with no task, state or paths (placeholders only).

The summary reaches the new session lazily: the click remembers the text,
`startSession()` opens the session, its input slot renders, and the same
component puts the text into the draft through `inputActions.setDraft`.

## UI languages

Languages: **en** (default), **zh**, **ru**. The switch is a small button next to
the refresh control in the chip header: it shows the current code (EN / Chinese /
RU) and cycles the language. The choice is remembered in the browser
(`localStorage: dsh-context-governor.lang`) and immediately re-renders both the
chip and the handoff button.

The language covers all interface text (panel labels, warnings, tooltips) and the
language of the document the handoff button inserts into the new session: the
client passes `lang` to `/api/handoff`. The host returns data without text
(band, tariff and warnings are codes), so switching the language needs no data
refetch.

## Thresholds

**The plugin never hardcodes the model window — it reads it from the harness:**

1. The main source is the `contextPressure` projection (`contextWindow`,
   `pressureTokens`) of `ctx.sessionProjections`: the authoritative window of
   the live session.
2. The output reserve is the request `maxTokens` from the `request/header`
   event; until then `request/context` (`contextWindow`) serves as a hint.
3. The model catalog (`ctx.llm.resolveModelInfo` for
   `agentDefaultModel.currentSelection()`) remains a hint until the first request.

Window and reserve are kept **per session**.

The compaction threshold and the bands are derived from the window:

```
reserve               = request maxTokens
compaction threshold  = min(thresholdRatio * window, window - reserve - headroomTokens)
band i                = bandRatios[i] * compaction threshold
```

With a 1,000,000 window and a 256,000 reserve the threshold is 678,464 and the
bands are 237k / 407k / 577k. With an 800,000 window the threshold is 478,464 and
the bands 167k / 287k / 407k. The formula matches `dsh-compaction-basic`
(window - reserve - headroom); with constant bands, critical would sit below the
real prefix-rewrite threshold.

The plugin adapts to different models in different sessions: every session keeps
its own route window, and another session's window is never substituted. If the
window has not been resolved yet, the bands are not invented (there are none) and
the panel shows a model-window-unknown warning.

In the `context-governor` block of `~/.dsh/profiles/web/cordis.patch.yml` you
can tune only `bandRatios`, `headroomTokens`, `thresholdRatio`, the rates
(`freshRate`, `cacheReadRate`, `cacheWriteRate`, `outputRate`,
`peakMultiplier`) and the signal thresholds (`anomalyDelta`,
`anomalyCostUsd`, `cacheHitFloorPct`); for the holiday calendar — `holidays`,
`holidayFetch`, `holidayUrl`, `holidayCacheDir`, `holidayRetryMs`,
`holidayTimeoutMs`; for the balance — `balanceEnabled`,
`useAccountBalance`, `balanceProviders`, `balanceTtlMs`,
`balanceTimeoutMs`. `windowTokens` and `reservedTokens` can be forced, but
they default to `0`, meaning ask the harness; hardcoding them loses the
adaptivity.

## Notes

The bands are derived from the model window; the warn/high/critical labels are not
read back. The plugin measures and never trims: it does not change history or the
prompt.

## License

MIT — see [LICENSE](LICENSE).

# Changelog

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

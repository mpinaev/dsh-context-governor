---
sources:
  - index.js
  - cordis.patch.yml
  - package.json
---

# Хост-половина

`index.js` — серверная половина плагина `dsh-context-governor`. Собирает метрики
сессии из harness и отдаёт их браузеру; модель не вызывает, историю и промпт не
меняет. В сеть ходит только за балансом DeepSeek и календарём праздников Китая.

## Подключение

- `name = 'dsh-context-governor'`, `inject = ['webServer', 'sessions', 'llm',
  'agentDefaultModel', 'sessionQuery']`.
- `apply(ctx, config)` сливает конфиг профиля поверх `DEFAULTS`.
- `cordis.patch.yml` вставляет узел с id `context-governor`; настройки профиля
  переопределяют его поля тем же id.

## Откуда данные

- Основной путь — сервис `sessionProjections`: проекции `tokenUsage`
  (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`)
  и `contextPressure` (`contextWindow`, `pressureTokens`). Итоги сессии и
  последний шаг берутся из `totals`/`last.buckets`.
- Резерв вывода и ранняя подсказка по окну — события сессии
  `request/header` (`config.maxTokens`, провайдер и модель) и `request/context`.
- Если проекций в сборке нет, токены собираются свёрткой `llm/stream`.
- Окно модели: проекция `contextPressure`, затем каталог `ctx.llm`, затем
  контекст запроса; значение из конфига плагина не подставляется вместо
  неизвестного.

## HTTP

Префикс `/context-governor`, обработчик `ctx.webServer.register`:

- `GET /context-governor/api/status` — снимок сессии: `current`, `children`,
  `season`, `rates`, `warnings`, `config` (порог, окно, резерв, база, провайдер,
  `priced`, `cached`). Параметры: `sessionId`, `refresh`, `lang`, `tz`, `ver`.
- `GET /context-governor/api/balance` — баланс для провайдера сессии.
- `GET /context-governor/api/handoff` — текст сводки сессии. Параметры:
  `sessionId`, `lang`.

Доступ закрыт служебным заголовком `x-dsh-context-governor: 1` и проверкой
Origin: запрос без Origin пропускается, чужой Origin получает 403.

## Порог и полосы

`threshold = min(thresholdRatio * window, window - reserved - headroom)`:

- `thresholdRatio` — 0.8, `headroomTokens` — 65536;
- `reservedTokens` — 0, то есть `maxTokens` запроса из `request/header`;
- `windowTokens` — 0, то есть окно из harness;
- полосы — доли порога из `bandRatios` (0.35, 0.6, 0.85), номер полосы
  считается на хосте и уходит клиенту готовым.

## Тариф и баланс

- Пик — по Пекину (UTC+8), по будням 09:00–12:00 и 14:00–18:00; остальное,
  включая выходные и государственные праздники Китая, — off-peak.
- Ставки — $/1M: `freshRate` 0.15, `cacheReadRate` 0.003, `cacheWriteRate` 0.15,
  `outputRate` 0.6; `peakMultiplier` 2; `base` 100000 для относительной цены.
- Цена считается только для провайдеров со ставками: `pricedProviders`
  (по умолчанию `['deepseek-official']`), id на `deepseek` и записи
  `providerRates` (ставки, `seasonal`, `cached`, `peakMultiplier`).
- Календарь праздников берётся из `holidayUrl` (данные пакета `chinese-days`),
  кэшируется в `<DSH_HOME>/cache/context-governor`, свои даты — конфиг
  `holidays`; `holidayFetch: false` отключает сеть.
- Баланс: сначала сервис `deepseekAccount.getBalance`, затем
  `GET https://api.deepseek.com/user/balance` с ключом из сервиса
  `credentials` (`DEEPSEEK_API_KEY`) или окружения; TTL 60 с, одновременные
  чтения схлопываются. Показывается только на `balanceProviders` и id на
  `deepseek`.

## Handoff

`surfaceDigest(sessionId)` собирает задачу, ход сессии (запрос → итог), текущее
состояние, `cwd` и затронутые файлы, дочерние сессии. К списку файлов
добавляется `git status --porcelain --untracked-files=no` в `cwd`; текст
локализуется en/zh/ru и отдаётся через `/api/handoff`.

## Логи

Старт: источник токенов, окно и тариф. Во время работы: вход в полосу и дорогой
шаг. Коды предупреждений (`cacheHitLow`, `coldPrefill`, `expensiveStep`,
`nearCompaction`, `windowUnknown`, `childrenTokens`, `childrenCount`) уходят
клиенту в `warnings` и переводятся там.

---
sources:
  - index.js
  - cordis.patch.yml
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
  и `contextPressure` (`contextWindow`). Итоги сессии и последний шаг берутся из
  `totals`/`last.buckets`.
- Маршрут сессии (провайдер/модель) и резерв вывода приходят событиями
  `request/header` (`config.maxTokens`) и `request/context`.
- Если проекций в сборке нет, токены собираются свёрткой `llm/stream`.
- Окно и резерв: заданные в конфиге `windowTokens`/`reservedTokens` больше нуля
  приоритетнее harness. Иначе окно — из проекции `contextPressure`, затем из
  `request/context`, затем из каталога `ctx.llm`; резерв — `maxTokens` из
  `request/header`, затем `defaultMaxTokens` каталога. Пока окно неизвестно,
  порог и полосы не выдумываются.

## HTTP

Префикс `/context-governor`, обработчик `ctx.webServer.register`:

- `GET /context-governor/api/status` — снимок сессии: `current`, `children`,
  `season`, `rates`, `warnings`, `config` (база, порог, окно и его источник,
  резерв, маршрут, провайдер, `priced`, `cached`).
- `GET /context-governor/api/balance` — баланс для провайдера сессии.
- `GET /context-governor/api/handoff` — текст сводки сессии.
- `POST /context-governor/api/handoff/take` — перенос задач автоматизации:
  тело `{ from, to }` (id старой и новой сессий). Переназначает на `to` все
  живые задачи расписания (активные и приостановленные), чья цель — `from`;
  завершённые не трогает. Без сервиса `schedule` в сборке отвечает
  `{ ok: true, moved: 0, unavailable: true }`. Другие методы — 405, одинаковые
  id — 400.

Параметры: `sessionId` — сессия; `lang` — язык сводки (en/zh/ru, по умолчанию
en); `tz` — смещение часового пояса в секундах; `ver` — версия клиента для
официального баланса; `refresh=1` — обновить баланс в обход TTL.

Доступ закрыт служебным заголовком `x-dsh-context-governor: 1` и проверкой
Origin: запрос без Origin пропускается, чужой Origin получает 403.

## Порог и полосы

`threshold = min(thresholdRatio * window, window - reserved - headroom)`:

- `thresholdRatio` — 0.8, `headroomTokens` — 65536;
- `reservedTokens` — 0: `maxTokens` запроса из `request/header`, иначе
  `defaultMaxTokens` каталога;
- `windowTokens` — 0: окно из harness (см. «Откуда данные»);
- полосы — доли порога из `bandRatios` (0.35, 0.6, 0.85), номер полосы
  считается на хосте и уходит клиенту готовым.

## Тариф и баланс

- Пик — по Пекину (UTC+8), по будням 09:00–12:00 и 14:00–18:00; остальное,
  включая выходные и государственные праздники Китая, — off-peak.
- Ставки — $/1M: `freshRate` 0.15, `cacheReadRate` 0.003, `cacheWriteRate` 0.15,
  `outputRate` 0.6; `peakMultiplier` 2; `base` 100000 для относительной цены.
- Цена считается только для провайдеров со ставками: `pricedProviders`
  (по умолчанию `['deepseek-official']`), любой id, начинающийся с `deepseek`
  (включая `deepseek-account`), и записи `providerRates` (ставки, `seasonal`,
  `cached`, `peakMultiplier`).
- Календарь праздников берётся из `holidayUrl` (данные пакета `chinese-days`),
  кэшируется в `<DSH_HOME>/cache/context-governor`, свои даты — конфиг
  `holidays`; `holidayFetch: false` отключает сеть.
- Баланс: при `useAccountBalance` и непустом `ver` сначала сервис
  `deepseekAccount` (`getState` — `credential-stored`, затем `getBalance`),
  затем `GET https://api.deepseek.com/user/balance` с ключом из сервиса
  `credentials` (`DEEPSEEK_API_KEY`) или окружения; ответ кэшируется на
  `balanceTtlMs` (60 с), одновременные чтения схлопываются. Показывается только
  на `balanceProviders` и любом id, начинающемся с `deepseek`.

## Handoff

`surfaceDigest(sessionId)` собирает задачу (первый запрос пользователя), ход
сессии (цепочка «запрос → итог»), последнее состояние ассистента, `cwd` и
затронутые файлы. Список файлов дополняется
`git status --porcelain --untracked-files=no` в `cwd`; пути из git
относительны cwd, из `tool/call` — абсолютны, поэтому приводятся к одному виду.
`handoffText` добавляет контекст активной сессии (prompt, полоса, свежие токены,
cache-hit, цена шага), дочерние сессии и правила новой сессии. Текст
локализуется en/zh/ru и отдаётся через `/api/handoff`.

`transferSessionTasks(from, to)` вызывается из `POST /api/handoff/take`, когда
клиент новой сессии вставил сводку в черновик: берёт `schedule.catalog()`,
отбирает задачи со `status !== 'ended'` и целью `{ kind: 'session', sessionId: from }`
и для каждой делает `schedule.edit` с целью `{ kind: 'session', sessionId: to }`.
Активная задача на `from` иначе отказывает в архивации старой сессии, а
«остановить и заархивировать» удаляет её; после переноса архив проходит обычным
путём, а расписание продолжает работать в новой сессии.

## Логи

Старт: окно и тариф модели по умолчанию, источник токенов, загрузка календаря
праздников. Во время работы: вход в полосу, аномальный свежий вход
(`anomalyDelta`) и дорогой шаг (`anomalyCostUsd`). Коды предупреждений
(`cacheHitLow`, `coldPrefill`, `expensiveStep`, `nearCompaction`,
`windowUnknown`, `childrenTokens`, `childrenCount`) уходят клиенту в `warnings`
и переводятся там.

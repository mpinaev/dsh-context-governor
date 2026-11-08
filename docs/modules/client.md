---
sources:
  - client.js
  - package.json
---

# Клиентская половина

`client.js` — браузерный бандл в формате ModuleLoader
(`window.__ModuleLoader__.load({ id: 'dsh-context-governor', factory })`).
Экспортирует `apply` и `inject = ['slots', 'uiWorkspace']`.

## Слоты

- `conversation.session.header.utilities` — бейдж в шапке сессии,
  id `context-governor`, order 30.
- `conversation.composer.dock` — бейдж в строке под композером,
  id `context-governor-composer`, order 20.
- `sidebar.footer.action` — бейдж в низу сайдбара, id
  `context-governor-sidebar`, order 20; из слота приходит `wide`, при
  `wide: false` (свёрнутый сайдбар) рисуется иконка вместо плашки.
- `conversation.input.right` — кнопка compact (id
  `context-governor-compact`, order 89), регистрируется только когда через
  `ctx.inject` доступен `remote.commands`; кнопка handoff (id
  `context-governor-handoff`, order 90) регистрируется всегда.

Бейдж виден в одном слоте: место хранится в
`localStorage: dsh-context-governor.place` (`header`, `composer`, `sidebar`),
кнопка **⇄** в шапке панели переставляет его по кругу. Скрытые копии статус не
опрашивают.

## Данные и панель

- `GET /context-governor/api/status` со служебным заголовком
  `x-dsh-context-governor: 1`; видимый бейдж опрашивает его каждые 5 с,
  кнопка ⟳ запрашивает принудительно (`refresh=1`).
- К запросу добавляются `sessionId`, `lang`, `tz` и версия клиента `ver`.
- Панель показывает prompt, свежий вход, cache-read/cache-write/cache-hit,
  output, цену шага, множитель к базе, окно модели, порог компакции, резерв,
  полосу, тариф с отсчётом, время Пекина, ставки и баланс.
- В сайдбаре из плашки убирается cache-hit — он есть в стандартной строке
  статуса; в свёрнутом сайдбаре остаётся иконка в цвете полосы.
- Языки: **en** (по умолчанию), **zh**, **ru** — кнопка рядом с ⟳,
  выбор в `localStorage: dsh-context-governor.lang` перерисовывает бейдж и
  кнопки.

## Кнопки

- **handoff** — берёт `/api/handoff`, запоминает текст и открывает новую сессию
  в том же рабочем пространстве через `ctx.uiWorkspace.startSession()`; в новой
  сессии компонент в `conversation.input.right` кладёт текст в черновик через
  `inputActions.setDraft` (ожидание живёт 60 с).
- **compact** — `ctx.remote.commands.execute(sessionId, '/compact', [])`; состояния
  «сжимаю», «сжато», «нечего сжимать», «готово», «не удалось», «/compact
  недоступна», «канал команд недоступен».

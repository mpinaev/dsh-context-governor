/**
 * dsh-context-governor — host half.
 *
 * Собирает по каждой сессии реальный размер prompt (свежие + кэш-токены),
 * cache-hit, output и прирост за шаг из проекции harness (tokenUsage), а окно
 * и давление — из contextPressure; если проекций в сборке нет, падает на
 * свёртку llm/stream. Дополнительно
 * строит дерево делегирования (parentSession) и агрегирует вклад дочерних
 * subagent-сессий, баланс DeepSeek и тариф пик/off-peak. Отдаёт
 * /context-governor/api/status, /api/balance и /api/handoff.
 *
 * `sessionQuery` объявлен в inject: без него Cordis не отдаёт сервис и сводка
 * handoff оставалась бы без задачи, состояния и путей (одни заглушки).
 *
 * Ничего не пишет в историю, не меняет системный промпт, не вызывает модель и не
 * тратит токены: нулевой оверхед и никакого влияния на prompt-кэш.
 */

import { execFileSync } from 'node:child_process'

export const name = 'dsh-context-governor'

export const inject = ['webServer', 'sessions', 'llm', 'agentDefaultModel', 'sessionQuery']

/** Служебный заголовок: без него роуты плагина не отвечают. */
const GUARD_HEADER = 'x-dsh-context-governor'

/** Проверка Origin: запрос без Origin (обычный GET с loopback) пропускаем. */
function sameOrigin(req) {
  const headers = (req && req.headers) || {}
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === String(headers.host || '')
  } catch (error) {
    return false
  }
}

const DEFAULTS = {
  /* Измерительная база: 100k свежих токенов = x1.0 относительной стоимости. */
  base: 100000,
  /* Авто-компакция (compaction-basic): резерв вывода запроса и headroom.
     Порог = min(thresholdRatio * окно, окно - резерв - headroom).
     Окно — ТОЛЬКО из настроек модели (резолв маршрута / каталог моделей),
     никогда из конфига плагина: 0 значит «спросить у harness». */
  windowTokens: 0,
  reservedTokens: 0,
  headroomTokens: 65536,
  thresholdRatio: 0.8,
  /* Полосы — доли порога компакции (окно - reserved - headroom). */
  bandRatios: [0.35, 0.6, 0.85],
  /* Цены deepseek-flash off-peak, $ за 1M токенов. Кэш-чтение в 50x дешевле
     свежего входа — именно поэтому абсолютный prompt не равен расходу. */
  freshRate: 0.15,
  cacheReadRate: 0.003,
  /* Запись в кэш: у DeepSeek тарифицируется как обычный вход, поэтому по
     умолчанию равна freshRate. Вынесено отдельной ставкой — когда провайдер
     опубликует точную цену, правится конфигом, без правки кода. */
  cacheWriteRate: 0.15,
  outputRate: 0.6,
  /* Аномалия — по свежим токенам и по стоимости шага. */
  anomalyDelta: 8000,
  anomalyCostUsd: 0.02,
  cacheHitFloorPct: 90,
  /* Тариф DeepSeek: пик — будни 09:00–12:00 и 14:00–18:00 по Пекину (UTC+8),
     вне пика цена вдвое ниже. Ставки выше заданы off-peak; пик = ×peakMultiplier. */
  peakMultiplier: 2,
  /* Баланс DeepSeek: сначала официальный сервис аккаунта harness, иначе
     GET /user/balance; ключ не покидает хост. */
  balanceEnabled: true,
  useAccountBalance: true,
  /* Баланс показываем только на этих провайдерах (плюс любой id, начинающийся
     с deepseek): на cline он подставлял бы чужую сумму и вводил в заблуждение. */
  balanceProviders: ['deepseek-official'],
  balanceTtlMs: 60000,
  balanceTimeoutMs: 15000,
}

/* ── Тариф DeepSeek: пик/off-peak ────────────────────────────────────────────
   Правило опубликовано и фиксировано: пик — по пекинскому времени (UTC+8),
   по будням, 09:00–12:00 и 14:00–18:00. Всё остальное, включая субботу и
   воскресенье целиком, — off-peak и стоит вдвое дешевле. Локальная таймзона
   в решении не участвует, только в отображении. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
const PEAK_BOUNDARIES = [0, 9 * 60, 12 * 60, 14 * 60, 18 * 60]
const DAY_MS = 24 * 60 * 60 * 1000

function isPeak(at) {
  const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return PEAK_WINDOWS.some(function (range) { return minutes >= range[0] && minutes < range[1] })
}

function beijingMidnight(timeMs) {
  const beijing = new Date(timeMs + BEIJING_OFFSET_MS)
  return Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate()) - BEIJING_OFFSET_MS
}

/** Ближайшая РЕАЛЬНАЯ смена тарифа: границы внутри выходных не считаются. */
function nextFlip(at) {
  const from = at.getTime()
  const midnight = beijingMidnight(from)
  const candidates = []
  for (let day = 0; day <= 10; day++) {
    const base = midnight + day * DAY_MS
    for (const minutes of PEAK_BOUNDARIES) candidates.push(base + minutes * 60 * 1000)
  }
  candidates.sort(function (a, b) { return a - b })
  for (const candidate of candidates) {
    if (candidate <= from) continue
    if (isPeak(new Date(candidate)) !== isPeak(new Date(candidate - 1))) return candidate
  }
  return null
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return hours + 'h' + String(minutes).padStart(2, '0') + 'm'
  if (minutes > 0) return minutes + 'm'
  return seconds + 's'
}

function beijingClock(at) {
  const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS)
  const hh = String(beijing.getUTCHours()).padStart(2, '0')
  const mm = String(beijing.getUTCMinutes()).padStart(2, '0')
  /* weekdayIndex — номер дня (0 = воскресенье): строку собирает клиент. */
  return { weekdayIndex: beijing.getUTCDay(), clock: hh + ':' + mm }
}

/** Состояние тарифа на момент времени: пик/off-peak и обратный отсчёт. */
function seasonAt(at, peakMultiplier) {
  const peak = isPeak(at)
  const flip = nextFlip(at)
  const remaining = flip === null ? null : flip - at.getTime()
  const countdown = remaining === null ? '' : formatCountdown(remaining)
  const beijing = beijingClock(at)
  const multiplier = peak ? (peakMultiplier > 0 ? peakMultiplier : 1) : 1
  /* Подписи не формируем: их собирает клиент на выбранном языке. */
  return {
    peak: peak,
    countdown: countdown,
    multiplier: multiplier,
    beijing: beijing,
    color: peak ? '#D9A24A' : '#57C07C',
  }
}

/** Ставки $/1M на момент: off-peak — из конфига, пик — умноженный на сезон. */
function ratesAt(cfg, season) {
  return {
    fresh: cfg.freshRate * season.multiplier,
    cacheRead: cfg.cacheReadRate * season.multiplier,
    cacheWrite: cfg.cacheWriteRate * season.multiplier,
    output: cfg.outputRate * season.multiplier,
  }
}

/* ── Языки сводки handoff ────────────────────────────────────────────────────
   Хост собирает документ на запрошенном языке: lang из query (en/zh/ru, по
   умолчанию en). Тексты интерфейса живут в клиенте; здесь только документ. */
const HANDOFF = {
  en: {
    noTarget: 'Session context is unknown — start a new session and describe the task again.',
    title: '# Handoff from the previous session',
    context: function (cur) { return 'Context: ' + cur.prompt + ' tokens (band ' + cur.band + ', fresh ' + cur.fresh + ', cache-hit ' + cur.cacheHitText + '%, ~$' + cur.costUsd + ' per step).' },
    noContext: 'Context: no request data in this session (plugin started recently).',
    children: function (n, tokens) { return 'Child sessions: ' + n + ', still holding ' + tokens + ' tokens.' },
    task: 'Task: ',
    taskPlaceholder: '<state the task in one line>',
    state: 'State: ',
    statePlaceholder: '<what is done and what remains>',
    files: 'Touched files: ',
    filesPlaceholder: '<list the files>',
    rules: 'Rules for the new session: do not carry the previous history; attach only the needed files.',
  },
  zh: {
    noTarget: '会话上下文未知 — 请新建会话并重新描述任务。',
    title: '# 来自上一会话的交接',
    context: function (cur) { return '上下文：' + cur.prompt + ' tokens（档位 ' + cur.band + '，新输入 ' + cur.fresh + '，缓存命中 ' + cur.cacheHitText + '%，约 $' + cur.costUsd + '/步）。' },
    noContext: '上下文：本会话没有请求数据（插件刚启动）。',
    children: function (n, tokens) { return '子会话：' + n + ' 个，另占约 ' + tokens + ' tokens。' },
    task: '任务：',
    taskPlaceholder: '<用一行说明任务>',
    state: '状态：',
    statePlaceholder: '<已完成与待办>',
    files: '涉及文件：',
    filesPlaceholder: '<列出文件>',
    rules: '新会话规则：不要沿用上一会话的历史；只附上需要的文件。',
  },
  ru: {
    noTarget: 'Контекст сессии неизвестен — начни новую сессию и опиши задачу заново.',
    title: '# Handoff из предыдущей сессии',
    context: function (cur) { return 'Контекст: ' + cur.prompt + ' токенов (полоса ' + cur.band + ', свежих ' + cur.fresh + ', cache-hit ' + cur.cacheHitText + '%, ~$' + cur.costUsd + ' за шаг).' },
    noContext: 'Контекст: нет данных о запросах в этой сессии (плагин запущен недавно).',
    children: function (n, tokens) { return 'Дочерних сессий: ' + n + ', суммарно ещё ' + tokens + ' токенов.' },
    task: 'Задача: ',
    taskPlaceholder: '<сформулируй задачу одной строкой>',
    state: 'Состояние: ',
    statePlaceholder: '<что сделано и что осталось>',
    files: 'Затронутые файлы: ',
    filesPlaceholder: '<укажи файлы>',
    rules: 'Правила новой сессии: не тянуть историю прошлой; приложить только нужные файлы.',
  },
}

/** en (по умолчанию), zh, ru; всё незнакомое — en. */
function normalizeLang(lang) {
  const value = String(lang || '').toLowerCase()
  if (value === 'ru') return 'ru'
  if (value === 'zh' || value === 'cn' || value === 'zh-cn') return 'zh'
  return 'en'
}

/* ── Cache-hit: честный процент как у harness ────────────────────────────────
   Копия formatCacheHitPercent из @deepseek-ai/dsh-client-ui-chat: частичное
   попадание нельзя округлять до 100. У DeepSeek 99.97% — норма: 177 свежих
   токенов на 535k prompt. Math.round превращал их в «100%» и чип врал.
   Когда целое округление даёт 100, добавляем знаки, пока результат не станет
   честно меньше 100. Единицы измерения — сотые доли процента при dp=0. */
function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
  const scale = (decimalPlaces === 0 ? 1 : 10) * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

function displayPercentUnits(units, decimalPlaces) {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : whole + '.' + tenths
}

/** Готовая доля prompt, отданная из кэша на чтение: '86', '99.8', '100'.
    null — считать не из чего (пустой prompt). */
function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
  if (promptTokens === 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  if (roundedUnits < (decimalPlaces === 0 ? 100 : 1000)) return displayPercentUnits(roundedUnits, decimalPlaces)
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return '99.' + '9'.repeat(distinguishingPlaces - 1) + (10 - roundedLoss)
}

/** Целый процент для порогов: 100 — только за полное попадание, иначе максимум
    99, чтобы дробное попадание не выглядело полным. */
function cacheHitWholePercent(cacheReadTokens, promptTokens) {
  if (promptTokens <= 0) return 0
  if (cacheReadTokens >= promptTokens) return 100
  return Math.min(99, Math.round((cacheReadTokens / promptTokens) * 100))
}

export function apply(ctx, config = {}) {
  const cfg = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  const ratios = Array.isArray(cfg.bandRatios) && cfg.bandRatios.length === 3 ? cfg.bandRatios : DEFAULTS.bandRatios
  const sessions = new Map()

  /* Маршрут (провайдер/модель) -> ёмкость и резерв вывода, как их видит harness.
     window/reserved берём из резолва маршрута (событие request/context и
     request/header в session/event) либо из каталога моделей ctx.llm. */
  const routes = new Map()
  const sessionRoute = new Map()
  /* Окно и резерв — ПО СЕССИЯМ: чужой маршрут подставлять нельзя. */
  const sessionWindow = new Map()
  const sessionReserved = new Map()

  function routeKey(provider, model) {
    return String(provider || '?') + '/' + String(model || '?')
  }

  /** Запомнить/уточнить известный маршрут (только для справки в панели).
      Нулевые значения не пишем: подсказка каталога не должна затирать резолв. */
  function mergeRoute(provider, model, patch) {
    if (!provider || !model) return
    const key = routeKey(provider, model)
    const prev = routes.get(key) || { provider: provider, model: model, window: 0, reserved: 0, source: '' }
    const next = Object.assign({}, prev)
    if (Number.isInteger(patch.window) && patch.window > 0) next.window = patch.window
    if (Number.isInteger(patch.reserved) && patch.reserved > 0) next.reserved = patch.reserved
    if (patch.source) next.source = patch.source
    routes.set(key, next)
  }

  /** Ёмкость ИМЕННО этой сессии. Чужой маршрут не подставляем: иначе сессия
      на другой модели показывала бы порог предыдущей (тот самый «прилипший»
      678 464 от deepseek). Нет своего окна — значит окно неизвестно. */
  function routeCapacity(sessionId) {
    const sid = sessionId !== undefined && sessionId !== null ? String(sessionId) : ''
    const key = sid ? sessionRoute.get(sid) : undefined
    const route = key ? routes.get(key) : null
    const ownWindow = sid ? sessionWindow.get(sid) : 0
    const ownReserved = sid ? sessionReserved.get(sid) : 0
    const windowTokens = cfg.windowTokens > 0
      ? cfg.windowTokens
      : (ownWindow > 0 ? ownWindow : (route ? route.window : 0))
    const reservedTokens = cfg.reservedTokens > 0
      ? cfg.reservedTokens
      : (ownReserved > 0 ? ownReserved : (route ? route.reserved : 0))
    const pressureBudget = windowTokens - reservedTokens - cfg.headroomTokens
    const compactThreshold = windowTokens > 0 && pressureBudget > 0
      ? Math.floor(Math.min(windowTokens * cfg.thresholdRatio, pressureBudget))
      : 0
    /* Полосы не выдумываем: пока окно неизвестно, их нет — клиент покажет «?». */
    const bands = compactThreshold > 0
      ? ratios.map(function (ratio) { return Math.round(compactThreshold * ratio) })
      : []
    return {
      route: route ? routeKey(route.provider, route.model) : '',
      source: route ? route.source : '',
      windowTokens: windowTokens,
      reservedTokens: reservedTokens,
      compactThreshold: compactThreshold,
      bands: bands,
      known: windowTokens > 0,
    }
  }

  function bandOf(prompt, bands) {
    let b = 0
    for (let i = 0; i < bands.length; i++) if (prompt >= bands[i]) b = i + 1
    return b
  }

  function log(message) {
    try {
      if (typeof ctx.logger === 'function') ctx.logger('context-governor').info(message)
    } catch (error) {
      /* логгер недоступен — пишем в stdout ниже */
    }
    console.log('[context-governor] ' + message)
  }

  /* ── Баланс DeepSeek ────────────────────────────────────────────────────────
     Ключ резолвится через credentials-seam, затем из окружения; на клиент
     уходят только числа. Ответ кэшируется, параллельные чтения схлопываются. */
  let balanceCache = null
  let balanceInflight = null

  function credentialsService() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    } catch (error) {
      return undefined
    }
  }

  async function resolveDeepseekKey() {
    try {
      const svc = credentialsService()
      if (svc && typeof svc.resolve === 'function') {
        const resolved = await svc.resolve('DEEPSEEK_API_KEY')
        if (resolved && resolved.value) return resolved.value
      }
    } catch (error) {
      /* падаем в окружение */
    }
    return process.env.DEEPSEEK_API_KEY || ''
  }

  function readBalance(parsed) {
    const info = Array.isArray(parsed && parsed.balance_infos) ? parsed.balance_infos[0] : undefined
    if (info === undefined) return { ok: false, state: 'empty', error: 'balance response carried no balance_infos' }
    return {
      ok: true,
      state: 'ok',
      source: 'api-key',
      at: new Date().toISOString(),
      currency: String(info.currency || ''),
      isAvailable: parsed && parsed.is_available === true,
      total: Number(info.total_balance || 0),
      granted: Number(info.granted_balance || 0),
      toppedUp: Number(info.topped_up_balance || 0),
    }
  }

  /** Официальный баланс аккаунта платформы DeepSeek через сервис harness.
      Требует вход в аккаунт И непустой client version (клиент шлёт его в query).
      Нет сервиса, нет входа или нет версии — возвращаем null и работаем по
      API-ключу, как раньше: фича не должна ломаться из-за чужой сборки. */
  async function loadAccountBalance(clientMeta) {
    if (!cfg.useAccountBalance) return null
    let svc
    try {
      svc = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
    } catch (error) {
      svc = undefined
    }
    if (!svc || typeof svc.getBalance !== 'function') return null
    if (!clientMeta || !clientMeta.version) return null
    try {
      if (typeof svc.getState === 'function') {
        const state = await svc.getState()
        if (!state || state.status !== 'credential-stored') return null
      }
      const details = await svc.getBalance(clientMeta)
      if (!details || details.status !== 'ready' || !details.value) return null
      const wallets = Array.isArray(details.value) ? details.value : []
      const bonuses = Array.isArray(details.bonusWallets) ? details.bonusWallets : []
      if (wallets.length === 0) return null
      const currency = String(wallets[0].currency || '')
      /* Кошельки приходят строками и могут быть в разных валютах — суммируем
         только валюту первого кошелька, чтобы не складывать юани с долларами. */
      const sum = function (items) {
        let total = 0
        for (const item of items) {
          if (String(item && item.currency || '') === currency) total += Number(item && item.balance || 0)
        }
        return total
      }
      const total = sum(wallets)
      const granted = sum(bonuses)
      return {
        ok: true,
        state: 'ok',
        source: 'account',
        at: new Date().toISOString(),
        currency: currency,
        isAvailable: true,
        total: Math.round(total * 100) / 100,
        granted: Math.round(granted * 100) / 100,
        toppedUp: Math.round(Math.max(0, total - granted) * 100) / 100,
      }
    } catch (error) {
      return null
    }
  }

  async function loadBalance(clientMeta) {
    const fromAccount = await loadAccountBalance(clientMeta)
    if (fromAccount) return fromAccount
    const key = await resolveDeepseekKey()
    if (!key) return { ok: false, state: 'no-credential', error: 'DEEPSEEK_API_KEY is not configured' }
    const controller = new AbortController()
    const timer = setTimeout(function () { controller.abort() }, cfg.balanceTimeoutMs)
    try {
      const response = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) return { ok: false, state: 'error', error: 'HTTP ' + response.status + ': ' + text.slice(0, 200) }
      return readBalance(JSON.parse(text))
    } catch (error) {
      return { ok: false, state: 'error', error: String((error && error.message) || error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Баланс DeepSeek уместен только на его собственных провайдерах. */
  function balanceAllowedFor(provider) {
    const list = Array.isArray(cfg.balanceProviders) ? cfg.balanceProviders : DEFAULTS.balanceProviders
    const value = String(provider || '')
    if (!value) return false
    for (const item of list) if (String(item) === value) return true
    return value.indexOf('deepseek') === 0
  }

  function balance(force, clientMeta) {
    if (!cfg.balanceEnabled) return Promise.resolve({ ok: false, state: 'disabled' })
    if (!force && balanceCache && Date.now() - balanceCache.fetchedAt < cfg.balanceTtlMs) {
      return Promise.resolve(balanceCache.value)
    }
    if (balanceInflight) return balanceInflight
    balanceInflight = loadBalance(clientMeta)
      .then(function (value) {
        balanceCache = { fetchedAt: Date.now(), value: value }
        return value
      })
      .catch(function (error) {
        return { ok: false, state: 'error', error: String((error && error.message) || error) }
      })
      .then(function (value) {
        balanceInflight = null
        return value
      })
    return balanceInflight
  }

  /** Ёмкость маршрута из каталога моделей harness (нужна до первого запроса).
      Заполняет только пустые поля: резолв живого запроса точнее каталога. */
  function resolveRouteFromCatalog(provider, model) {
    let svc
    try {
      svc = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    } catch (error) {
      svc = undefined
    }
    if (!svc || typeof svc.resolveModelInfo !== 'function' || !provider || !model) return
    const known = routes.get(routeKey(provider, model))
    Promise.resolve()
      .then(function () { return svc.resolveModelInfo(provider, model) })
      .then(function (info) {
        if (!info) return
        const window = info.context && Number.isInteger(info.context.contextWindow) ? info.context.contextWindow : 0
        const reserved = Number.isInteger(info.defaultMaxTokens) ? info.defaultMaxTokens : 0
        const patch = {
          window: known && known.window > 0 ? 0 : window,
          reserved: known && known.reserved > 0 ? 0 : reserved,
          /* Источник — стабильный код, а не готовый текст: язык выбирает
             клиент, иначе «каталог» остаётся русским в en и zh. */
          source: 'catalog',
        }
        mergeRoute(provider, model, patch)
        const merged = routes.get(routeKey(provider, model))
        log('каталог моделей ' + provider + '/' + model + ': окно ' + window + ', резерв ' + reserved +
          '; в работе окно ' + (merged ? merged.window : 0) + ', резерв ' + (merged ? merged.reserved : 0))
      })
      .catch(function () { /* каталог недоступен — остаётся резолв запроса */ })
  }

  /* Резерв запроса и подсказка по окну приходят событиями сессии. Окно
     авторитетно берётся из проекции contextPressure; здесь — только резерв
     (maxTokens запроса) и ранняя подсказка, пока проекция не прогрелась. */
  ctx.on('session/event', function (session, event) {
    const type = event && event.type
    const data = (event && event.data) || {}
    const sessionId = session && session.header && session.header.id ? String(session.header.id) : ''
    if (!sessionId) return
    if (type === 'request/context') {
      if (data.provider && data.model) {
        sessionRoute.set(sessionId, routeKey(data.provider, data.model))
        if (Number.isInteger(data.contextWindow) && data.contextWindow > 0 && !sessionWindow.has(sessionId)) {
          sessionWindow.set(sessionId, data.contextWindow)
        }
        mergeRoute(data.provider, data.model, {
          window: Number.isInteger(data.contextWindow) ? data.contextWindow : 0,
          source: 'request',
        })
      }
      return
    }
    if (type === 'request/header') {
      const config = data.header && data.header.config ? data.header.config : (data.config || {})
      const provider = config.provider
      const model = config.model
      if (!provider || !model) return
      sessionRoute.set(sessionId, routeKey(provider, model))
      if (Number.isInteger(config.maxTokens) && config.maxTokens > 0) {
        sessionReserved.set(sessionId, config.maxTokens)
      }
      mergeRoute(provider, model, {
        reserved: Number.isInteger(config.maxTokens) ? config.maxTokens : 0,
        source: 'request',
      })
      resolveRouteFromCatalog(provider, model)
    }
  })

  /* ── Источник токенов ──────────────────────────────────────────────────────
     Основной путь — авторитетные проекции harness: tokenUsage (uncached /
     cacheRead / cacheWrite / output) и contextPressure (окно и давление). Они
     переживают пейджинг и компакцию и корректно закрывают слот при ретрае
     (llm/retry-started), поэтому повторная попытка не удваивает токены.
     Если проекций в сборке нет — работает прежняя свёртка llm/stream. */

  function projectionsService() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
    } catch (error) {
      return undefined
    }
  }

  /** Одна запись шага из уже разложенных по ведрам токенов. sessionBuckets —
      итоги сессии из проекции harness (для cache-hit), необязательны. */
  function recordStep(sid, buckets, sessionBuckets) {
    const input = buckets.input || 0
    const cacheRead = buckets.cacheRead || 0
    const cacheWrite = buckets.cacheWrite || 0
    const output = buckets.output || 0
    const cached = cacheRead + cacheWrite
    const prompt = input + cached
    if (!sid || prompt <= 0) return
    const prev = sessions.get(sid)
    const cap = routeCapacity(sid)
    const at = new Date()
    const season = seasonAt(at, cfg.peakMultiplier)
    const rate = ratesAt(cfg, season)
    /* Cache-hit — доля prompt, отданная из кэша на чтение; запись в кэш хитом
       не является. Считаем по ИТОГАМ сессии, как чип harness («Cache hit»), —
       иначе последний шаг почти всегда «100%» и цифра расходится с harness.
       Если итогов нет (свёртка llm/stream), берём сам шаг. */
    const sum = sessionBuckets || { input: input, cacheRead: cacheRead, cacheWrite: cacheWrite }
    const sumPrompt = (sum.input || 0) + (sum.cacheRead || 0) + (sum.cacheWrite || 0)
    /* Три входных ведра считаются по СВОИМ ставкам: кэш-чтение в 50x дешевле
       свежего входа, а запись в кэш у DeepSeek стоит как обычный вход. */
    const costUsd = (input * rate.fresh + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite + output * rate.output) / 1000000
    const rec = {
      session: sid,
      prompt: prompt,
      fresh: input,
      cacheRead: cacheRead,
      cacheWrite: cacheWrite,
      output: output,
      freshDelta: prev ? input - prev.fresh : input,
      cacheHitPct: cacheHitWholePercent(sum.cacheRead || 0, sumPrompt),
      cacheHitText: formatCacheHitPercent(sum.cacheRead || 0, sumPrompt) || '0',
      relative: Math.round(((input + cacheRead * (cfg.cacheReadRate / cfg.freshRate) + cacheWrite * (cfg.cacheWriteRate / cfg.freshRate)) / cfg.base) * 1000) / 1000,
      costUsd: Math.round(costUsd * 1000000) / 1000000,
      band: bandOf(prompt, cap.bands),
      ts: Date.now(),
    }
    sessions.set(sid, rec)
    const prevBand = prev ? prev.band : 0
    if (rec.band > prevBand) {
      log('полоса ' + rec.band + ': контекст ' + prompt + ' (x' + rec.relative + ' по цене, ~$' + rec.costUsd + '/шаг), сессия ' + sid)
    }
    if (rec.freshDelta >= cfg.anomalyDelta) {
      log('аномальный свежий вход +' + rec.freshDelta + ' за шаг (контекст ' + prompt + '), сессия ' + sid)
    }
    if (costUsd >= cfg.anomalyCostUsd) {
      log('дорогой шаг $' + rec.costUsd + ' (свежих ' + input + ', чтение ' + cacheRead + ', запись ' + cacheWrite + ', output ' + output + '), сессия ' + sid)
    }
    if (sessions.size > 64) {
      const oldest = [...sessions.keys()].slice(0, sessions.size - 64)
      for (const key of oldest) sessions.delete(key)
    }
  }

  /** Свежие токены и окно сессии прямо из проекций harness. */
  function recordFromProjection(session) {
    const svc = projectionsService()
    if (!svc || typeof svc.stateOf !== 'function' || !session) return
    const sid = session.header && session.header.id ? String(session.header.id) : ''
    if (!sid) return
    let usage
    let pressure
    try { usage = svc.stateOf(session, 'tokenUsage') } catch (error) { usage = undefined }
    try { pressure = svc.stateOf(session, 'contextPressure') } catch (error) { pressure = undefined }
    if (pressure && Number.isInteger(pressure.contextWindow) && pressure.contextWindow > 0) {
      sessionWindow.set(sid, pressure.contextWindow)
    }
    /* Проекция отдаёт либо состояние {totals,last}, либо сразу плоские вёдра
       wire-вида. Шаг нужен для окна и цены, итоги — для честного cache-hit. */
    const step = usage && usage.last && usage.last.buckets
      ? usage.last.buckets
      : (usage && usage.totals ? usage.totals : usage)
    const totals = usage && usage.totals
      ? usage.totals
      : (usage && usage.last ? null : usage)
    if (!step) return
    recordStep(sid, {
      input: Number(step.uncachedInputTokens) || 0,
      cacheRead: Number(step.cacheReadTokens) || 0,
      cacheWrite: Number(step.cacheWriteTokens) || 0,
      output: Number(step.outputTokens) || 0,
    }, totals ? {
      input: Number(totals.uncachedInputTokens) || 0,
      cacheRead: Number(totals.cacheReadTokens) || 0,
      cacheWrite: Number(totals.cacheWriteTokens) || 0,
    } : null)
  }

  const projectionSvc = projectionsService()
  if (projectionSvc && typeof projectionSvc.onChanged === 'function') {
    const unsubscribe = projectionSvc.onChanged(function (session, key) {
      if (key === 'tokenUsage' || key === 'contextPressure') recordFromProjection(session)
    })
    if (typeof ctx.effect === 'function') {
      ctx.effect(function () {
        return function () { try { unsubscribe() } catch (error) { /* уже снят */ } }
      }, 'context-governor: session projections')
    }
    log('источник токенов: проекции harness (tokenUsage + contextPressure)')
  } else {
    log('источник токенов: свёртка llm/stream (проекции harness недоступны)')
    ctx.on('llm/stream', function (options, next) {
      const opts = options && typeof options === 'object' ? options : {}
      const sid = opts.sessionId ? String(opts.sessionId) : ''
      const aux = Boolean(opts.purpose)
      let input = 0
      let cacheRead = 0
      let cacheWrite = 0
      let output = 0
      const observe = function (chunk) {
        if (!chunk || chunk.type !== 'usage' || !chunk.usage) return
        input += chunk.usage.inputTokens || 0
        cacheRead += chunk.usage.cacheReadTokens || 0
        cacheWrite += chunk.usage.cacheWriteTokens || 0
        output += chunk.usage.outputTokens || 0
      }
      const inner = next()
      return (async function* tracked() {
        try {
          for await (const chunk of inner) {
            observe(chunk)
            yield chunk
          }
        } finally {
          if (!aux) recordStep(sid, { input: input, cacheRead: cacheRead, cacheWrite: cacheWrite, output: output })
        }
      })()
    })
  }

  /** Дерево сессий из реестра: id -> { parent, origin, depth }. */
  function lineage() {
    const map = new Map()
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      const list = svc && typeof svc.list === 'function' ? svc.list() : []
      for (const item of list) {
        if (!item) continue
        const h = item.header && item.header.id ? item.header : item
        if (!h || typeof h.id !== 'string') continue
        map.set(h.id, {
          id: h.id,
          parent: typeof h.parentSession === 'string' ? h.parentSession : null,
          origin: typeof h.origin === 'string' ? h.origin : h.parentSession ? 'subagent' : 'root',
          depth: Number.isInteger(h.delegationDepth) ? h.delegationDepth : 0,
          createdAt: typeof h.createdAt === 'number' ? h.createdAt : 0,
        })
      }
    } catch (error) {
      /* реестр недоступен — работаем без дерева */
    }
    return map
  }

  function childrenOf(meta, sessionId) {
    const result = []
    for (const item of meta.values()) {
      if (item.parent === sessionId) result.push(item)
    }
    return result
  }

  function snapshot(preferId) {
    const list = [...sessions.values()].sort(function (a, b) { return b.ts - a.ts })
    let current = list.length > 0 ? list[0] : null
    if (preferId) {
      /* Метрики именно этой сессии; чужую подставлять нельзя — иначе клиент
         решит, что контекст мал, и не начнёт новую сессию. */
      current = list.find(function (item) { return item.session === preferId }) || null
    }
    let children = []
    let childrenPromptSum = 0
    const now = Date.now()
    if (current) {
      const meta = lineage()
      const kids = childrenOf(meta, current.session)
      for (const kid of kids) {
        const rec = sessions.get(kid.id)
        if (rec) childrenPromptSum += rec.prompt
        children.push({
          session: kid.id,
          origin: kid.origin,
          depth: kid.depth,
          prompt: rec ? rec.prompt : null,
          band: rec ? rec.band : null,
          ts: rec ? rec.ts : null,
        })
      }
      children.sort(function (a, b) { return (b.prompt || 0) - (a.prompt || 0) })
    }
    const warnings = []
    const season = seasonAt(new Date(now), cfg.peakMultiplier)
    const rates = ratesAt(cfg, season)
    const cap = routeCapacity(current ? current.session : undefined)
    /* Провайдер активной сессии: по нему решаем, показывать ли баланс DeepSeek.
       Если своей сессии ещё нет — берём выбранную модель по умолчанию. */
    const routeParts = cap.route ? cap.route.split('/') : []
    let activeProvider = routeParts.length > 0 ? routeParts[0] : ''
    if (!activeProvider && !preferId) {
      try {
        const picker = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
        if (picker && typeof picker.currentSelection === 'function') {
          const pick = picker.currentSelection()
          if (pick && pick.provider) activeProvider = String(pick.provider)
        }
      } catch (error) { /* останется пустым — баланс скрыт */ }
    }
    if (current) {
      /* Сигналы траты — не размер контекста, а свежие токены и провал кэша:
         при 99% cache-hit абсолютный prompt стоит копейки (кэш в 50x дешевле). */
      /* Предупреждения — кодами: текст собирает клиент на своём языке. */
      if (current.cacheHitPct < cfg.cacheHitFloorPct) {
        warnings.push({ code: 'cacheHitLow', pct: current.cacheHitPct, floor: cfg.cacheHitFloorPct })
      }
      if (current.freshDelta >= cfg.anomalyDelta || current.fresh >= cfg.base) {
        warnings.push({ code: 'coldPrefill', fresh: current.fresh, usd: Number(((current.fresh * rates.fresh) / 1000000).toFixed(4)) })
      }
      if (current.costUsd >= cfg.anomalyCostUsd) warnings.push({ code: 'expensiveStep', usd: current.costUsd })
      if (cap.compactThreshold > 0 && current.prompt >= cap.compactThreshold * 0.9) {
        warnings.push({ code: 'nearCompaction', prompt: current.prompt, threshold: cap.compactThreshold })
      }
      if (!cap.known) warnings.push({ code: 'windowUnknown' })
      if (childrenPromptSum >= cfg.base) warnings.push({ code: 'childrenTokens', tokens: childrenPromptSum })
      if (children.length > 0 && current.band >= 1) warnings.push({ code: 'childrenCount', count: children.length })
    }
    return {
      ok: true,
      config: {
        /* base нужен клиенту для строки «относительно базы»; порог и окно —
           для строк «порог компакции» и «окно модели». Полосы клиент не читает:
           он получает номер полосы готовым числом в current.band. */
        base: cfg.base,
        compactThreshold: cap.compactThreshold,
        windowTokens: cap.windowTokens,
        reservedTokens: cap.reservedTokens,
        route: cap.route,
        windowSource: cap.source,
        provider: activeProvider,
      },
      current: current,
      children: children,
      childrenPromptSum: childrenPromptSum,
      season: season,
      rates: rates,
      warnings: warnings,
    }
  }

  /** Пути файлов из аргументов вызова инструмента (включая run_code с кодом). */
  function callPaths(data) {
    let args = data.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch (error) { args = undefined }
    }
    const found = []
    const push = function (value) {
      if (typeof value !== 'string') return
      const item = value.trim()
      if (item.length === 0 || item.length > 300 || found.indexOf(item) !== -1) return
      found.push(item)
    }
    if (args && typeof args === 'object') {
      for (const key of ['file_path', 'filePath', 'path', 'file']) push(args[key])
      for (const key of ['paths', 'files']) {
        const value = args[key]
        if (Array.isArray(value)) for (const item of value) push(item)
      }
    }
    const raw = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(args || {})
    let match
    const keyed = /(?:file_path|filePath|"path"|'path')\s*[:=]\s*["']([^"']+)["']/g
    while ((match = keyed.exec(raw)) !== null) push(match[1])
    const liked = /\/[\w./-]+\.(?:ts|tsx|js|mjs|cjs|py|md|json|ya?ml|toml|sh|sql|css|html)\b/g
    while ((match = liked.exec(raw)) !== null) push(match[0])
    return found.slice(0, 10)
  }

  /** Разбор семантического документа события: имя инструмента и строка аргументов. */
  function splitCall(text) {
    const value = String(text || '')
    const nl = value.indexOf('\n')
    return { name: (nl === -1 ? value : value.slice(0, nl)).trim(), args: nl === -1 ? '' : value.slice(nl + 1) }
  }

  /** Пути, которые инструмент именно меняет (write/edit), включая вызовы внутри run_code. */
  function editedPaths(text) {
    const found = []
    const push = function (value) {
      const item = String(value || '').trim()
      if (item.length === 0 || item.length > 300 || found.indexOf(item) !== -1) return
      found.push(item)
    }
    const call = splitCall(text)
    if (/^(?:write|write_file|edit|multi_edit|apply_patch)$/i.test(call.name)) {
      let direct
      const top = /"(?:file_path|filePath|path)"\s*:\s*"([^"]+)"/g
      while ((direct = top.exec(call.args)) !== null) push(direct[1])
    }
    const clean = call.args.replace(/\\(["'`])/g, '$1')
    let match
    const nested = /tools\.(?:write|write_file|edit|multi_edit|apply_patch)\s*\(\s*\{[\s\S]{0,20000}?file_path\s*:\s*["']([^"']+)["']/g
    while ((match = nested.exec(clean)) !== null) push(match[1])
    return found
  }

  /** Служебные каталоги, которые не считаем затронутыми файлами. */
  function noisePath(path) {
    return /^\/(?:tmp|var\/tmp|proc|dev|sys)\//.test(path)
      || path.indexOf('/usr/lib/') === 0
      || /(^|\/)node_modules\//.test(path)
      || path.indexOf('dsh-spill') !== -1
  }

  /** Текст одного сообщения поверхности (только текстовые блоки). */
  function messageText(message) {
    if (!message || !Array.isArray(message.content)) return ''
    const parts = []
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  function clip(text, limit) {
    const one = String(text || '').replace(/\s+/g, ' ').trim()
    return one.length > limit ? one.slice(0, limit - 1) + '…' : one
  }

  /** Последняя задача пользователя и последнее состояние ассистента + cwd. */
  async function surfaceDigest(sessionId) {
    const out = { task: '', state: '', cwd: '', touched: [] }
    try {
      const sq = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
      if (!sq || typeof sq.readSurface !== 'function') return out
      const surface = await sq.readSurface(sessionId)
      if (surface && surface.session && typeof surface.session.cwd === 'string') out.cwd = surface.session.cwd
      const events = Array.isArray(surface && surface.events) ? surface.events : []
      const touched = []
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        const type = event && event.type
        const data = (event && event.data) || {}
        /* tool/call не входит в surface (только сообщения и tool/result) — пути берём из сырого лога ниже */
        if (type !== 'user/message' && type !== 'assistant/message') continue
        const text = type === 'user/message' ? messageText(data) : messageText(data.message)
        if (!text) continue
        if (type === 'user/message' && !out.task) out.task = text
        if (type === 'assistant/message' && !out.state) out.state = text
        if (out.task && out.state) break
      }
      const edits = []
      const fallback = []
      try {
        if (typeof sq.filterEvents === 'function') {
          const docs = await sq.filterEvents(sessionId, [{ kind: 'type', values: ['tool/call'] }])
          for (let i = docs.length - 1; i >= 0; i--) {
            const text = (docs[i] && docs[i].text) || ''
            if (!text) continue
            for (const path of editedPaths(text)) {
              if (edits.indexOf(path) === -1 && edits.length < 20) edits.push(path)
            }
            for (const path of callPaths({ arguments: splitCall(text).args })) {
              if (fallback.indexOf(path) === -1 && fallback.length < 20) fallback.push(path)
            }
          }
        }
      } catch (error) {
        /* сырой лог недоступен — путей не будет */
      }
      const files = edits.length > 0 ? edits : fallback
      for (const path of files) {
        if (!noisePath(path) && touched.indexOf(path) === -1 && touched.length < 10) touched.push(path)
      }
      out.touched = touched
    } catch (error) {
      /* поверхность недоступна — останутся заглушки */
    }
    return out
  }

  /** Изменённые файлы рабочего каталога сессии (best-effort, без сети). */
  function changedFiles(cwd) {
    if (!cwd || typeof cwd !== 'string') return []
    try {
      const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=no'], { timeout: 2000, encoding: 'utf8' })
      return out.split('\n').map((line) => line.slice(3).trim()).filter((line) => line.length > 0).slice(0, 12)
    } catch (error) {
      return []
    }
  }

  async function handoffText(preferId, lang) {
    const t = HANDOFF[normalizeLang(lang)]
    const snap = snapshot(preferId)
    const cur = snap.current
    const target = preferId || (cur ? cur.session : '')
    if (!target) return t.noTarget
    const digest = await surfaceDigest(target)
    const gitFiles = changedFiles(digest.cwd)
    const files = []
    for (const item of gitFiles.concat(digest.touched || [])) if (item && files.indexOf(item) === -1) files.push(item)
    const lines = []
    lines.push(t.title)
    lines.push('')
    lines.push(cur ? t.context(cur) : t.noContext)
    if (cur && snap.children.length > 0) lines.push(t.children(snap.children.length, snap.childrenPromptSum))
    lines.push('')
    lines.push(t.task + (digest.task ? clip(digest.task, 400) : t.taskPlaceholder))
    lines.push('')
    lines.push(t.state + (digest.state ? clip(digest.state, 900) : t.statePlaceholder))
    lines.push('')
    lines.push(t.files + (files.length > 0 ? files.join(', ') : t.filesPlaceholder))
    lines.push('')
    lines.push(t.rules)
    return lines.join('\n')
  }

  function parseQuery(url) {
    const out = {}
    const text = String(url || '')
    const index = text.indexOf('?')
    if (index === -1) return out
    for (const part of text.slice(index + 1).split('&')) {
      if (!part) continue
      const eq = part.indexOf('=')
      const key = eq === -1 ? part : part.slice(0, eq)
      out[key] = eq === -1 ? '' : decodeURIComponent(part.slice(eq + 1))
    }
    return out
  }

  function handler(req, res) {
    const headers = (req && req.headers) || {}
    const url = String((req && req.url) || '')
    const query = parseQuery(url)
    const send = function (payload, status) {
      res.statusCode = status || 200
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    /* Роуты отдают метрики сессий, пути файлов и баланс аккаунта, поэтому
       закрыты служебным заголовком и проверкой Origin: обязательный заголовок
       (его ставит только наш клиент) и проверка same-origin. Чужой сайт
       нестандартный заголовок подделать не может — это требует preflight,
       которого сервер не даёт. */
    if (String(headers[GUARD_HEADER] || '') !== '1') {
      return send({ ok: false, state: 'forbidden', error: 'missing plugin header' }, 403)
    }
    if (!sameOrigin(req)) {
      return send({ ok: false, state: 'forbidden', error: 'cross-origin request rejected' }, 403)
    }
    /* Идентичность UI для официального баланса: версию и таймзону присылает
       клиент, язык берём из того же query (en/zh/ru). Пустая версия — значит
       официальный путь пропускаем и идём по API-ключу. */
    const clientMeta = {
      version: typeof query.ver === 'string' ? query.ver : '',
      locale: normalizeLang(query.lang),
      timezoneOffsetSeconds: Number.isFinite(Number(query.tz)) ? Number(query.tz) : 0,
    }
    const snap = snapshot(query.sessionId)
    /* Баланс подмешиваем только когда активна модель DeepSeek: на cline чужая
       сумма в чипе — прямая дезинформация. */
    const withBalance = balanceAllowedFor(snap.config.provider)
      ? balance(query.refresh === '1', clientMeta)
      : Promise.resolve({ ok: false, state: 'other-provider', provider: snap.config.provider })
    if (url.indexOf('/api/balance') !== -1) {
      withBalance.then(function (payload) { send({ ok: true, balance: payload }) })
      return
    }
    if (url.indexOf('/api/status') !== -1) {
      withBalance.then(function (payload) {
        send(Object.assign(snap, { balance: payload }))
      })
      return
    }
    if (url.indexOf('/api/handoff') !== -1) {
      handoffText(query.sessionId, query.lang).then(function (text) { send({ ok: true, text: text }) }, function (error) {
        send({ ok: false, error: String((error && error.message) || error) }, 500)
      })
      return
    }
    send({ ok: false, error: 'unknown endpoint' }, 404)
  }

  ctx.webServer.register({ kind: 'prefix', path: '/context-governor', handler })

  /** Стартовый резолв: окно модели по умолчанию из настроек harness. */
  function bootstrapDefaultRoute() {
    let selection = null
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
      if (svc && typeof svc.currentSelection === 'function') selection = svc.currentSelection()
    } catch (error) {
      selection = null
    }
    if (!selection || !selection.provider || !selection.model) {
      log('ready: модель по умолчанию неизвестна; окно возьмём из резолва первого запроса')
      return
    }
    resolveRouteFromCatalog(selection.provider, selection.model)
  }

  if (cfg.windowTokens > 0) {
    const cap = routeCapacity(undefined)
    log('ready: окно задано конфигом плагина ' + cfg.windowTokens + ', порог компакции ' + cap.compactThreshold + ', полосы ' + cap.bands.join('/'))
  } else {
    log('ready: окно берём из настроек модели, не из конфига плагина')
    bootstrapDefaultRoute()
  }

  const bootSeason = seasonAt(new Date(), cfg.peakMultiplier)
  log('ready: тариф ' + (bootSeason.peak ? 'пик' : 'off-peak') + ' (×' + bootSeason.multiplier + '), смена через ' + bootSeason.countdown +
    '; баланс ' + (cfg.balanceEnabled ? 'включён (' + (cfg.useAccountBalance ? 'аккаунт, иначе API-ключ' : 'только API-ключ') + ', кэш ' + cfg.balanceTtlMs + ' мс)' : 'выключен'))
}
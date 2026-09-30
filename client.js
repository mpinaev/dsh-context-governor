// dsh-context-governor client bundle (ModuleLoader format).
//
// 1) Чип в шапке сессии: контекст, оценка цены шага в $, cache-hit, баланс
//    DeepSeek, тариф пик/off-peak и вклад дочерних subagent-сессий.
// 2) Кнопка handoff в композере: один клик собирает сводку сессии и открывает
//    новую сессию в том же рабочем пространстве (ctx.uiWorkspace.startSession),
//    подставляя сводку в её черновик. Никаких веток и запасных путей.
//
// Язык интерфейса: en (по умолчанию), zh, ru. Переключается маленькой кнопкой
// в панели чипа и запоминается в localStorage. Хост-роуты закрыты служебным
// заголовком; язык сводки handoff передаётся параметром lang.
//
// Данные — только с /context-governor/api/* (host half). История и промпт
// не изменяются.

window.__ModuleLoader__.load({ id: 'dsh-context-governor', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')
  var h = React.createElement

  var BAND_COLOR = [
    'var(--dsw-alias-label-secondary, #6b7280)',
    'var(--dsw-alias-state-warn-primary, #b45309)',
    'var(--dsw-alias-state-error-primary, #ef4444)',
    'var(--dsw-alias-state-error-primary, #b91c1c)',
  ]
  var PENDING_TTL_MS = 60000

  /** Служебный заголовок: без него хост-роуты плагина отвечают 403. */
  var GUARD_HEADER = 'x-dsh-context-governor'

  /** Языки интерфейса: по умолчанию английский. */
  var LANGS = ['en', 'zh', 'ru']
  var LANG_KEY = 'dsh-context-governor.lang'
  var LANG_CODE = { en: 'EN', zh: '中文', ru: 'RU' }
  var LANG_NAME = { en: 'English', zh: '中文', ru: 'Русский' }
  var WEEKDAYS = {
    en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  }

  var MESSAGES = {
    en: {
      band: ['normal', 'attention', 'high', 'critical'],
      panelTitle: 'Session context',
      refresh: 'Refresh balance and tariff',
      ctx: 'ctx',
      kids: 'kids',
      unknown: 'unknown',
      dash: '—',
      unavailable: 'unavailable',
      noData: 'No data',
      noPrice: 'price unavailable',
      tipContext: 'Context',
      perStep: 'per step',
      rows: {
        prompt: 'context (prompt)', fresh: 'fresh input', cacheRead: 'cache read', cacheWrite: 'cache write', cacheHit: 'cache-hit (session)',
        output: 'output per step', cold: 'cold input per step', cost: 'step cost',
        relative: 'relative to base', window: 'model window', windowSource: 'window source',
        threshold: 'compaction threshold', reserve: 'output reserve', band: 'band',
        tariff: 'tariff', tariffFlip: 'flips in', beijing: 'Beijing time',
        rates: 'rates $/1M', balance: 'balance',
      },
      /* Значения строки «window source»: host отдаёт код, текст выбирает язык. */
      windowSources: { catalog: 'model catalog', request: 'route resolve' },
      season: { peak: 'peak', off: 'off-peak' },
      balanceState: { disabled: 'disabled', 'no-credential': 'no API key', error: 'error', empty: 'empty', 'other-provider': 'DeepSeek only' },
      ratesFmt: function (r) { return 'in ' + r.fresh + ', cache-read ' + r.cacheRead + ', cache-write ' + r.cacheWrite + ', out ' + r.output },
      seasonTitle: function (season, day, clock) {
        return season.peak
          ? 'Peak tariff for another ' + season.countdown + ' (then off-peak). Beijing: ' + day + ' ' + clock + '.'
          : 'Off-peak tariff, half price, for another ' + season.countdown + '. Beijing: ' + day + ' ' + clock + '.'
      },
      balanceTitle: function (b) {
        return 'DeepSeek balance: ' + b.total + ' ' + b.currency + ' (granted ' + b.granted + ', topped up ' + b.toppedUp + ')' +
          (b.isAvailable === false ? ' — account unavailable' : '') +
          (b.source === 'account' ? ' · platform account' : ' · API key')
      },
      kidsHeader: function (n, tokens) { return 'Child sessions (' + n + ', another ' + fmtTok(tokens) + ')' },
      langTip: function (cur, next) { return 'Language: ' + cur + ' → ' + next },
      warnings: {
        cacheHitLow: function (w) { return 'cache-hit ' + w.pct + '% stays below ' + w.floor + '%: input is paid as fresh' },
        coldPrefill: function (w) { return 'cold prefill ' + w.fresh + ' fresh tokens' + (w.usd != null ? ' (≈$' + w.usd + ')' : '') },
        expensiveStep: function (w) { return 'expensive step: ~$' + w.usd },
        nearCompaction: function (w) { return 'context ' + w.prompt + ' is nearing the auto-compaction threshold ' + w.threshold + ': the next step rewrites the prefix and resets the cache' },
        windowUnknown: function () { return 'model window unknown — waiting for the route to resolve' },
        childrenTokens: function (w) { return 'children hold another ' + w.tokens + ' tokens' },
        childrenCount: function (w) { return w.count + ' child sessions' },
      },
      handoff: {
        label: '↪ handoff',
        tip: 'Handoff: collects a summary of this session and opens a new one with it in the draft',
        busy: '…', started: 'new session…', inserted: 'summary inserted',
        none: 'no data', noChannel: 'new-session channel unavailable',
      },
    },
    zh: {
      band: ['正常', '注意', '偏高', '严重'],
      panelTitle: '会话上下文',
      refresh: '刷新余额与费率',
      ctx: '上下文',
      kids: '子会话',
      unknown: '未知',
      dash: '—',
      unavailable: '不可用',
      noData: '无数据',
      noPrice: '价格未知',
      tipContext: '上下文',
      perStep: '每步',
      rows: {
        prompt: '上下文 (prompt)', fresh: '新输入', cacheRead: '缓存读取', cacheWrite: '缓存写入', cacheHit: '缓存命中（会话）',
        output: '本步输出', cold: '本步冷输入', cost: '本步花费',
        relative: '相对基准', window: '模型窗口', windowSource: '窗口来源',
        threshold: '压缩阈值', reserve: '输出预留', band: '档位',
        tariff: '费率', tariffFlip: '距切换', beijing: '北京时间',
        rates: '费率 $/1M', balance: '余额',
      },
      windowSources: { catalog: '模型目录', request: '路由解析' },
      season: { peak: '高峰', off: '低谷' },
      balanceState: { disabled: '已关闭', 'no-credential': '未配置 API 密钥', error: '错误', empty: '空响应', 'other-provider': '仅限 DeepSeek' },
      ratesFmt: function (r) { return '输入 ' + r.fresh + '，缓存读 ' + r.cacheRead + '，缓存写 ' + r.cacheWrite + '，输出 ' + r.output },
      seasonTitle: function (season, day, clock) {
        return season.peak
          ? '高峰费率还有 ' + season.countdown + '（之后转低谷）。北京 ' + day + ' ' + clock + '。'
          : '低谷费率（半价）还有 ' + season.countdown + '。北京 ' + day + ' ' + clock + '。'
      },
      balanceTitle: function (b) {
        return 'DeepSeek 余额：' + b.total + ' ' + b.currency + '（赠送 ' + b.granted + '，充值 ' + b.toppedUp + '）' +
          (b.isAvailable === false ? ' — 账户不可用' : '') +
          (b.source === 'account' ? ' · 平台账户' : ' · API 密钥')
      },
      kidsHeader: function (n, tokens) { return '子会话（' + n + ' 个，另占 ' + fmtTok(tokens) + '）' },
      langTip: function (cur, next) { return '语言：' + cur + ' → ' + next },
      warnings: {
        cacheHitLow: function (w) { return '缓存命中 ' + w.pct + '% 持续低于 ' + w.floor + '%：输入按新输入计价' },
        coldPrefill: function (w) { return '冷预填 ' + w.fresh + ' 个新 token' + (w.usd != null ? '（约 $' + w.usd + '）' : '') },
        expensiveStep: function (w) { return '本步较贵：约 $' + w.usd },
        nearCompaction: function (w) { return '上下文 ' + w.prompt + ' 接近自动压缩阈值 ' + w.threshold + '：下一步会重写前缀并清空缓存' },
        windowUnknown: function () { return '模型窗口未知 — 等待路由解析' },
        childrenTokens: function (w) { return '子会话还占 ' + w.tokens + ' tokens' },
        childrenCount: function (w) { return '有 ' + w.count + ' 个子会话' },
      },
      handoff: {
        label: '↪ 交接',
        tip: '交接：生成本会话摘要，并新建会话将其放入草稿',
        busy: '…', started: '新会话…', inserted: '摘要已插入',
        none: '无数据', noChannel: '新会话通道不可用',
      },
    },
    ru: {
      band: ['норма', 'внимание', 'много', 'критично'],
      panelTitle: 'Контекст сессии',
      refresh: 'Обновить баланс и тариф',
      ctx: 'ctx',
      kids: 'дети',
      unknown: 'неизвестно',
      dash: '—',
      unavailable: 'недоступен',
      noData: 'Нет данных',
      noPrice: 'цена неизвестна',
      balanceUnknown: 'баланс неизвестен (не DeepSeek)',
      tipContext: 'Контекст',
      perStep: 'за шаг',
      rows: {
        prompt: 'контекст (prompt)', fresh: 'свежий вход', cacheRead: 'кэш-чтение', cacheWrite: 'запись в кэш', cacheHit: 'cache-hit (сессия)',
        output: 'output за шаг', cold: 'холодный вход за шаг', cost: 'стоимость шага',
        relative: 'относительно базы', window: 'окно модели', windowSource: 'источник окна',
        threshold: 'порог компакции', reserve: 'резерв вывода', band: 'полоса',
        tariff: 'тариф', tariffFlip: 'до смены тарифа', beijing: 'время Пекина',
        rates: 'ставки $/1M', balance: 'баланс',
      },
      windowSources: { catalog: 'каталог моделей', request: 'резолв маршрута' },
      season: { peak: 'пик', off: 'off-peak' },
      balanceState: { disabled: 'выключен', 'no-credential': 'нет API-ключа', error: 'ошибка', empty: 'пустой ответ', 'other-provider': 'только для DeepSeek' },
      ratesFmt: function (r) { return 'вход ' + r.fresh + ', чтение ' + r.cacheRead + ', запись ' + r.cacheWrite + ', output ' + r.output },
      seasonTitle: function (season, day, clock) {
        return season.peak
          ? 'Тариф пик ещё ' + season.countdown + ' (дальше off-peak). Пекин: ' + day + ' ' + clock + '.'
          : 'Тариф off-peak, вдвое дешевле, ещё ' + season.countdown + '. Пекин: ' + day + ' ' + clock + '.'
      },
      balanceTitle: function (b) {
        return 'Баланс DeepSeek: ' + b.total + ' ' + b.currency + ' (подарок ' + b.granted + ', пополнено ' + b.toppedUp + ')' +
          (b.isAvailable === false ? ' — счёт недоступен' : '') +
          (b.source === 'account' ? ' · аккаунт платформы' : ' · API-ключ')
      },
      kidsHeader: function (n, tokens) { return 'Дочерние сессии (' + n + ', ещё ' + fmtTok(tokens) + ')' },
      langTip: function (cur, next) { return 'Язык: ' + cur + ' → ' + next },
      warnings: {
        cacheHitLow: function (w) { return 'cache-hit ' + w.pct + '% — держится ниже ' + w.floor + '%: вход переплачивается как свежий' },
        coldPrefill: function (w) { return 'холодный префилл ' + w.fresh + ' свежих токенов' + (w.usd != null ? ' (≈$' + w.usd + ')' : '') },
        expensiveStep: function (w) { return 'дорогой шаг: ~$' + w.usd },
        nearCompaction: function (w) { return 'контекст ' + w.prompt + ' подходит к порогу авто-компакции ' + w.threshold + ': следующий шаг перепишет префикс и обнулит кэш' },
        windowUnknown: function () { return 'окно модели неизвестно — ждём резолв маршрута' },
        childrenTokens: function (w) { return 'дети держат ещё ' + w.tokens + ' токенов' },
        childrenCount: function (w) { return 'есть ' + w.count + ' дочерних сессий' },
      },
      handoff: {
        label: '↪ handoff',
        tip: 'Handoff: соберёт сводку этой сессии и откроет новую с ней в черновике',
        busy: '…', started: 'новая сессия…', inserted: 'сводка вставлена',
        none: 'нет данных', noChannel: 'канал новой сессии недоступен',
      },
    },
  }

  function headers() {
    var out = { accept: 'application/json' }
    out[GUARD_HEADER] = '1'
    return out
  }

  function readLang() {
    try {
      var saved = window.localStorage.getItem(LANG_KEY)
      if (LANGS.indexOf(saved) !== -1) return saved
    } catch (error) { /* localStorage недоступен — берём язык по умолчанию */ }
    return 'en'
  }

  function writeLang(lang) {
    try { window.localStorage.setItem(LANG_KEY, lang) } catch (error) { /* не критично */ }
  }

  var currentLang = readLang()
  var langListeners = []

  function setLang(lang) {
    if (LANGS.indexOf(lang) === -1 || lang === currentLang) return
    currentLang = lang
    writeLang(lang)
    for (var i = 0; i < langListeners.length; i++) langListeners[i](lang)
  }

  /** Текущий язык как React-состояние: переключение перерисовывает оба компонента. */
  function useLang() {
    var s = React.useState(currentLang)
    React.useEffect(function () {
      var fn = function (value) { s[1](value) }
      langListeners.push(fn)
      return function () {
        var index = langListeners.indexOf(fn)
        if (index !== -1) langListeners.splice(index, 1)
      }
    }, [])
    return s[0]
  }

  function nextLang() {
    return LANGS[(LANGS.indexOf(currentLang) + 1) % LANGS.length]
  }

  /** Ожидающий текст для новой сессии (модульный, не React-состояние). */
  var pendingHandoff = null

  /** ctx.uiWorkspace, поставленный в apply: единственный путь открытия сессии. */
  var newSessionService = null

  function fmtTok(n) {
    if (!Number.isFinite(n)) return '—'
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M'
    if (n >= 1000) return Math.round(n / 1000) + 'k'
    return String(Math.round(n))
  }

  /** Оценка стоимости шага в долларах: до цента точности хватает. */
  function fmtUsd(n) {
    if (!Number.isFinite(n)) return '—'
    if (n >= 1) return n.toFixed(2)
    if (n >= 0.01) return n.toFixed(3)
    return n.toFixed(4)
  }

  /** Баланс: валюту называет API, знак подставляем по коду. */
  function fmtMoney(bal) {
    if (!bal || !bal.ok) return ''
    var sign = bal.currency === 'CNY' ? '¥' : bal.currency === 'USD' ? '$' : (bal.currency ? bal.currency + ' ' : '')
    var value = Number(bal.total)
    if (!Number.isFinite(value)) return sign + '—'
    return sign + (value >= 100 ? value.toFixed(2) : value.toFixed(3))
  }

  function weekdayName(season, M, lang) {
    if (!season || !season.beijing) return ''
    var index = season.beijing.weekdayIndex
    if (index === undefined) return String(season.beijing.weekday || '')
    return (WEEKDAYS[lang] || WEEKDAYS.en)[index] || ''
  }

  function seasonLabelText(season, M) {
    if (!season) return M.dash
    return (season.peak ? M.season.peak : M.season.off) + (season.peak ? ' (×' + season.multiplier + ')' : '')
  }

  function seasonTitleText(season, M, lang) {
    if (!season) return ''
    return M.seasonTitle(season, weekdayName(season, M, lang), season.beijing ? season.beijing.clock : '')
  }

  /** Источник окна модели приходит кодом (host языка не знает): текст берём
      из словаря языка, неизвестный код показываем как есть — не терять диагностику. */
  function windowSourceText(code, M) {
    if (!code) return M.dash
    return (M.windowSources && M.windowSources[code]) || String(code)
  }

  /** Cache-hit показываем по ИТОГАМ сессии — как чип harness («Cache hit»), —
      и берём готовый честный текст хоста: частичное попадание (99.97%) не
      округляется до 100. Фолбэк — целое число, если хост старый. */
  function cacheHitLabel(cur, M) {
    if (!cur) return M.dash
    if (cur.cacheHitText) return cur.cacheHitText + '%'
    return (cur.cacheHitPct || 0) + '%'
  }

  function balanceStateText(bal, M) {
    if (!bal) return M.noData
    if (bal.ok) return fmtMoney(bal) + ' ' + bal.currency + (bal.isAvailable === false ? ' (' + M.unavailable + ')' : '')
    if (bal.state === 'other-provider') return M.balanceUnknown
    var text = M.balanceState[bal.state] || String(bal.state || '')
    if (bal.state === 'error' && bal.error) text += ': ' + bal.error
    return text
  }

  function balanceTipText(bal, M) {
    if (!bal) return M.dash
    if (bal.ok) return M.balanceTitle(bal)
    return balanceStateText(bal, M)
  }

  function warningText(w, M) {
    if (typeof w === 'string') return w
    if (w && typeof w.code === 'string' && M.warnings[w.code]) return M.warnings[w.code](w)
    return String((w && w.code) || '')
  }

  /* Идентичность UI для официального баланса harness: язык, смещение таймзоны
     и версия сборки. Версии может не быть — тогда хост идёт по API-ключу. */
  function uiIdentity() {
    var ver = ''
    try {
      var boot = window.__DSH_BOOT__
      if (boot && typeof boot === 'object') ver = String(boot.version || boot.clientVersion || boot.buildVersion || '')
    } catch (error) { ver = '' }
    return { lang: currentLang, tz: String(-new Date().getTimezoneOffset() * 60), ver: ver }
  }

  function endpoint(path, sessionId, extra) {
    var query = []
    if (sessionId) query.push('sessionId=' + encodeURIComponent(sessionId))
    var ui = uiIdentity()
    for (var uiKey in ui) query.push(encodeURIComponent(uiKey) + '=' + encodeURIComponent(ui[uiKey]))
    if (extra) {
      for (var key in extra) {
        if (extra[key] === undefined || extra[key] === null || extra[key] === '') continue
        query.push(encodeURIComponent(key) + '=' + encodeURIComponent(extra[key]))
      }
    }
    return '/context-governor/api/' + path + (query.length > 0 ? '?' + query.join('&') : '')
  }

  function fetchStatus(sessionId, refresh) {
    return fetch(endpoint('status', sessionId, refresh ? { refresh: '1' } : null), { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
  }

  function fetchHandoff(sessionId, lang) {
    return fetch(endpoint('handoff', sessionId, { lang: lang }), { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
  }

  function smallButtonStyle() {
    return {
      cursor: 'pointer', border: '1px solid var(--dsw-alias-separator, #374151)',
      background: 'transparent', color: 'inherit', borderRadius: '4px',
      fontSize: '11px', lineHeight: '14px', padding: '0 4px',
    }
  }

  function Governor(props) {
    var sid = props && props.sessionId
    var lang = useLang()
    var M = MESSAGES[lang]
    var s = React.useState(null)
    var data = s[0]
    var setData = s[1]
    var o = React.useState(false)
    var open = o[0]
    var setOpen = o[1]

    var load = React.useCallback(function (force) {
      fetchStatus(sid, force === true).then(function (payload) {
        if (!payload || !payload.ok) return
        setData(payload)
      })
    }, [sid])

    React.useEffect(function () {
      load()
      var timer = setInterval(function () { load(false) }, 5000)
      return function () { clearInterval(timer) }
    }, [load])

    var cur = data && data.current ? data.current : null
    var cfgInfo = (data && data.config) || {}
    var band = cur ? cur.band : 0
    var color = BAND_COLOR[band] || BAND_COLOR[0]
    var kids = data && data.children ? data.children : []
    var kidsNote = kids.length > 0 ? ' · ' + M.kids + ' ' + kids.length : ''
    var season = data && data.season ? data.season : null
    var bal = data && data.balance ? data.balance : null
    /* Цена — только если host удалось посчитать (DeepSeek). Иначе «цена неизвестна». */
    var knownPrice = cur && cur.costUsd != null
    var costText = knownPrice ? ('$' + fmtUsd(cur.costUsd)) : M.noPrice
    var seasonText = season ? (season.peak ? '⚡' + season.countdown : '🌙' + season.countdown) : ''
    var balText = fmtMoney(bal)
    var label = cur
      ? M.ctx + ' ' + fmtTok(cur.prompt) + ' · ' + costText + ' · ' + cacheHitLabel(cur, M) + kidsNote
      : M.ctx + ' ' + M.dash
    var tipParts = cur
      ? [
          M.tipContext + ' ' + cur.prompt + ' (' + M.band[band] + ')',
          M.rows.fresh + ' ' + cur.fresh,
          M.rows.cacheRead + ' ' + cur.cacheRead,
          M.rows.cacheWrite + ' ' + cur.cacheWrite,
          M.rows.cacheHit + ' ' + cacheHitLabel(cur, M),
          knownPrice ? ('~$' + fmtUsd(cur.costUsd) + ' ' + M.perStep + ' (x' + cur.relative + ' ' + M.rows.relative + ' ' + (cfgInfo.base || '') + ')') : (M.noPrice + ' ' + M.perStep),
        ]
      : []
    if (cur && cfgInfo.windowTokens) tipParts.push(M.rows.window + ' ' + cfgInfo.windowTokens + ' (' + (cfgInfo.route || '') + ')')
    if (season) tipParts.push(seasonTitleText(season, M, lang))
    if (bal) tipParts.push(balanceTipText(bal, M))

    var chip = h('button', {
      type: 'button',
      title: cur ? tipParts.join(', ') : M.noData,
      onClick: function () { setOpen(!open) },
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        padding: '2px 8px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid ' + color, background: 'transparent',
        color: color, fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap',
      },
    }, h('span', { style: { fontSize: '10px' } }, band >= 2 ? '⚠' : '◐'),
      h('span', null, label),
      balText ? h('span', { title: balanceTipText(bal, M), style: { color: BAND_COLOR[0] } }, ' · ' + balText) : null,
      seasonText ? h('span', { title: seasonTitleText(season, M, lang), style: { color: season.color, fontWeight: 600 } }, ' · ' + seasonText) : null)

    var panel = null
    if (open) {
      var rows = cur
        ? [
            [M.rows.prompt, cur.prompt],
            [M.rows.fresh, cur.fresh],
            [M.rows.cacheRead, cur.cacheRead],
            [M.rows.cacheWrite, cur.cacheWrite],
            [M.rows.cacheHit, cacheHitLabel(cur, M)],
            [M.rows.output, cur.output],
            [M.rows.cold, '+' + cur.freshDelta],
            [M.rows.cost, knownPrice ? ('~$' + fmtUsd(cur.costUsd)) : M.noPrice],
            [M.rows.relative + ' ' + fmtTok(cfgInfo.base || 0), knownPrice ? ('x' + cur.relative) : M.noPrice],
            [M.rows.window, cfgInfo.windowTokens ? fmtTok(cfgInfo.windowTokens) + ' (' + (cfgInfo.route || '?') + ')' : M.unknown],
            [M.rows.windowSource, windowSourceText(cfgInfo.windowSource, M)],
            [M.rows.threshold, cfgInfo.compactThreshold ? cfgInfo.compactThreshold : M.dash],
            [M.rows.reserve, cfgInfo.reservedTokens ? cfgInfo.reservedTokens : M.dash],
            [M.rows.band, M.band[band] + ' (' + band + ')'],
            [M.rows.tariff, seasonLabelText(season, M)],
            [M.rows.tariffFlip, season ? season.countdown + ' → ' + (season.peak ? M.season.off : M.season.peak) : M.dash],
            [M.rows.beijing, season ? weekdayName(season, M, lang) + ' ' + season.beijing.clock : M.dash],
            [M.rows.rates, data.rates ? M.ratesFmt(data.rates) : M.noPrice],
            [M.rows.balance, balanceStateText(bal, M)],
          ]
        : [[M.tipContext, M.noData]]
      var kidsRows = kids.slice(0, 5).map(function (kid) {
        return h('div', { key: kid.session, style: { display: 'flex', justifyContent: 'space-between', gap: '12px' } },
          h('span', { style: { color: BAND_COLOR[0] } }, kid.session.slice(-8)),
          h('span', null, kid.prompt === null ? M.dash : fmtTok(kid.prompt)))
      })
      panel = h('div', {
        style: {
          position: 'absolute', top: '26px', right: 0, zIndex: 40, minWidth: '280px',
          background: 'var(--dsw-alias-bg-layer-1, #1f2430)', color: 'var(--dsw-alias-label-primary, #e5e7eb)',
          border: '1px solid var(--dsw-alias-separator, #374151)', borderRadius: '8px',
          padding: '10px 12px', fontSize: '12px', boxShadow: '0 8px 24px rgba(0,0,0,.35)',
        },
      },
        h('div', { style: { fontWeight: 600, marginBottom: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' } },
          h('span', null, M.panelTitle),
          h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
            h('button', {
              type: 'button',
              title: M.refresh,
              onClick: function (event) { event.stopPropagation(); load(true) },
              style: smallButtonStyle(),
            }, '⟳'),
            h('button', {
              type: 'button',
              title: M.langTip(LANG_NAME[lang], LANG_NAME[nextLang()]),
              onClick: function (event) { event.stopPropagation(); setLang(nextLang()) },
              style: smallButtonStyle(),
            }, LANG_CODE[lang]))),
        rows.map(function (row) {
          return h('div', { key: row[0], style: { display: 'flex', justifyContent: 'space-between', gap: '16px' } },
            h('span', { style: { color: BAND_COLOR[0] } }, row[0]),
            h('span', null, String(row[1])))
        }),
        kids.length > 0
          ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: { color: BAND_COLOR[0], marginBottom: '4px' } },
                M.kidsHeader(kids.length, data.childrenPromptSum)),
              kidsRows)
          : null,
        (data && data.warnings ? data.warnings : []).map(function (w) {
          var key = typeof w === 'string' ? w : JSON.stringify(w)
          return h('div', { key: key, style: { marginTop: '6px', color: BAND_COLOR[2] } }, warningText(w, M))
        })
      )
    }

    return h('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } }, chip, panel)
  }

  function HandoffButton(props) {
    var lang = useLang()
    var M = MESSAGES[lang]
    var st = React.useState('')
    var state = st[0]
    var setState = st[1]
    var sessionId = props && props.sessionId
    var inputActions = props && props.inputActions

    // Новая сессия отрендерила этот же слот — вставляем подготовленную сводку.
    React.useEffect(function () {
      if (!pendingHandoff) return
      var fresh = pendingHandoff
      if (fresh.fromSessionId !== undefined && fresh.fromSessionId === sessionId) return
      if (Date.now() - fresh.at > PENDING_TTL_MS) { pendingHandoff = null; return }
      if (!inputActions || typeof inputActions.setDraft !== 'function') return
      pendingHandoff = null
      inputActions.setDraft(fresh.text)
      setState(M.handoff.inserted)
      setTimeout(function () { setState('') }, 5000)
    })

    var click = React.useCallback(function () {
      if (newSessionService === null || typeof newSessionService.startSession !== 'function') {
        setState(M.handoff.noChannel)
        setTimeout(function () { setState('') }, 8000)
        return
      }
      setState(M.handoff.busy)
      fetchHandoff(sessionId, lang).then(function (payload) {
        var text = payload && payload.ok ? payload.text : ''
        if (!text) { setState(M.handoff.none); return }
        pendingHandoff = { text: text, at: Date.now(), fromSessionId: sessionId }
        try {
          // Единственный путь: новая сессия в том же рабочем пространстве.
          newSessionService.startSession()
          setState(M.handoff.started)
        } catch (error) {
          pendingHandoff = null
          setState(M.handoff.noChannel)
          setTimeout(function () { setState('') }, 8000)
        }
      })
    }, [sessionId, lang])

    return h('button', {
      type: 'button',
      onClick: click,
      title: M.handoff.tip,
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 8px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-separator, #374151)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #9ca3af)', fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap',
      },
    }, h('span', null, M.handoff.label), state ? h('span', { style: { marginLeft: '4px' } }, state) : null)
  }

  /* uiWorkspace объявлен в inject: без него Cordis не отдаёт сервис, и раньше
     кнопка молча уходила в запасные ветки вместо открытия новой сессии. */
  var inject = ['slots', 'uiWorkspace']

  function apply(ctx) {
    try {
      if (ctx && ctx.uiWorkspace && typeof ctx.uiWorkspace.startSession === 'function') newSessionService = ctx.uiWorkspace
    } catch (error) {
      newSessionService = null
    }

    ctx.slots.inject('conversation.session.header.utilities', function () {
      return ctx.slots.register(
        { name: 'conversation.session.header.utilities', id: 'context-governor', order: 30 },
        Governor,
      )
    })

    ctx.slots.inject('conversation.input.right', function () {
      return ctx.slots.register(
        { name: 'conversation.input.right', id: 'context-governor-handoff', order: 90 },
        function (props) {
          var p = props || {}
          return h(HandoffButton, {
            sessionId: p.sessionId,
            inputActions: p.inputActions,
          })
        },
      )
    })
  }

  exports.apply = apply
  exports.inject = inject
  return module.exports
} })

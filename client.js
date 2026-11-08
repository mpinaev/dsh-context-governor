// dsh-context-governor client bundle (ModuleLoader format).
//
// 1) Чип в шапке сессии: контекст, оценка цены шага в $, cache-hit, баланс
//    DeepSeek, тариф пик/off-peak и вклад дочерних subagent-сессий.
// 2) Кнопка handoff в композере: один клик собирает сводку сессии и открывает
//    новую сессию в том же рабочем пространстве (ctx.uiWorkspace.startSession),
//    подставляя сводку в её черновик. Никаких веток и запасных путей.
// 3) Кнопка compact рядом с handoff: один клик выполняет встроенную команду
//    harness /compact через ctx.remote.commands.execute. Плагин модель не зовёт;
//    сжимает штатный обработчик, поэтому сводка может стоить токенов.
// 4) Кнопка места в панели чипа: переставляет бейдж по кругу между шапкой
//    сессии, строкой под полем ввода и низом сайдбара; выбор запоминается.
//
// Язык интерфейса: en (по умолчанию), zh, ru. Переключается маленькой кнопкой
// в панели чипа и запоминается в localStorage. Хост-роуты закрыты служебным
// заголовком; язык сводки handoff передаётся параметром lang.
//
// Данные — с /context-governor/api/* (host half). История не меняется, кроме
// кнопки compact: она по клику вызывает штатную /compact, и та сжимает сессию.

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

  /** Где стоит бейдж: шапка сессии, строка под полем ввода или низ сайдбара. */
  var PLACES = ['header', 'composer', 'sidebar']
  var PLACE_KEY = 'dsh-context-governor.place'
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
      balanceUnknown: 'balance unknown (not DeepSeek)',
      tipContext: 'Context',
      perStep: 'per step',
      rows: {
        prompt: 'context (prompt)', fresh: 'fresh input', cacheRead: 'cache read', cacheWrite: 'cache write', cacheHit: 'cache-hit (session)',
        output: 'output per step', cold: 'cold input per step', cost: 'step cost',
        relative: 'relative to base', window: 'model window', windowSource: 'window source',
        threshold: 'compaction threshold', reserve: 'output reserve', band: 'band',
        tariff: 'tariff', tariffFlip: 'flips in', beijing: 'Beijing time',
        rates: 'rates $/1M', balance: 'balance', holiday: 'holiday calendar',
      },
      /* Значения строки «window source»: host отдаёт код, текст выбирает язык. */
      windowSources: { catalog: 'model catalog', request: 'route resolve' },
      season: { peak: 'peak', off: 'off-peak', holiday: 'Chinese holiday' },
      holidayUnknown: 'not loaded (weekdays only)',
      balanceState: { disabled: 'disabled', 'no-credential': 'no API key', error: 'error', empty: 'empty', 'other-provider': 'DeepSeek only' },
      ratesFmt: function (r, cached) { return 'in ' + r.fresh + (cached === false ? '' : ', cache-read ' + r.cacheRead + ', cache-write ' + r.cacheWrite) + ', out ' + r.output },
      seasonTitle: function (season, day, clock) {
        var when = season.holiday
          ? 'Chinese public holiday: off-peak all day, half price.'
          : (season.peak
            ? 'Peak tariff for another ' + season.countdown + ' (then off-peak).'
            : 'Off-peak tariff, half price, for another ' + season.countdown + '.')
        return when + ' Beijing: ' + day + ' ' + clock + '.' +
          (season.holidayKnown === false ? ' Holiday calendar not loaded — weekdays only.' : '')
      },
      balanceTitle: function (b) {
        return 'DeepSeek balance: ' + money2(b.total) + ' ' + b.currency + ' (granted ' + money2(b.granted) + ', topped up ' + money2(b.toppedUp) + ')' +
          (b.isAvailable === false ? ' — account unavailable' : '') +
          (b.source === 'account' ? ' · platform account' : ' · API key')
      },
      kidsHeader: function (n, tokens) { return 'Child sessions (' + n + ', another ' + fmtTok(tokens) + ')' },
      langTip: function (cur, next) { return 'Language: ' + cur + ' → ' + next },
      place: { header: 'session header', composer: 'under the prompt', sidebar: 'sidebar footer' },
      placeTip: function (from, to) { return 'Badge: ' + from + '. Click to move it: ' + to },
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
      compact: {
        label: '⇲ compact',
        tip: 'Run the built-in /compact: compacts older conversation history. The harness calls its summarizer, so this may spend tokens',
        busy: 'compacting…', compacted: '✓ compacted', nothing: '✓ nothing to compact', done: '✓ done',
        failed: '✕ failed', unknown: '✕ /compact unavailable', noChannel: '✕ command channel unavailable',
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
      balanceUnknown: '余额未知（非 DeepSeek）',
      tipContext: '上下文',
      perStep: '每步',
      rows: {
        prompt: '上下文 (prompt)', fresh: '新输入', cacheRead: '缓存读取', cacheWrite: '缓存写入', cacheHit: '缓存命中（会话）',
        output: '本步输出', cold: '本步冷输入', cost: '本步花费',
        relative: '相对基准', window: '模型窗口', windowSource: '窗口来源',
        threshold: '压缩阈值', reserve: '输出预留', band: '档位',
        tariff: '费率', tariffFlip: '距切换', beijing: '北京时间',
        rates: '费率 $/1M', balance: '余额', holiday: '节假日日历',
      },
      windowSources: { catalog: '模型目录', request: '路由解析' },
      season: { peak: '高峰', off: '低谷', holiday: '中国法定节假日' },
      holidayUnknown: '未加载（仅按工作日）',
      balanceState: { disabled: '已关闭', 'no-credential': '未配置 API 密钥', error: '错误', empty: '空响应', 'other-provider': '仅限 DeepSeek' },
      ratesFmt: function (r, cached) { return '输入 ' + r.fresh + (cached === false ? '' : '，缓存读 ' + r.cacheRead + '，缓存写 ' + r.cacheWrite) + '，输出 ' + r.output },
      seasonTitle: function (season, day, clock) {
        var when = season.holiday
          ? '中国法定节假日：全天低谷价（半价）。'
          : (season.peak
            ? '高峰费率还有 ' + season.countdown + '（之后转低谷）。'
            : '低谷费率（半价）还有 ' + season.countdown + '。')
        return when + '北京 ' + day + ' ' + clock + '。' +
          (season.holidayKnown === false ? '节假日日历未加载 — 仅按工作日判断。' : '')
      },
      balanceTitle: function (b) {
        return 'DeepSeek 余额：' + money2(b.total) + ' ' + b.currency + '（赠送 ' + money2(b.granted) + '，充值 ' + money2(b.toppedUp) + '）' +
          (b.isAvailable === false ? ' — 账户不可用' : '') +
          (b.source === 'account' ? ' · 平台账户' : ' · API 密钥')
      },
      kidsHeader: function (n, tokens) { return '子会话（' + n + ' 个，另占 ' + fmtTok(tokens) + '）' },
      langTip: function (cur, next) { return '语言：' + cur + ' → ' + next },
      place: { header: '会话顶部', composer: '输入框下方', sidebar: '侧边栏底部' },
      placeTip: function (from, to) { return '胶囊：' + from + '。点击移到：' + to },
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
      compact: {
        label: '⇲ 压缩',
        tip: '运行内置 /compact：压缩较早的会话历史。harness 会调用摘要模型，可能消耗 token',
        busy: '压缩中…', compacted: '✓ 已压缩', nothing: '✓ 无可压缩内容', done: '✓ 完成',
        failed: '✕ 失败', unknown: '✕ /compact 不可用', noChannel: '✕ 命令通道不可用',
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
        rates: 'ставки $/1M', balance: 'баланс', holiday: 'календарь праздников',
      },
      windowSources: { catalog: 'каталог моделей', request: 'резолв маршрута' },
      season: { peak: 'пик', off: 'off-peak', holiday: 'праздник Китая' },
      holidayUnknown: 'не загружен (только будни)',
      balanceState: { disabled: 'выключен', 'no-credential': 'нет API-ключа', error: 'ошибка', empty: 'пустой ответ', 'other-provider': 'только для DeepSeek' },
      ratesFmt: function (r, cached) { return 'вход ' + r.fresh + (cached === false ? '' : ', чтение ' + r.cacheRead + ', запись ' + r.cacheWrite) + ', output ' + r.output },
      seasonTitle: function (season, day, clock) {
        var when = season.holiday
          ? 'Государственный праздник Китая: весь день off-peak, вдвое дешевле.'
          : (season.peak
            ? 'Тариф пик ещё ' + season.countdown + ' (дальше off-peak).'
            : 'Тариф off-peak, вдвое дешевле, ещё ' + season.countdown + '.')
        return when + ' Пекин: ' + day + ' ' + clock + '.' +
          (season.holidayKnown === false ? ' Календарь праздников не загружен — считаем только по будням.' : '')
      },
      balanceTitle: function (b) {
        return 'Баланс DeepSeek: ' + money2(b.total) + ' ' + b.currency + ' (подарок ' + money2(b.granted) + ', пополнено ' + money2(b.toppedUp) + ')' +
          (b.isAvailable === false ? ' — счёт недоступен' : '') +
          (b.source === 'account' ? ' · аккаунт платформы' : ' · API-ключ')
      },
      kidsHeader: function (n, tokens) { return 'Дочерние сессии (' + n + ', ещё ' + fmtTok(tokens) + ')' },
      langTip: function (cur, next) { return 'Язык: ' + cur + ' → ' + next },
      place: { header: 'шапка сессии', composer: 'под полем ввода', sidebar: 'низ сайдбара' },
      placeTip: function (from, to) { return 'Бейдж: ' + from + '. Нажмите — переставится: ' + to },
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
      compact: {
        label: '⇲ сжать',
        tip: 'Выполнить встроенную /compact: сжать старую историю сессии. Сжимает штатный обработчик harness, поэтому сводка может потратить токены',
        busy: 'сжимаю…', compacted: '✓ сжато', nothing: '✓ нечего сжимать', done: '✓ готово',
        failed: '✕ не удалось', unknown: '✕ /compact недоступна', noChannel: '✕ канал команд недоступен',
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

  function readPlace() {
    try {
      var saved = window.localStorage.getItem(PLACE_KEY)
      if (PLACES.indexOf(saved) !== -1) return saved
    } catch (error) { /* localStorage недоступен — бейдж остаётся в шапке */ }
    return 'header'
  }

  function writePlace(place) {
    try { window.localStorage.setItem(PLACE_KEY, place) } catch (error) { /* не критично */ }
  }

  var currentPlace = readPlace()
  var placeListeners = []

  /** Переставить бейдж. Смена места видна во всех точках сразу: каждый слот
      держит свою подписку, а рендерится только совпавший с местом. */
  function setPlace(place) {
    if (PLACES.indexOf(place) === -1 || place === currentPlace) return
    currentPlace = place
    writePlace(place)
    for (var i = 0; i < placeListeners.length; i++) placeListeners[i](place)
  }

  /** Текущее место бейджа как React-состояние. */
  function usePlace() {
    var s = React.useState(currentPlace)
    React.useEffect(function () {
      var fn = function (value) { s[1](value) }
      placeListeners.push(fn)
      return function () {
        var index = placeListeners.indexOf(fn)
        if (index !== -1) placeListeners.splice(index, 1)
      }
    }, [])
    return s[0]
  }

  function nextPlace() {
    return PLACES[(PLACES.indexOf(currentPlace) + 1) % PLACES.length]
  }

  /** Сессия для бейджа вне session-слота: сайдбар получает только wide/false,
      поэтому id запоминает любой session-scoped рендер чипа (шапка/композер). */
  var currentSession = null
  var sessionListeners = []

  function noteSession(id) {
    if (!id || id === currentSession) return
    currentSession = id
    for (var i = 0; i < sessionListeners.length; i++) sessionListeners[i](id)
  }

  function useTrackedSession() {
    var s = React.useState(currentSession)
    React.useEffect(function () {
      var fn = function (value) { s[1](value) }
      sessionListeners.push(fn)
      if (currentSession !== s[0]) s[1](currentSession)
      return function () {
        var index = sessionListeners.indexOf(fn)
        if (index !== -1) sessionListeners.splice(index, 1)
      }
    }, [])
    return s[0]
  }

  /** Ожидающий текст для новой сессии (модульный, не React-состояние). */
  var pendingHandoff = null

  /** ctx.uiWorkspace, поставленный в apply: единственный путь открытия сессии. */
  var newSessionService = null

  /** Сервис remote.commands, полученный через ctx.inject: только он умеет execute. */
  var compactCommands = null

  /** Один таймер на кнопку compact: новый клик не должен гаситься старым. */
  var compactResetTimer = null

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

  /** Деньги печатаем до цента: баланс — это сумма на счёте, третий знак в ней
      был бы приписанным нулём (хост и API отдают два знака). */
  function money2(value) {
    var number = Number(value)
    return Number.isFinite(number) ? number.toFixed(2) : '—'
  }

  /** Баланс: валюту называет API, знак подставляем по коду. */
  function fmtMoney(bal) {
    if (!bal || !bal.ok) return ''
    var sign = bal.currency === 'CNY' ? '¥' : bal.currency === 'USD' ? '$' : (bal.currency ? bal.currency + ' ' : '')
    var value = Number(bal.total)
    if (!Number.isFinite(value)) return sign + '—'
    return sign + value.toFixed(2)
  }

  /** Прочие валюты счёта: юани с долларами не складываем, поэтому они идут
      припиской «+ ¥1.45», как в панели аккаунта DSH. Старый host поля не
      присылает — приписки просто нет. */
  function otherBalanceText(bal) {
    if (!bal || !bal.ok || !Array.isArray(bal.others)) return ''
    var out = ''
    for (var i = 0; i < bal.others.length; i++) {
      var item = bal.others[i]
      if (!item || !item.currency) continue
      var value = Number(item.total)
      if (!Number.isFinite(value) || value === 0) continue
      var sign = item.currency === 'CNY' ? '¥' : item.currency === 'USD' ? '$' : item.currency + ' '
      out += ' + ' + sign + money2(value)
    }
    return out
  }

  function weekdayName(season, M, lang) {
    if (!season || !season.beijing) return ''
    var index = season.beijing.weekdayIndex
    if (index === undefined) return String(season.beijing.weekday || '')
    return (WEEKDAYS[lang] || WEEKDAYS.en)[index] || ''
  }

  function seasonLabelText(season, M, withMultiplier) {
    if (!season) return M.dash
    /* Праздник Китая — будний день, но off-peak по правилу DeepSeek: помечаем
       причину, иначе «off-peak в будни» выглядит как ошибка. */
    if (season.holiday) return M.season.off + ' (' + M.season.holiday + ')'
    /* Множитель — про цену, поэтому без известных ставок его не показываем. */
    return (season.peak ? M.season.peak : M.season.off) + (season.peak && withMultiplier ? ' (×' + season.multiplier + ')' : '')
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
    if (bal.ok) return fmtMoney(bal) + ' ' + bal.currency + otherBalanceText(bal) + (bal.isAvailable === false ? ' (' + M.unavailable + ')' : '')
    if (bal.state === 'other-provider') return M.balanceUnknown
    var text = M.balanceState[bal.state] || String(bal.state || '')
    if (bal.state === 'error' && bal.error) text += ': ' + bal.error
    return text
  }

  function balanceTipText(bal, M) {
    if (!bal) return M.dash
    if (bal.ok) return M.balanceTitle(bal) + otherBalanceText(bal)
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
    /* shownIn — слот, в который бейдж зарегистрирован. Видимый один: тот,
       что совпал с сохранённым местом (кнопка места в панели). */
    var shownIn = (props && props.place) || 'header'
    var lang = useLang()
    var M = MESSAGES[lang]
    var s = React.useState(null)
    var data = s[0]
    var setData = s[1]
    var o = React.useState(false)
    var open = o[0]
    var setOpen = o[1]
    var placeState = usePlace()
    var tracked = useTrackedSession()
    var sid = (props && props.sessionId) || tracked
    /* В слоте сайдбара sessionId не приходит: id запоминает любой
       session-scoped рендер чипа (шапка или композер). */
    React.useEffect(function () { noteSession(props && props.sessionId) }, [props && props.sessionId])

    var place = PLACES.indexOf(placeState) !== -1 ? placeState : 'header'
    var hidden = place !== shownIn
    var wide = !(props && props.wide === false)
    var iconOnly = shownIn === 'sidebar' && !wide

    var load = React.useCallback(function (force) {
      fetchStatus(sid, force === true).then(function (payload) {
        if (!payload || !payload.ok) return
        setData(payload)
      })
    }, [sid])

    React.useEffect(function () {
      /* Спрятанный бейдж не должен опрашивать статус: работает только видимый. */
      if (hidden || !sid) return undefined
      load()
      var timer = setInterval(function () { load(false) }, 5000)
      return function () { clearInterval(timer) }
    }, [load, hidden, sid])

    if (hidden) return null

    var cur = data && data.current ? data.current : null
    var cfgInfo = (data && data.config) || {}
    var band = cur ? cur.band : 0
    var color = BAND_COLOR[band] || BAND_COLOR[0]
    var kids = data && data.children ? data.children : []
    var kidsNote = kids.length > 0 ? ' · ' + M.kids + ' ' + kids.length : ''
    var season = data && data.season ? data.season : null
    var bal = data && data.balance ? data.balance : null
    /* Пик — дорогие часы: и в чипе, и в панели баланс и время уходят в красный
       (цвет приходит от host вместе с сезоном). */
    var peak = !!(season && season.peak)
    var peakColor = peak ? season.color : null
    /* Ставки плагин знает только для DeepSeek. У остальных провайдеров цену
       шага не считаем и не показываем вовсе — ни в чипе, ни в панели, ни в
       подсказке: выдуманное «цена неизвестна» там только мешает.
       `priced` приходит от host; старый host без поля — прежнее поведение. */
    var showPrice = cfgInfo.priced !== false
    /* У провайдера без кэша (cached: false от host) cache-hit всегда 0, и
       показывать его и ставки на кэш нечего. Старый host без поля — как раньше. */
    var cachedProvider = cfgInfo.cached !== false
    var knownPrice = showPrice && cur && cur.costUsd != null
    var costText = knownPrice ? ('$' + fmtUsd(cur.costUsd)) : M.noPrice
    var seasonText = season ? (season.peak ? '⚡' + season.countdown : '🌙' + season.countdown) : ''
    var balText = fmtMoney(bal) + otherBalanceText(bal)
    var labelParts = cur ? [M.ctx + ' ' + fmtTok(cur.prompt)] : []
    if (cur && showPrice) labelParts.push(costText)
    /* В сайдбаре cache-hit уже виден в штатной строке статуса — не дублируем. */
    if (cur && cachedProvider && shownIn !== 'sidebar') labelParts.push(cacheHitLabel(cur, M))
    var label = cur ? labelParts.join(' · ') + kidsNote : M.ctx + ' ' + M.dash
    var tipParts = cur
      ? [
          M.tipContext + ' ' + cur.prompt + ' (' + M.band[band] + ')',
          M.rows.fresh + ' ' + cur.fresh,
        ]
      : []
    if (cur && cachedProvider) {
      tipParts.push(M.rows.cacheRead + ' ' + cur.cacheRead)
      tipParts.push(M.rows.cacheWrite + ' ' + cur.cacheWrite)
      tipParts.push(M.rows.cacheHit + ' ' + cacheHitLabel(cur, M))
    }
    if (cur && showPrice) tipParts.push(knownPrice ? ('~$' + fmtUsd(cur.costUsd) + ' ' + M.perStep + ' (x' + cur.relative + ' ' + M.rows.relative + ' ' + (cfgInfo.base || '') + ')') : (M.noPrice + ' ' + M.perStep))
    if (cur && cfgInfo.windowTokens) tipParts.push(M.rows.window + ' ' + cfgInfo.windowTokens + ' (' + (cfgInfo.route || '') + ')')
    if (season) tipParts.push(seasonTitleText(season, M, lang))
    if (bal) tipParts.push(balanceTipText(bal, M))

    var chipTitle = cur ? tipParts.join(', ') : M.noData
    /* Свёрнутый сайдбар — узкая рейка: вместо плашки рисуем иконку. */
    var chip = iconOnly
      ? h('button', {
          type: 'button',
          title: chipTitle,
          onClick: function () { setOpen(!open) },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', padding: 0, borderRadius: '8px', cursor: 'pointer',
            border: '1px solid ' + color, background: 'transparent',
            color: color, fontSize: '12px', lineHeight: '1',
          },
        }, band >= 2 ? '⚠' : '◐')
      : h('button', {
          type: 'button',
          title: chipTitle,
          onClick: function () { setOpen(!open) },
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '2px 8px', borderRadius: '999px', cursor: 'pointer',
            border: '1px solid ' + color, background: 'transparent',
            color: color, fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap',
          },
        }, h('span', { style: { fontSize: '10px' } }, band >= 2 ? '⚠' : '◐'),
          h('span', null, label),
          balText ? h('span', { title: balanceTipText(bal, M), style: { color: peakColor || BAND_COLOR[0] } }, ' · ' + balText) : null,
          seasonText ? h('span', { title: seasonTitleText(season, M, lang), style: { color: season.color, fontWeight: 600 } }, ' · ' + seasonText) : null)

    var panel = null
    if (open) {
      var rows = cur
        ? [
            [M.rows.prompt, cur.prompt],
            [M.rows.fresh, cur.fresh],
            /* Кэш-строки — только у провайдера, у которого кэш вообще есть. */
            cachedProvider ? [M.rows.cacheRead, cur.cacheRead] : null,
            cachedProvider ? [M.rows.cacheWrite, cur.cacheWrite] : null,
            cachedProvider ? [M.rows.cacheHit, cacheHitLabel(cur, M)] : null,
            [M.rows.output, cur.output],
            [M.rows.cold, '+' + cur.freshDelta],
            /* Цену показываем только на провайдерах с известными ставками;
               у остальных строк нет вовсе (ни значения, ни «цена неизвестна»). */
            showPrice ? [M.rows.cost, knownPrice ? ('~$' + fmtUsd(cur.costUsd)) : M.noPrice] : null,
            showPrice ? [M.rows.relative + ' ' + fmtTok(cfgInfo.base || 0), knownPrice ? ('x' + cur.relative) : M.noPrice] : null,
            [M.rows.window, cfgInfo.windowTokens ? fmtTok(cfgInfo.windowTokens) + ' (' + (cfgInfo.route || '?') + ')' : M.unknown],
            [M.rows.windowSource, windowSourceText(cfgInfo.windowSource, M)],
            [M.rows.threshold, cfgInfo.compactThreshold ? cfgInfo.compactThreshold : M.dash],
            [M.rows.reserve, cfgInfo.reservedTokens ? cfgInfo.reservedTokens : M.dash],
            [M.rows.band, M.band[band] + ' (' + band + ')'],
            /* Тариф DeepSeek показываем только там, где он есть: у чужого
               провайдера тариф плоский, и строк про пик/Пекин быть не должно. */
            season ? [M.rows.tariff, seasonLabelText(season, M, showPrice), peakColor] : null,
            season ? [M.rows.tariffFlip, season.countdown + ' → ' + (season.peak ? M.season.off : M.season.peak), peakColor] : null,
            season ? [M.rows.beijing, weekdayName(season, M, lang) + ' ' + season.beijing.clock, peakColor] : null,
            showPrice ? [M.rows.rates, data.rates ? M.ratesFmt(data.rates, cachedProvider) : M.noPrice] : null,
            [M.rows.balance, balanceStateText(bal, M), bal && bal.ok ? peakColor : null],
          ].filter(Boolean)
        : [[M.tipContext, M.noData]]
      /* Календарь праздников не доехал (нет сети / год ещё не опубликован):
         тариф считаем по будням — говорим об этом прямо, а не молчим. */
      if (season && season.holidayKnown === false) rows.push([M.rows.holiday, M.holidayUnknown])
      var kidsRows = kids.slice(0, 5).map(function (kid) {
        return h('div', { key: kid.session, style: { display: 'flex', justifyContent: 'space-between', gap: '12px' } },
          h('span', { style: { color: BAND_COLOR[0] } }, kid.session.slice(-8)),
          h('span', null, kid.prompt === null ? M.dash : fmtTok(kid.prompt)))
      })
      var panelStyle = {
        position: 'absolute', zIndex: 40, minWidth: '280px',
        background: 'var(--dsw-alias-bg-layer-1, #1f2430)', color: 'var(--dsw-alias-label-primary, #e5e7eb)',
        border: '1px solid var(--dsw-alias-separator, #374151)', borderRadius: '8px',
        padding: '10px 12px', fontSize: '12px', boxShadow: '0 8px 24px rgba(0,0,0,.35)',
      }
      /* В композере и сайдбаре панель открывается вверх: внизу её срезал бы край. */
      if (shownIn === 'composer' || shownIn === 'sidebar') {
        panelStyle.bottom = '26px'
        panelStyle.left = '0'
      } else {
        panelStyle.top = '26px'
        panelStyle.right = 0
      }
      panel = h('div', { style: panelStyle },
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
            }, LANG_CODE[lang]),
            h('button', {
              type: 'button',
              title: M.placeTip(M.place[place], M.place[nextPlace()]),
              onClick: function (event) { event.stopPropagation(); setPlace(nextPlace()) },
              style: smallButtonStyle(),
            }, '⇄'))),
        rows.map(function (row) {
          return h('div', { key: row[0], style: { display: 'flex', justifyContent: 'space-between', gap: '16px' } },
            h('span', { style: { color: BAND_COLOR[0] } }, row[0]),
            h('span', row[2] ? { style: { color: row[2] } } : null, String(row[1])))
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

  /** remote.commands — отдельный сервис Cordis (`remote.commands`), а не
      свойство сервиса `remote`; поэтому его отдаёт только ctx.inject. */
  function commandService() {
    if (compactCommands && typeof compactCommands.execute === 'function') return compactCommands
    return null
  }

  function compactErrorText(error) {
    if (!error) return ''
    return String(error.message || error)
  }

  /** Поставить статус кнопки и, если нужно, погасить его через delay мс. */
  function setCompactState(setState, next, delay) {
    if (compactResetTimer !== null) {
      clearTimeout(compactResetTimer)
      compactResetTimer = null
    }
    setState(next)
    if (delay > 0) {
      compactResetTimer = setTimeout(function () {
        compactResetTimer = null
        setState(null)
      }, delay)
    }
  }

  function CompactButton(props) {
    var lang = useLang()
    var M = MESSAGES[lang].compact
    var st = React.useState(null)
    var state = st[0]
    var setState = st[1]
    var sessionId = props && props.sessionId
    var busy = !!(state && state.busy)

    var click = React.useCallback(function () {
      if (busy) return
      var commands = commandService()
      if (!commands || !sessionId) {
        setCompactState(setState, { text: M.noChannel, tip: M.tip }, 8000)
        return
      }
      setCompactState(setState, { text: M.busy, tip: M.tip, busy: true }, 0)
      var pending
      try {
        pending = commands.execute(sessionId, '/compact', [])
      } catch (error) {
        setCompactState(setState, { text: M.failed, tip: compactErrorText(error) || M.tip }, 8000)
        return
      }
      Promise.resolve(pending).then(function (reply) {
        if (!reply || reply.ok !== true) {
          var reason = reply && reply.error ? (reply.error.message || reply.error.code) : ''
          setCompactState(setState, { text: M.failed, tip: compactErrorText(reason) || M.tip }, 8000)
          return
        }
        /* value === undefined: хост не знает такой команды (старая сборка). */
        if (reply.value === undefined) {
          setCompactState(setState, { text: M.unknown, tip: M.tip }, 8000)
          return
        }
        var outcome = reply.value.result || {}
        if (outcome.kind === 'success') {
          /* Тексты штатной /compact: «Compacted N …» или «No compactable
             history yet.». Не узнали — честное «готово», а не «сжато». */
          var hostText = String(outcome.text || '')
          var shown = M.done
          if (/^Compacted\b/i.test(hostText)) shown = M.compacted
          else if (/no compactable history/i.test(hostText)) shown = M.nothing
          setCompactState(setState, { text: shown, tip: hostText || M.tip }, 5000)
        } else {
          setCompactState(setState, { text: M.failed, tip: outcome.text || M.tip }, 8000)
        }
      }, function (error) {
        setCompactState(setState, { text: M.failed, tip: compactErrorText(error) || M.tip }, 8000)
      })
    }, [sessionId, lang, busy])

    return h('button', {
      type: 'button',
      onClick: click,
      disabled: busy,
      title: state && state.tip ? state.tip : M.tip,
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 8px', borderRadius: '999px', cursor: busy ? 'default' : 'pointer', opacity: busy ? '0.7' : '1',
        border: '1px solid var(--dsw-alias-separator, #374151)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #9ca3af)', fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap',
      },
    }, h('span', null, M.label), state ? h('span', { style: { marginLeft: '4px' } }, state.text) : null)
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
        function (props) {
          var p = props || {}
          return h(Governor, { sessionId: p.sessionId, place: 'header' })
        },
      )
    })

    /* Бейдж можно переставить под поле ввода и в низ сайдбара. Рендерится
       только слот, совпавший с сохранённым местом; остальные отдают null. */
    ctx.slots.inject('conversation.composer.dock', function () {
      return ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'context-governor-composer', order: 20 },
        function (props) {
          var p = props || {}
          return h(Governor, { sessionId: p.sessionId, place: 'composer' })
        },
      )
    })

    ctx.slots.inject('sidebar.footer.action', function () {
      return ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'context-governor-sidebar', order: 20 },
        function (props) {
          var p = props || {}
          return h(Governor, { place: 'sidebar', wide: p.wide })
        },
      )
    })

    /* Кнопка compact живёт в отдельном дочернем плагине: без remote.commands
       чип и handoff всё равно должны загрузиться, а кнопка просто не появится. */
    if (typeof ctx.inject === 'function') {
      ctx.inject(['remote', 'remote.commands'], function (scope) {
        try {
          compactCommands = typeof scope.get === 'function' ? scope.get('remote.commands') : undefined
          if (!compactCommands && scope.remote) compactCommands = scope.remote.commands
        } catch (error) {
          compactCommands = null
        }
        scope.slots.inject('conversation.input.right', function () {
          return scope.slots.register(
            { name: 'conversation.input.right', id: 'context-governor-compact', order: 89 },
            function (props) {
              var p = props || {}
              return h(CompactButton, { sessionId: p.sessionId })
            },
          )
        })
      })
    }

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

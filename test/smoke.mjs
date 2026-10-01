#!/usr/bin/env node
/**
 * Smoke test for dsh-context-governor (host half).
 *
 * Runs the plugin against a stub harness — no server, no network, no model
 * calls — and pins the numbers users actually see: per-session compaction
 * threshold, cache buckets, step cost and the balance provider gate.
 *
 * Run with: node test/smoke.mjs   (or: npm test)
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* The DeepSeek balance must not be attempted for real: without a credentials
   service the plugin falls back to the environment, so clear it here. */
delete process.env.DEEPSEEK_API_KEY

const root = new URL('..', import.meta.url)
const RATES = { freshRate: 0.15, cacheReadRate: 0.003, cacheWriteRate: 0.15, outputRate: 0.6, peakMultiplier: 2 }
/* Никакой сети и никакого чужого кэша: тесты должны быть детерминированными. */
const OFFLINE = { holidayFetch: false, holidayCacheDir: mkdtempSync(join(tmpdir(), 'ctx-gov-')) }

let passed = 0
let failed = 0

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (detail === undefined ? '' : '  → ' + detail))
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected))
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Словари интерфейса не экспортируются из клиентского бандла, поэтому вытаскиваем
    литерал MESSAGES из исходника. Пропущенный в языке ключ даёт «undefined» прямо
    в панели — так и вылез balanceUnknown, который был только в ru. */
function clientMessages(source) {
  const marker = source.match(/MESSAGES\s*=\s*\{/)
  if (!marker) throw new Error('MESSAGES not found in the client bundle')
  const start = marker.index + marker[0].length - 1
  let depth = 0
  let end = -1
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) throw new Error('MESSAGES literal is not balanced')
  return eval('(' + source.slice(start, end + 1) + ')')
}

/** Ключи, которых нет в `to` (рекурсивно по вложенным словарям, массивы не трогаем). */
function missingKeys(from, to, prefix) {
  const out = []
  for (const key of Object.keys(from)) {
    if (!(key in to)) { out.push(prefix + key); continue }
    const a = from[key]
    const b = to[key]
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      out.push(...missingKeys(a, b, prefix + key + '.'))
    }
  }
  return out
}

/** Собрать весь видимый текст из дерева элементов createElement. */
function flattenText(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) {
    for (const item of node) flattenText(item, out)
    return out
  }
  if (typeof node === 'object') {
    if (node.props && typeof node.props.title === 'string') out.push(node.props.title)
    for (const child of node.children || []) flattenText(child, out)
  }
  return out
}

/** Поднять клиентский бандл с заглушкой React и отрисовать чип с панелью:
    проверяется то, что реально попадает в интерфейс, а не исходник. */
function clientRender(source, payload, lang) {
  let factory
  let queue = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (initial) => [queue.length > 0 ? queue.shift() : (typeof initial === 'function' ? initial() : initial), () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: { load: ({ factory: captured }) => { factory = captured } },
    localStorage: { getItem: () => null, setItem() {} },
  }
  try {
    new Function(source)() // eslint-disable-line no-new-func
    const mod = factory((name) => {
      if (name === 'react') return react
      throw new Error('client render: unexpected require ' + name)
    })
    const registered = []
    mod.apply({ slots: { inject: (name, callback) => callback(), register: (spec, component) => { registered.push(component); return () => {} } } })
    queue = [lang, payload, true]
    return flattenText(registered[0]({ sessionId: 'sess' }), []).join(' | ')
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
}

/** Ответ /api/status: значения по умолчанию — не-DeepSeek провайдер без ставок. */
function statusPayload(overrides = {}) {
  const payload = {
    ok: true,
    config: { base: 100000, compactThreshold: 126272, windowTokens: 200000, reservedTokens: 8192, route: 'cline/x', windowSource: 'catalog', provider: 'cline', priced: false },
    current: { session: 's', prompt: 1050, fresh: 100, cacheRead: 900, cacheWrite: 50, output: 20, freshDelta: 100, cacheHitPct: 86, cacheHitText: '86', relative: null, costUsd: null, band: 0, ts: 1 },
    children: [],
    childrenPromptSum: 0,
    season: null,
    rates: null,
    warnings: [],
    balance: { ok: false, state: 'other-provider', provider: 'cline' },
  }
  for (const key of Object.keys(overrides)) payload[key] = overrides[key]
  return payload
}

/** Minimal Cordis-like context. Options switch off optional services so both
    data paths (projections and the llm/stream fallback) can be exercised. */
function makeHarness(options = {}) {
  const hooks = {}
  const registered = []
  const state = { usage: {}, pressure: {}, onChange: null }
  const services = {
    sessions: { list: () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  }
  if (options.projections !== false) {
    services.sessionProjections = {
      onChanged(cb) {
        state.onChange = cb
        return () => { state.onChange = null }
      },
      stateOf(session, key) {
        const id = session.header.id
        if (key === 'tokenUsage') return state.usage[id]
        if (key === 'contextPressure') return state.pressure[id]
        return undefined
      },
    }
  }
  if (options.llm !== false) {
    services.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000000 }, defaultMaxTokens: 256000 }) }
  }
  const ctx = {
    on(name, fn) { (hooks[name] = hooks[name] || []).push(fn) },
    get(name) { return services[name] },
    logger() { return { info() {} } },
    webServer: { register(entry) { registered.push(entry) } },
    effect(fn) { try { return fn() } catch (error) { return undefined } },
  }
  return { ctx, hooks, registered, state, services }
}

/** Drive one session the way the live runtime does: request header (reserve),
    context pressure (window) and a settled token-usage sample. */
function feedSession(harness, session, spec) {
  const onEvent = (harness.hooks['session/event'] || [])[0]
  onEvent(session, {
    type: 'request/header',
    data: { header: { config: { provider: spec.provider, model: spec.model, maxTokens: spec.maxTokens } } },
  })
  if (spec.window) {
    harness.state.pressure[session.header.id] = { contextWindow: spec.window, pressureTokens: spec.pressureTokens || 0 }
  }
  harness.state.usage[session.header.id] = {
    /* Проекция отдаёт и итоги сессии, и последний шаг. Итоги — для cache-hit. */
    totals: spec.totals || spec.buckets,
    last: { buckets: spec.buckets },
  }
  harness.state.onChange(session, 'tokenUsage', {}, 1)
}

async function statusOf(harness, sessionId) {
  const handler = harness.registered[0].handler
  const query = 'ver=test&tz=10800&lang=ru' + (sessionId ? '&sessionId=' + sessionId : '')
  let body = ''
  await handler({ url: '/context-governor/api/status?' + query, headers: { 'x-dsh-context-governor': '1' }, method: 'GET' },
    { setHeader() {}, end(text) { body = text } })
  for (let i = 0; i < 50 && !body; i += 1) await tick()
  return body ? JSON.parse(body) : null
}

async function main() {
  const mod = await import(new URL('index.js', root))
  const clientSource = readFileSync(new URL('client.js', root), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

  console.log('manifest')
  eq('name', mod.name, 'dsh-context-governor')
  eq('version', manifest.version, '0.2.3')
  eq('not private', manifest.private, undefined)
  eq('bundle patch declared', manifest.dsh.bundle.patch, './cordis.patch.yml')
  ok('version gate declared', typeof manifest.peerDependencies['@deepseek-ai/dsh-session-projection'] === 'string')
  ok('core services injected', ['webServer', 'sessions', 'llm', 'agentDefaultModel', 'sessionQuery'].every((s) => mod.inject.includes(s)))

  console.log('projection path')
  const h = makeHarness()
  mod.apply(h.ctx, Object.assign({}, RATES, OFFLINE, { balanceEnabled: true, useAccountBalance: true }))

  const cline = { header: { id: 'sess-cline' } }
  feedSession(h, cline, {
    provider: 'cline',
    model: 'inclusionai/ling-3.0-flash-sante:free',
    maxTokens: 8192,
    window: 200000,
    buckets: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 20 },
  })
  const deepseek = { header: { id: 'sess-deepseek' } }
  feedSession(h, deepseek, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 256000,
    window: 1000000,
    buckets: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 },
  })
  await tick()

  const c = await statusOf(h, 'sess-cline')
  eq('cline window', c.config.windowTokens, 200000)
  eq('cline reserve', c.config.reservedTokens, 8192)
  eq('cline threshold', c.config.compactThreshold, 126272)
  eq('cline route', c.config.route, 'cline/inclusionai/ling-3.0-flash-sante:free')
  eq('cline provider', c.config.provider, 'cline')
  /* Источник окна — код для клиента, не готовый русский текст: иначе значение
     не переводится в en и zh. */
  eq('window source is a code', c.config.windowSource, 'catalog')
  eq('buckets are split', c.current.cacheRead + '/' + c.current.cacheWrite, '900/50')
  eq('prompt', c.current.prompt, 1050)
  eq('cache-hit counts reads only', c.current.cacheHitPct, 86)
  eq('cache-hit text for a plain ratio', c.current.cacheHitText, '86')
  /* DSH не отдаёт токен-цены ни моделям, ни провайдерам: для Cline плагин не
     выдумывает deepseek-тариф и не показывает ни цену, ни сезон DeepSeek. */
  eq('cline price is unknown to plugin', c.current.costUsd, null)
  eq('cline relative is unknown', c.current.relative, null)
  eq('no DeepSeek tariff on cline', c.season, null)
  eq('cline rates hidden', c.rates, null)
  eq('cline has no known rates', c.config.priced, false)
  eq('balance hidden off DeepSeek', c.balance.state, 'other-provider')
  eq('balance names the provider', c.balance.provider, 'cline')
  ok('response carries no dead fields',
    c.current.cached === undefined && c.config.bands === undefined && c.config.routes === undefined)

  const d = await statusOf(h, 'sess-deepseek')
  eq('deepseek threshold', d.config.compactThreshold, 678464)
  ok('deepseek balance is attempted', d.balance.state === 'no-credential', JSON.stringify(d.balance))
  eq('deepseek rates are known to the client', d.config.priced, true)
  ok('deepseek keeps the seasonal tariff', d.season !== null && typeof d.season.peak === 'boolean', JSON.stringify(d.season))
  /* Календаря нет (сеть выключена) — клиент должен знать, что тариф приблизительный. */
  eq('missing holiday calendar is reported', d.season.holidayKnown, false)

  console.log('per-provider rates and a flat tariff')
  /* Чужой провайдер со своими ставками: цену считаем по НИМ, но сезона DeepSeek
     у него нет — пик его ставки не удваивает и Пекин ему не указ. */
  const hFlat = makeHarness()
  mod.apply(hFlat.ctx, Object.assign({}, RATES, OFFLINE, {
    pricedProviders: [],
    providerRates: { cline: { freshRate: 0.5, cacheReadRate: 0.05, cacheWriteRate: 0.5, outputRate: 1.5, seasonal: false } },
    balanceEnabled: false,
  }))
  feedSession(hFlat, { header: { id: 'sess-flat' } }, {
    provider: 'cline',
    model: 'some/model',
    maxTokens: 8192,
    window: 200000,
    buckets: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 20 },
  })
  await tick()
  const flat = await statusOf(hFlat, 'sess-flat')
  eq('a provider with its own rates is priced', flat.config.priced, true)
  eq('the provider rates are used',
    flat.rates.fresh + '/' + flat.rates.cacheRead + '/' + flat.rates.cacheWrite + '/' + flat.rates.output, '0.5/0.05/0.5/1.5')
  eq('a flat provider has no DeepSeek season', flat.season, null)
  /* (100*0.5 + 900*0.05 + 50*0.5 + 20*1.5) / 1e6 = 0.00015 */
  eq('the step cost follows the provider rates', flat.current.costUsd, 0.00015)
  /* (100 + 900*(0.05/0.5) + 50*(0.5/0.5)) / 100000 = 0.0024 → 0.002 */
  eq('relative uses the provider rates', flat.current.relative, 0.002)

  console.log('a foreign provider can opt into the DeepSeek season')
  const hSeas = makeHarness()
  mod.apply(hSeas.ctx, Object.assign({}, RATES, OFFLINE, {
    pricedProviders: ['cline'],
    providerRates: { cline: { seasonal: true } },
    balanceEnabled: false,
  }))
  feedSession(hSeas, { header: { id: 'sess-seas' } }, {
    provider: 'cline',
    model: 'some/model',
    maxTokens: 8192,
    window: 200000,
    buckets: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 20 },
  })
  await tick()
  const seas = await statusOf(hSeas, 'sess-seas')
  ok('seasonal: true brings the tariff back', seas.season !== null && typeof seas.season.peak === 'boolean', JSON.stringify(seas.season))
  /* Базовые ставки общие; сезон применяется по факту момента, поэтому сверяем
     с ожидаемым множителем, а не с фиксированным числом. */
  eq('the default rates apply there', seas.rates.fresh, 0.15 * (seas.season.peak ? 2 : 1))

  console.log('tariff calendar: Chinese public holidays')
  /* DeepSeek: пик — будни 09:00–12:00 и 14:00–18:00 по Пекину, НО в гос.
     праздники Китая off-peak круглые сутки. 1–7 октября 2026 — Национальный
     день; 8 октября — первый рабочий день; 10 октября — рабочая суббота
     (перенос), но для DeepSeek выходные всё равно off-peak. */
  const bj = (y, mo, day, hh, mm) => new Date(Date.UTC(y, mo - 1, day, hh, mm) - 8 * 3600 * 1000)
  const nationalDay = new Set(Array.from({ length: 7 }, (_, i) => '2026-10-0' + (i + 1)))
  const octFirst = bj(2026, 10, 1, 9, 49)
  eq('a weekday peak is peak without a calendar', mod.isPeak(octFirst, new Set()), true)
  eq('National Day is off-peak even on a Thursday', mod.isPeak(octFirst, nationalDay), false)
  eq('the next working day is peak again', mod.isPeak(bj(2026, 10, 8, 9, 30), nationalDay), true)
  eq('a weekend stays off-peak', mod.isPeak(bj(2026, 10, 3, 10, 0), nationalDay), false)
  eq('a workday-adjusted Saturday stays off-peak', mod.isPeak(bj(2026, 10, 10, 10, 0), nationalDay), false)
  eq('countdown skips the whole 7-day holiday',
    mod.nextFlip(octFirst, nationalDay).valueOf(), bj(2026, 10, 8, 9, 0).valueOf())
  /* Пик — дорогие часы: цвет уходит в красный, вне пика остаётся зелёным.
     Клиент красит им баланс и время в чипе и панели. */
  eq('peak colour is red', mod.seasonAt(bj(2026, 10, 8, 9, 30), 2, new Set()).color, '#EF4444')
  eq('off-peak colour is green', mod.seasonAt(bj(2026, 10, 8, 20, 0), 2, new Set()).color, '#57C07C')
  eq('a holiday is green even in a weekday window', mod.seasonAt(octFirst, 2, nationalDay).color, '#57C07C')

  const h4 = makeHarness()
  const todayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  mod.apply(h4.ctx, Object.assign({}, RATES, OFFLINE, { holidays: [todayKey] }))
  feedSession(h4, { header: { id: 'sess-holiday' } }, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 256000,
    window: 1000000,
    buckets: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 },
  })
  await tick()
  const manual = await statusOf(h4, 'sess-holiday')
  eq('a manual holiday marks the day off-peak', manual.season.holiday, true)
  eq('a manual holiday counts as a known calendar', manual.season.holidayKnown, true)

  /* Второй запуск без сети должен поднять календарь с диска, а не потерять его. */
  const cacheDir = mkdtempSync(join(tmpdir(), 'ctx-gov-cache-'))
  const cacheYear = Number(todayKey.slice(0, 4))
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'holidays-' + cacheYear + '.json'),
    JSON.stringify({ year: cacheYear, dates: [todayKey], fetchedAt: 'test' }))
  const h5 = makeHarness()
  mod.apply(h5.ctx, Object.assign({}, RATES, OFFLINE, { holidayFetch: false, holidayCacheDir: cacheDir }))
  feedSession(h5, { header: { id: 'sess-cache' } }, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 256000,
    window: 1000000,
    buckets: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 },
  })
  await tick()
  const cached = await statusOf(h5, 'sess-cache')
  eq('the on-disk calendar is used offline', cached.season.holiday, true)
  eq('the cached calendar counts as known', cached.season.holidayKnown, true)

  console.log('cache-hit: session scope, honest percent')
  /* Живой случай: последний шаг 534912/535089 = 99.97% (старый Math.round давал
     «100%»), а по итогам сессии — 99.80%, как показывает сам harness. */
  const mixed = { header: { id: 'sess-mixed' } }
  feedSession(h, mixed, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 256000,
    window: 1000000,
    buckets: { uncachedInputTokens: 177, cacheReadTokens: 534912, cacheWriteTokens: 0, outputTokens: 705 },
    totals: { uncachedInputTokens: 199241, cacheReadTokens: 100769408, cacheWriteTokens: 0, outputTokens: 366594 },
  })
  await tick()
  const mix = await statusOf(h, 'sess-mixed')
  eq('context stays the last step', mix.current.prompt, 535089)
  eq('cache-hit uses session totals', mix.current.cacheHitPct, 99)
  eq('partial hit is never rounded to 100', mix.current.cacheHitText, '99.8')

  const full = { header: { id: 'sess-full' } }
  feedSession(h, full, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 256000,
    window: 1000000,
    buckets: { uncachedInputTokens: 0, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 10 },
  })
  await tick()
  const f = await statusOf(h, 'sess-full')
  eq('a full hit is exactly 100', f.current.cacheHitText, '100')

  console.log('unknown window')
  const h2 = makeHarness({ llm: false })
  mod.apply(h2.ctx, Object.assign({}, RATES, OFFLINE, { balanceEnabled: true }))
  const bare = { header: { id: 'sess-bare' } }
  feedSession(h2, bare, {
    provider: 'cline',
    model: 'cohere/north-mini-code:free',
    maxTokens: 4096,
    buckets: { uncachedInputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3 },
  })
  await tick()
  const u = await statusOf(h2, 'sess-bare')
  eq('no invented threshold', u.config.compactThreshold, 0)
  eq('no invented window', u.config.windowTokens, 0)
  eq('request source is a code', u.config.windowSource, 'request')
  ok('windowUnknown warning', u.warnings.some((w) => w.code === 'windowUnknown'), JSON.stringify(u.warnings))
  eq('balance still gated', u.balance.state, 'other-provider')

  console.log('llm/stream fallback')
  const h3 = makeHarness({ projections: false })
  mod.apply(h3.ctx, Object.assign({}, RATES, OFFLINE, { balanceEnabled: false }))
  ok('fallback subscribed', Array.isArray(h3.hooks['llm/stream']) && h3.hooks['llm/stream'].length === 1)
  const onEvent = h3.hooks['session/event'][0]
  onEvent({ header: { id: 'sess-stream' } }, {
    type: 'request/header',
    data: { header: { config: { provider: 'cline', model: 'x/y', maxTokens: 4096 } } },
  })
  const stream = h3.hooks['llm/stream'][0]
  async function* chunks() {
    yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 20 } }
  }
  const tracked = stream({ sessionId: 'sess-stream' }, () => chunks())
  for await (const _chunk of tracked) { /* drain */ }
  const s = await statusOf(h3, 'sess-stream')
  eq('fallback buckets', s.current.cacheRead + '/' + s.current.cacheWrite, '900/50')
  eq('fallback cost', s.current.costUsd, null)

  console.log('client bundle')
  ok('module loader format', clientSource.includes('__ModuleLoader__'))
  for (const marker of ['uiIdentity', 'cacheRead', 'cacheWrite', 'other-provider', 'windowSources', 'cacheHitText', 'noPrice', 'balanceUnknown', 'money2', 'cfgInfo.priced !== false']) {
    ok('client has ' + marker, clientSource.includes(marker))
  }
  ok('client has no stale fallback bands', !clientSource.includes('temporary bands') && !clientSource.includes('полосы временные'))
  /* Каждый язык обязан иметь те же ключи, что en: отсутствие ключа рисует
     буквальное «undefined» вместо текста (баланс на не-DeepSeek провайдере). */
  const messages = clientMessages(clientSource)
  for (const lang of ['zh', 'ru']) {
    const diff = missingKeys(messages.en, messages[lang], '')
      .concat(missingKeys(messages[lang], messages.en, ''))
    ok('i18n ' + lang + ' has the same keys as en', diff.length === 0, 'differs: ' + diff.join(', '))
  }

  /* Цена — только там, где плагин знает ставки: на не-DeepSeek провайдере её нет
     ни в чипе, ни в панели, ни в подсказке, и множитель тарифа тоже не показываем. */
  console.log('client render: price and season only where they belong')
  /* season null — так host отвечает и на не-DeepSeek, и на плоский тариф. */
  const unpricedPayload = statusPayload()
  const flatPayload = statusPayload({
    config: { base: 100000, compactThreshold: 126272, windowTokens: 200000, reservedTokens: 8192, route: 'other/model', windowSource: 'catalog', provider: 'other', priced: true },
    current: { session: 's', prompt: 1050, fresh: 100, cacheRead: 900, cacheWrite: 50, output: 20, freshDelta: 100, cacheHitPct: 86, cacheHitText: '86', relative: 0.002, costUsd: 0.00015, band: 0, ts: 1 },
    rates: { fresh: 0.5, cacheRead: 0.05, cacheWrite: 0.5, output: 1.5 },
  })
  const deepseekPayload = statusPayload({
    config: { base: 100000, compactThreshold: 678464, windowTokens: 1000000, reservedTokens: 256000, route: 'deepseek-official/deepseek-flash', windowSource: 'catalog', provider: 'deepseek-official', priced: true },
    current: { session: 's', prompt: 1050, fresh: 100, cacheRead: 900, cacheWrite: 50, output: 20, freshDelta: 100, cacheHitPct: 86, cacheHitText: '86', relative: 0.015, costUsd: 0.0013, band: 0, ts: 1 },
    rates: { fresh: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 },
    season: { peak: true, holiday: false, countdown: '2h', multiplier: 2, beijing: { weekdayIndex: 4, clock: '10:00' }, color: '#EF4444', holidayKnown: true },
    balance: { ok: true, state: 'ok', source: 'api-key', currency: 'USD', total: 8.95, granted: 0, toppedUp: 8.95, isAvailable: true },
  })
  for (const lang of ['en', 'ru', 'zh']) {
    const M = messages[lang]
    /* Строки про тариф ловим по уникальным подписям: у zh «费率» — часть
       подписи строки ставок, поэтому по ней одну судить нельзя. */
    const seasonRows = (text) => text.includes(M.rows.tariffFlip) || text.includes(M.rows.beijing)
    const priceRows = (text) => text.includes(M.rows.cost) && text.includes(M.rows.rates)

    const unpriced = clientRender(clientSource, unpricedPayload, lang)
    ok('no price on a provider without rates (' + lang + ')',
      !unpriced.includes(M.noPrice) && !priceRows(unpriced) && !seasonRows(unpriced) && !unpriced.includes('×2'),
      unpriced)
    ok('no undefined text off DeepSeek (' + lang + ')', !unpriced.includes('undefined'), unpriced)

    /* Плоский чужой провайдер: цена есть (свои ставки), сезона DeepSeek нет. */
    const flat = clientRender(clientSource, flatPayload, lang)
    ok('a flat provider shows its price (' + lang + ')', flat.includes('$0.0001') && priceRows(flat), flat)
    ok('a flat provider shows no DeepSeek season (' + lang + ')',
      !seasonRows(flat) && !flat.includes('×2'), flat)

    const seasonal = clientRender(clientSource, deepseekPayload, lang)
    ok('a seasonal provider shows the tariff (' + lang + ')',
      priceRows(seasonal) && seasonRows(seasonal) && seasonal.includes('×2') && seasonal.includes('$0.0013'),
      seasonal)
  }

  console.log('')
  console.log(passed + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error('smoke test crashed: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})

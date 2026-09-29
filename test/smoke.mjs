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

import { readFileSync } from 'node:fs'

/* The DeepSeek balance must not be attempted for real: without a credentials
   service the plugin falls back to the environment, so clear it here. */
delete process.env.DEEPSEEK_API_KEY

const root = new URL('..', import.meta.url)
const RATES = { freshRate: 0.15, cacheReadRate: 0.003, cacheWriteRate: 0.15, outputRate: 0.6, peakMultiplier: 2 }

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
  harness.state.usage[session.header.id] = { last: { buckets: spec.buckets } }
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
  eq('version', manifest.version, '0.2.0')
  eq('not private', manifest.private, undefined)
  eq('bundle patch declared', manifest.dsh.bundle.patch, './cordis.patch.yml')
  ok('version gate declared', typeof manifest.peerDependencies['@deepseek-ai/dsh-session-projection'] === 'string')
  ok('core services injected', ['webServer', 'sessions', 'llm', 'agentDefaultModel', 'sessionQuery'].every((s) => mod.inject.includes(s)))

  console.log('projection path')
  const h = makeHarness()
  mod.apply(h.ctx, Object.assign({}, RATES, { balanceEnabled: true, useAccountBalance: true }))

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
  eq('buckets are split', c.current.cacheRead + '/' + c.current.cacheWrite, '900/50')
  eq('prompt', c.current.prompt, 1050)
  eq('cache-hit counts reads only', c.current.cacheHitPct, 86)
  eq('step cost', c.current.costUsd, 0.000037)
  eq('relative to base', c.current.relative, 0.002)
  eq('balance hidden off DeepSeek', c.balance.state, 'other-provider')
  eq('balance names the provider', c.balance.provider, 'cline')
  ok('response carries no dead fields',
    c.current.cached === undefined && c.config.bands === undefined && c.config.routes === undefined)

  const d = await statusOf(h, 'sess-deepseek')
  eq('deepseek threshold', d.config.compactThreshold, 678464)
  ok('deepseek balance is attempted', d.balance.state === 'no-credential', JSON.stringify(d.balance))

  console.log('unknown window')
  const h2 = makeHarness({ llm: false })
  mod.apply(h2.ctx, Object.assign({}, RATES, { balanceEnabled: true }))
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
  ok('windowUnknown warning', u.warnings.some((w) => w.code === 'windowUnknown'), JSON.stringify(u.warnings))
  eq('balance still gated', u.balance.state, 'other-provider')

  console.log('llm/stream fallback')
  const h3 = makeHarness({ projections: false })
  mod.apply(h3.ctx, Object.assign({}, RATES, { balanceEnabled: false }))
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
  eq('fallback cost', s.current.costUsd, 0.000037)

  console.log('client bundle')
  ok('module loader format', clientSource.includes('__ModuleLoader__'))
  for (const marker of ['uiIdentity', 'cacheRead', 'cacheWrite', 'other-provider']) {
    ok('client has ' + marker, clientSource.includes(marker))
  }
  ok('client has no stale fallback bands', !clientSource.includes('temporary bands') && !clientSource.includes('полосы временные'))

  console.log('')
  console.log(passed + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error('smoke test crashed: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { start } from '../src/router/server.ts'
import { create as createTiers } from '../src/router/tiers.ts'
import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import type {
  Applied,
  Config,
  Identity,
  Keychain,
  Observation,
  Pin,
  Retry,
  Route,
  Spend,
  StartOpts,
  TierSnapshot,
  Tiers,
  Transforms,
  Upstreams,
  Usage,
} from '../src/types.ts'

const SERVICE = 'Vercel AI Gateway Work'
const NO_IDENTITY_MESSAGE = 'barrito: no identity for this request — run barrito doctor'

const config = (): Config => ({
  port: 0,
  default: 'work',
  identities: {
    work: {
      id: 'work',
      claude_config_dir: '/tmp/barrito-claude',
      share_from: null,
      fallback: ['zai/glm-5.3'],
      match: { remotes: [], paths: [] },
      keychain: { gateway: SERVICE },
    } satisfies Identity,
  },
  models: { include: [], exclude: [], require: [], max_input_price: null, pin: [], labels: {}, suffix: {}, agents: {} },
  graft: { roots: [], repos: [] },
  harness: {},
})
const claudeHeaders = {
  'content-type': 'application/json',
  'x-barrito-identity': 'work',
  authorization: 'Bearer max-oauth',
}

type Snap = Record<string, Partial<TierSnapshot>>
type ObserveCall = { id: string } & Observation
type TiersCalls = {
  route: Array<{ id: string; model: string }>
  observe: ObserveCall[]
  pin: Array<{ id: string; value: Pin }>
}
// snapshot returns partial entries (the router only reads what it needs) — StartOpts.tiers is RouterTiers
type FakeTiers = Omit<Tiers, 'snapshot'> & { calls: TiersCalls; snapshot: () => Snap }

const fakeTiers = ({ route, retries = [] }: { route?: Route; retries?: Array<{ retry: Retry | null }> } = {}): FakeTiers => {
  const calls: TiersCalls = { route: [], observe: [], pin: [] }
  const queue = [...retries]
  const tiers: FakeTiers = {
    calls,
    route: (id, model) => {
      calls.route.push({ id, model })
      return route ?? { to: 'direct' }
    },
    observe: (id, e) => {
      calls.observe.push({ id, ...e })
      return queue.shift() ?? { retry: null }
    },
    pin: (id, value) => calls.pin.push({ id, value }),
    snapshot: () => ({}),
  }
  return tiers
}

type FakeKeys = Keychain & { calls: string[]; set: (service: string, value: string) => void }

const fakeKeys = (initial: Record<string, string>): FakeKeys => {
  const calls: string[] = []
  const values: Record<string, string> = { ...initial }
  return {
    calls,
    get: (service: string) => {
      calls.push(service)
      return values[service] ?? null
    },
    set: (service: string, value: string) => {
      values[service] = value
    },
  }
}

type SpendCall = { id: string; model: string; usage: Usage }
type FakeSpend = Spend & { calls: SpendCall[] }

const fakeSpend = (): FakeSpend => {
  const calls: SpendCall[] = []
  return {
    calls,
    record: (id: string, model: string, usage: Usage) => calls.push({ id, model, usage }),
    today: () => ({ work: 1.5 }),
  }
}

type TxCall = { kind: 'anthropic' | 'openai'; id: string; model: unknown }
type TxSetCall = { id: string; patch: unknown }
type FakeTransforms = Transforms & { calls: TxCall[]; sets: TxSetCall[] }

// applies the given Applied to every JSON body, optionally rewriting it; junk/empty bodies never reach it
const fakeTransforms = (
  applied: Applied,
  rewrite?: (body: Record<string, unknown>) => Record<string, unknown>,
  extras: Partial<Transforms> = {},
): FakeTransforms => {
  const calls: TxCall[] = []
  const sets: TxSetCall[] = []
  return {
    calls,
    sets,
    state: () => ({ rtk: applied.rtk > 0, caveman: applied.caveman }),
    set: (id: string, patch: unknown) => {
      sets.push({ id, patch })
      return { rtk: true, caveman: 'lite' }
    },
    anthropic: (id: string, body: Record<string, unknown>) => {
      calls.push({ kind: 'anthropic', id, model: body.model })
      return { body: rewrite ? rewrite(body) : body, applied }
    },
    openai: (id: string, body: Record<string, unknown>) => {
      calls.push({ kind: 'openai', id, model: body.model })
      return { body: rewrite ? rewrite(body) : body, applied }
    },
    available: () => true,
    stats: () => ({ work: { saved: 0, compressed: 0 } }),
    ...extras,
  }
}

type Entry = {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: Buffer
  req: IncomingMessage
  res: ServerResponse
}

const parse = (buf: Buffer | undefined): { model?: string; system?: unknown } => JSON.parse(String(buf ?? ''))

type Json = {
  ok?: boolean
  type?: string
  error?: { type?: string; message?: string }
  pid?: number
  uptime?: number
  identities?: Snap
  spend?: Record<string, number>
  choices?: unknown[]
  rtk?: boolean
  state?: { rtk?: boolean; caveman?: string }
  transforms?: Record<string, { state?: { rtk?: boolean; caveman?: string }; saved?: number; compressed?: number }>
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

// wraps a fake upstream handler, capturing method/url/headers/body per request
const capture = (handle: (entry: Entry) => void) => {
  const seen: Entry[] = []
  return {
    seen,
    handler(req: IncomingMessage, res: ServerResponse) {
      res.on('error', () => {})
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const entry: Entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks), req, res }
        seen.push(entry)
        handle(entry)
      })
    },
  }
}

const ok = (entry: Entry, body = '{}') => {
  entry.res.writeHead(200, { 'content-type': 'application/json' })
  entry.res.end(body)
}

const sse = (res: ServerResponse, events: unknown[], gap = 0) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  events.reduce((at: number, event: unknown, i: number) => {
    setTimeout(() => res.write(`data: ${JSON.stringify(event)}\n\n`), at + i * gap)
    return at
  }, 0)
  setTimeout(() => res.write('data: [DONE]\n\n'), events.length * gap + 5)
  setTimeout(() => res.end(), events.length * gap + 10)
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const boot = async ({
  handler,
  tiers,
  keys,
  spend,
  transforms,
  upstreams,
  maxBody,
}: {
  handler: (req: IncomingMessage, res: ServerResponse) => void
  tiers?: StartOpts['tiers']
  keys?: FakeKeys
  spend?: FakeSpend
  transforms?: Transforms
  upstreams?: Upstreams
  maxBody?: number
}) => {
  const upstream = http.createServer(handler)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const logs: string[] = []
  const opts: StartOpts = {
    config: config(),
    port: 0,
    tiers: tiers ?? fakeTiers(),
    spend: spend ?? fakeSpend(),
    keychain: keys ?? fakeKeys({ [SERVICE]: 'gw-key' }),
    log: (line: string) => logs.push(line),
    transforms,
    maxBody,
    upstreams:
      upstreams ??
      {
        direct: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        gateway: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      },
  }
  const server = start(opts)
  await once(server, 'listening')
  const stop = async () => {
    server.close()
    server.closeAllConnections()
    upstream.close()
    upstream.closeAllConnections()
    await Promise.allSettled([once(server, 'close'), once(upstream, 'close')])
  }
  return { server, port: (server.address() as AddressInfo).port, logs, stop }
}

const call = (
  port: number,
  path: string,
  { method = 'POST', body, headers = {} }: { method?: string; body?: string; headers?: Record<string, string> } = {},
) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body })

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!fn() && Date.now() - t0 < ms) await new Promise<void>((r) => setTimeout(r, 10))
  return fn()
}

test('bare claude model, tier max → direct hop with normalized model and stripped headers', async () => {
  const tiers = fakeTiers({ route: { to: 'direct' } })
  tiers.snapshot = () => ({ work: { tier: 'max' } })
  const spend = fakeSpend()
  const cap = capture((e) => ok(e, '{"ok":true}'))
  const r = await boot({ handler: cap.handler, tiers, spend })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5[1m]', max_tokens: 8 }),
      headers: { ...claudeHeaders, 'x-ai-gateway-api-key': 'Bearer leak' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-barrito-tier'), 'max')
    assert.equal(cap.seen.length, 1)
    assert.equal(cap.seen[0]?.url, '/v1/messages')
    assert.equal(parse(cap.seen[0]?.body).model, 'claude-sonnet-4.5')
    assert.equal(cap.seen[0]?.headers.authorization, 'Bearer max-oauth')
    assert.equal(cap.seen[0]?.headers['x-barrito-identity'], undefined)
    assert.equal(cap.seen[0]?.headers['x-ai-gateway-api-key'], undefined)
    assert.deepEqual(tiers.calls.route[0], { id: 'work', model: 'claude-sonnet-4.5' })
    assert.equal(tiers.calls.observe.length, 1)
    assert.equal(tiers.calls.observe[0]?.to, 'direct')
    assert.equal(tiers.calls.observe[0]?.model, 'claude-sonnet-4.5')
    assert.equal(tiers.calls.observe[0]?.status, 200)
    assert.equal(tiers.calls.observe[0]?.headers['content-type'], 'application/json')
    assert.equal(spend.calls.length, 0)
    assert.match(r.logs[0] ?? '', /^[\dT:.Z-]+ work POST \/v1\/messages claude-sonnet-4\.5 → direct \(-\) 200 \d+ms$/)
  } finally {
    await r.stop()
  }
})

test('tier fallback → gateway /claude-code hop: model rewritten, key swapped, spend recorded', async () => {
  const tiers = fakeTiers({ route: { to: 'gateway', model: 'zai/glm-5.3[1m]', reason: 'quota' } })
  tiers.snapshot = () => ({ work: { tier: 'fallback', model: 'zai/glm-5.3', reason: 'quota', resetAt: 1790000000 } })
  const spend = fakeSpend()
  const keys = fakeKeys({ [SERVICE]: 'gw-key' })
  const cap = capture((e) => ok(e, '{"id":"msg_1","usage":{"input_tokens":100,"output_tokens":7}}'))
  const r = await boot({ handler: cap.handler, tiers, spend, keys })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    assert.equal(cap.seen.length, 1)
    assert.equal(cap.seen[0]?.url, '/claude-code/v1/messages')
    assert.equal(parse(cap.seen[0]?.body).model, 'claude-code/zai/glm-5.3')
    assert.equal(cap.seen[0]?.headers['x-ai-gateway-api-key'], 'Bearer gw-key')
    assert.equal(cap.seen[0]?.headers.authorization, undefined)
    assert.equal(cap.seen[0]?.headers['x-barrito-identity'], undefined)
    assert.equal(res.headers.get('x-barrito-tier'), `fallback:zai/glm-5.3; reason=quota; reset=${new Date(1790000000e3).toISOString()}`)
    assert.deepEqual(spend.calls, [{ id: 'work', model: 'zai/glm-5.3', usage: { input_tokens: 100, output_tokens: 7 } }])
    assert.deepEqual(keys.calls, [SERVICE])
    assert.match(r.logs[0] ?? '', / work POST \/v1\/messages zai\/glm-5\.3 → gateway \(quota\) 200 \d+ms$/)
  } finally {
    await r.stop()
  }
})

test('direct 429 → tiers retry → client gets 200 from gateway with rewritten model', async () => {
  const tiers = fakeTiers({
    route: { to: 'direct' },
    retries: [{ retry: { to: 'gateway', model: 'zai/glm-5.3', reason: 'quota' } }, { retry: null }],
  })
  tiers.snapshot = () => ({ work: { tier: 'fallback', model: 'zai/glm-5.3', reason: 'quota', resetAt: 1790000000 } })
  const cap = capture((e) => {
    if (e.url?.startsWith('/claude-code')) return ok(e, '{"ok":true}')
    e.res.writeHead(429, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'limited',
      'anthropic-ratelimit-unified-5h-utilization': '0.99',
    })
    e.res.end('{}')
  })
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    assert.equal(cap.seen.length, 2)
    assert.equal(parse(cap.seen[1]?.body).model, 'claude-code/zai/glm-5.3')
    assert.equal(tiers.calls.observe.length, 2)
    assert.equal(tiers.calls.observe[0]?.to, 'direct')
    assert.equal(tiers.calls.observe[0]?.status, 429)
    assert.equal(tiers.calls.observe[0]?.headers['anthropic-ratelimit-unified-status'], 'limited')
    assert.equal(tiers.calls.observe[1]?.to, 'gateway')
    assert.equal(tiers.calls.observe[1]?.model, 'zai/glm-5.3')
    assert.equal(tiers.calls.observe[1]?.status, 200)
  } finally {
    await r.stop()
  }
})

test('chain walk: failed gateway hop → observe returns next chain entry', async () => {
  const tiers = fakeTiers({
    route: { to: 'gateway', model: 'zai/glm-5.3', reason: 'quota' },
    retries: [{ retry: { to: 'gateway', model: 'deepseek/deepseek-v4.1-flash', reason: 'quota' } }, { retry: null }],
  })
  tiers.snapshot = () => ({ work: { tier: 'pinned', model: 'zai/glm-5.3' } })
  const spend = fakeSpend()
  const cap = capture((e) => {
    if (parse(e.body).model === 'claude-code/zai/glm-5.3') {
      e.res.writeHead(429, { 'content-type': 'application/json' })
      e.res.end('{}')
      return
    }
    sse(e.res, [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'message_delta', usage: { output_tokens: 9 } },
    ])
  })
  const r = await boot({ handler: cap.handler, tiers, spend })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    await res.text()
    assert.equal(res.headers.get('x-barrito-tier'), 'pinned:zai/glm-5.3')
    assert.equal(cap.seen.length, 2)
    assert.equal(parse(cap.seen[0]?.body).model, 'claude-code/zai/glm-5.3')
    assert.equal(parse(cap.seen[1]?.body).model, 'claude-code/deepseek/deepseek-v4.1-flash')
    assert.deepEqual(spend.calls, [{ id: 'work', model: 'deepseek/deepseek-v4.1-flash', usage: { input_tokens: 5, output_tokens: 9 } }])
  } finally {
    await r.stop()
  }
})

test('every hop attempt is logged, not just the final one', async () => {
  const tiers = fakeTiers({
    route: { to: 'direct' },
    retries: [
      { retry: { to: 'direct', delay: 0 } },
      { retry: { to: 'gateway', model: 'zai/glm-5.3', reason: 'outage' } },
    ],
  })
  const cap = capture((e) => {
    if (e.url?.startsWith('/claude-code')) return ok(e, '{"ok":true}')
    e.res.writeHead(503, { 'content-type': 'application/json' })
    e.res.end('{}')
  })
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    assert.equal(cap.seen.length, 3)
    assert.equal(r.logs.length, 3)
    for (const hop of [r.logs[0], r.logs[1]]) {
      assert.match(hop ?? '', /^[\dT:.Z-]+ work POST \/v1\/messages claude-sonnet-4\.5 → direct 503 \(retry\)$/)
    }
    assert.match(r.logs[2] ?? '', / work POST \/v1\/messages zai\/glm-5\.3 → gateway \(outage\) 200 \d+ms$/)
  } finally {
    await r.stop()
  }
})

test('connect errors on every hop → 502 listing each hop and its error', async () => {
  const tiers = fakeTiers({
    route: { to: 'direct' },
    retries: [{ retry: { to: 'gateway', model: 'zai/glm-5.3', reason: 'outage' } }],
  })
  const cap = capture((e) => ok(e))
  const r = await boot({
    handler: cap.handler,
    tiers,
    upstreams: { direct: 'http://127.0.0.1:1', gateway: 'http://127.0.0.1:1' },
  })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 502)
    const body = await json(res)
    assert.equal(body.type, 'error')
    assert.equal(body.error?.type, 'api_error')
    assert.match(body.error?.message ?? '', /direct:claude-sonnet-4\.5 /)
    assert.match(body.error?.message ?? '', /gateway:zai\/glm-5\.3 /)
    assert.deepEqual(tiers.calls.observe.map((o) => o.status), [0, 0])
    assert.ok(tiers.calls.observe.every((o) => o.error))
  } finally {
    await r.stop()
  }
})

test('unconfirmed direct 429 (real tiers) → forwarded verbatim to Claude Code, no gateway hop, no notify, counted', async () => {
  const notes: string[] = []
  const statePath = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'barrito-router-tiers-'))
  const tiers = createTiers({ config: config(), statePath, notify: (_t, m) => notes.push(m) })
  const body = '{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}'
  const cap = capture((e) => {
    e.res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
    e.res.end(body)
  })
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), '7')
    assert.equal(await res.text(), body)
    assert.equal(res.headers.get('x-barrito-tier'), 'max')
    assert.equal(cap.seen.length, 1)
    assert.ok(cap.seen.every((e) => !e.url?.startsWith('/claude-code')))
    assert.deepEqual(notes, [])
    assert.equal(tiers.snapshot().work?.tier, 'max')
    assert.equal(tiers.snapshot().work?.throttled429Today, 1)
    assert.ok(r.logs.some((l) => / work POST \/v1\/messages claude-sonnet-4\.5 → direct 429 \(passthrough\) \[rate_limit_error: Error\]$/.test(l)))
  } finally {
    await r.stop()
  }
})

test('confirmed direct 429 (real tiers) → falls back to the gateway', async () => {
  const notes: string[] = []
  const statePath = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'barrito-router-tiers-'))
  const tiers = createTiers({ config: config(), statePath, notify: (_t, m) => notes.push(m) })
  const cap = capture((e) => {
    if (e.url?.startsWith('/claude-code')) return ok(e, '{"ok":true}')
    e.res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected' })
    e.res.end('{}')
  })
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    assert.equal(cap.seen.length, 2)
    assert.equal(parse(cap.seen[1]?.body).model, 'claude-code/zai/glm-5.3')
    assert.equal(tiers.snapshot().work?.reason, 'quota')
    assert.equal(notes.length, 1)
  } finally {
    await r.stop()
  }
})

test('pin max + direct 429, chain empty → upstream 429 forwarded verbatim, tier header max', async () => {
  const tiers = fakeTiers({ route: { to: 'direct' } })
  tiers.snapshot = () => ({ work: { tier: 'pinned', model: null } })
  const spend = fakeSpend()
  const cap = capture((e) => {
    e.res.writeHead(429, { 'content-type': 'application/json', 'x-sentinel': 'kept' })
    e.res.end('{"error":{"type":"rate_limit_error"}}')
  })
  const r = await boot({ handler: cap.handler, tiers, spend })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 429)
    assert.equal(await res.text(), '{"error":{"type":"rate_limit_error"}}')
    assert.equal(res.headers.get('x-sentinel'), 'kept')
    assert.equal(res.headers.get('x-barrito-tier'), 'max')
    assert.equal(tiers.calls.observe.length, 1)
    assert.equal(tiers.calls.observe[0]?.status, 429)
    assert.equal(spend.calls.length, 0)
  } finally {
    await r.stop()
  }
})

test('empty fallback chain → last upstream response forwarded verbatim', async () => {
  const tiers = fakeTiers({ route: { to: 'gateway', model: 'zai/glm-5.3', reason: 'quota' } })
  tiers.snapshot = () => ({ work: { tier: 'fallback', model: 'zai/glm-5.3', reason: 'quota', resetAt: 1790000000 } })
  const cap = capture((e) => {
    e.res.writeHead(500, { 'content-type': 'application/json' })
    e.res.end('{"error":{"type":"overloaded_error"}}')
  })
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 500)
    assert.equal(await res.text(), '{"error":{"type":"overloaded_error"}}')
    assert.match(res.headers.get('x-barrito-tier') ?? '', /^fallback:zai\/glm-5\.3; reason=quota/)
    assert.equal(tiers.calls.observe.length, 1)
  } finally {
    await r.stop()
  }
})

test('client aborts mid-request (twice in 60s): no observe, tier untouched, nothing written', async () => {
  const tiers = fakeTiers({ route: { to: 'direct' } })
  const cap = capture((e) => setTimeout(() => ok(e), 300))
  const r = await boot({ handler: cap.handler, tiers })
  try {
    let responded = 0
    const abandon = () =>
      new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: r.port, path: '/v1/messages', method: 'POST', headers: claudeHeaders },
          (res) => {
            responded++
            res.resume()
          },
        )
        req.end(JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }))
        req.on('error', () => {})
        setTimeout(() => req.destroy(), 30)
        req.on('close', resolve)
      })
    await abandon()
    await abandon()
    await pause(150)
    assert.equal(responded, 0)
    assert.equal(tiers.calls.observe.length, 0)
    assert.equal(tiers.calls.route.length, 2)
  } finally {
    await r.stop()
  }
})

test('raw chain entries go to observe; body and spend get [1m]-stripped ids', async () => {
  const tiers = fakeTiers({
    route: { to: 'gateway', model: 'zai/glm-5.3[1m]', reason: 'quota' },
    retries: [{ retry: { to: 'gateway', model: 'deepseek/deepseek-v4.1-flash[1m]', reason: 'quota' } }],
  })
  const spend = fakeSpend()
  const cap = capture((e) => {
    if (parse(e.body).model === 'claude-code/zai/glm-5.3') {
      e.res.writeHead(429, { 'content-type': 'application/json' })
      e.res.end('{}')
      return
    }
    sse(e.res, [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'message_delta', usage: { output_tokens: 4 } },
    ])
  })
  const r = await boot({ handler: cap.handler, tiers, spend })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    await res.text()
    assert.equal(parse(cap.seen[0]?.body).model, 'claude-code/zai/glm-5.3')
    assert.equal(parse(cap.seen[1]?.body).model, 'claude-code/deepseek/deepseek-v4.1-flash')
    assert.equal(tiers.calls.observe[0]?.model, 'zai/glm-5.3[1m]')
    assert.equal(tiers.calls.observe[1]?.model, 'deepseek/deepseek-v4.1-flash[1m]')
    assert.deepEqual(spend.calls, [
      { id: 'work', model: 'deepseek/deepseek-v4.1-flash', usage: { input_tokens: 3, output_tokens: 4 } },
    ])
  } finally {
    await r.stop()
  }
})

test('explicit claude-code/anthropic/* → spend priced with anthropic/ prefix kept', async () => {
  const spend = fakeSpend()
  const cap = capture((e) => ok(e, '{"usage":{"input_tokens":50,"output_tokens":2}}'))
  const r = await boot({ handler: cap.handler, spend })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-code/anthropic/claude-opus-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    await res.text()
    assert.equal(parse(cap.seen[0]?.body).model, 'claude-code/anthropic/claude-opus-4.5')
    assert.deepEqual(spend.calls, [
      { id: 'work', model: 'anthropic/claude-opus-4.5', usage: { input_tokens: 50, output_tokens: 2 } },
    ])
  } finally {
    await r.stop()
  }
})

test('observe retry {to: "direct", delay} waits then resends direct', async () => {
  const tiers = fakeTiers({ route: { to: 'direct' }, retries: [{ retry: { to: 'direct', delay: 40 } }] })
  const cap = capture((e) => {
    if (cap.seen.length === 1) {
      e.res.writeHead(500, { 'content-type': 'application/json' })
      e.res.end('{}')
      return
    }
    ok(e, '{"ok":true}')
  })
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const started = Date.now()
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    assert.ok(Date.now() - started >= 40)
    assert.equal(cap.seen.length, 2)
    assert.deepEqual(tiers.calls.observe.map((o) => o.status), [500, 200])
  } finally {
    await r.stop()
  }
})

test('client abort during retry delay stops the walk', async () => {
  const tiers = fakeTiers({ route: { to: 'direct' }, retries: [{ retry: { to: 'direct', delay: 200 } }] })
  const cap = capture((e) => {
    e.res.writeHead(500, { 'content-type': 'application/json' })
    e.res.end('{}')
  })
  const r = await boot({ handler: cap.handler, tiers })
  try {
    let responded = 0
    await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: r.port, path: '/v1/messages', method: 'POST', headers: claudeHeaders },
        (res) => {
          responded++
          res.resume()
        },
      )
      req.end(JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }))
      req.on('error', () => {})
      setTimeout(() => req.destroy(), 30)
      req.on('close', resolve)
    })
    await pause(400)
    assert.equal(responded, 0)
    assert.equal(cap.seen.length, 1)
    assert.equal(tiers.calls.observe.length, 1)
  } finally {
    await r.stop()
  }
})

test('connect error counts as an attempt with error, then 502', async () => {
  const tiers = fakeTiers({ route: { to: 'direct' } })
  const cap = capture((e) => ok(e))
  const r = await boot({
    handler: cap.handler,
    tiers,
    upstreams: { direct: 'http://127.0.0.1:1', gateway: 'http://127.0.0.1:1' },
  })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 502)
    const body = await json(res)
    assert.match(body.error?.message ?? '', /direct:claude-sonnet-4\.5 /)
    assert.equal(tiers.calls.observe.length, 1)
    assert.equal(tiers.calls.observe[0]?.status, 0)
    assert.ok(tiers.calls.observe[0]?.error)
  } finally {
    await r.stop()
  }
})

test('client disconnect aborts the upstream request', async () => {
  const tiers = fakeTiers({ route: { to: 'direct' } })
  let aborted = false
  const cap = capture((e) => {
    e.res.writeHead(200, { 'content-type': 'text/event-stream' })
    e.res.write('data: {"type":"message_start"}\n\n')
    const timer = setInterval(() => e.res.write('data: {"type":"content_block_delta"}\n\n'), 20)
    e.res.on('close', () => {
      aborted = true
      clearInterval(timer)
    })
  })
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const req = http.request(
      { host: '127.0.0.1', port: r.port, path: '/v1/messages', method: 'POST', headers: claudeHeaders },
      (res) => res.on('data', () => req.destroy()),
    )
    req.on('error', () => {})
    req.end(JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }))
    assert.ok(await until(() => aborted))
  } finally {
    await r.stop()
  }
})

test('SSE passes through chunk-by-chunk and merged usage is recorded', async () => {
  const tiers = fakeTiers({ route: { to: 'gateway', model: 'zai/glm-5.3', reason: 'quota' } })
  tiers.snapshot = () => ({ work: { tier: 'fallback', model: 'zai/glm-5.3', reason: 'quota', resetAt: 1790000000 } })
  const spend = fakeSpend()
  const cap = capture((e) =>
    sse(
      e.res,
      [
        { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } } },
        { type: 'content_block_delta', delta: {} },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 34 } },
      ],
      60,
    ),
  )
  const r = await boot({ handler: cap.handler, tiers, spend })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', stream: true, max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const times: number[] = []
    const reader = res.body?.getReader()
    while (true) {
      const { done } = (await reader?.read()) ?? { done: true }
      if (done) break
      times.push(Date.now())
    }
    assert.equal(times.length, 4)
    assert.ok((times[3] ?? 0) - (times[0] ?? 0) >= 100, 'chunks arrived one by one, not buffered')
    assert.deepEqual(spend.calls, [
      { id: 'work', model: 'zai/glm-5.3', usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 34 } },
    ])
  } finally {
    await r.stop()
  }
})

test('/gateway proxy: handle swapped for key, everything else byte-for-byte', async () => {
  const keys = fakeKeys({ [SERVICE]: 'gw-key' })
  const raw = '{"model":"openai/gpt-6","stream":false}'
  const cap = capture((e) => ok(e, '{"choices":[]}'))
  const r = await boot({ handler: cap.handler, keys })
  try {
    const res = await call(r.port, '/gateway/v1/chat/completions', {
      body: raw,
      headers: { 'content-type': 'application/json', authorization: 'Bearer barrito:work', 'x-custom': 'keep-me' },
    })
    assert.equal(res.status, 200)
    assert.equal(cap.seen.length, 1)
    assert.equal(cap.seen[0]?.url, '/v1/chat/completions')
    assert.equal(cap.seen[0]?.headers.authorization, 'Bearer gw-key')
    assert.equal(cap.seen[0]?.headers['x-custom'], 'keep-me')
    assert.equal(cap.seen[0]?.body.toString(), raw)
    assert.equal((await json(res)).choices?.length, 0)
    assert.match(r.logs[0] ?? '', / work POST \/gateway\/v1\/chat\/completions - → gateway \(-\) 200 \d+ms$/)
    await call(r.port, '/gateway/v1/models', { method: 'GET', headers: { authorization: 'Bearer barrito:work' } })
    assert.deepEqual(keys.calls, [SERVICE])
  } finally {
    await r.stop()
  }
})

test('/gateway proxy drops internal x-barrito-* and client-supplied x-ai-gateway-api-key', async () => {
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler })
  try {
    const res = await call(r.port, '/gateway/v1/chat/completions', {
      body: '{"model":"openai/gpt-6"}',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer barrito:work',
        'x-ai-gateway-api-key': 'Bearer someone-elses-key',
        'x-barrito-identity': 'work',
        'x-barrito-tier': 'max',
        'x-custom': 'keep-me',
      },
    })
    assert.equal(res.status, 200)
    assert.equal(cap.seen.length, 1)
    assert.equal(cap.seen[0]?.headers.authorization, 'Bearer gw-key')
    assert.equal(cap.seen[0]?.headers['x-ai-gateway-api-key'], undefined)
    assert.equal(cap.seen[0]?.headers['x-barrito-identity'], undefined)
    assert.equal(cap.seen[0]?.headers['x-barrito-tier'], undefined)
    assert.equal(cap.seen[0]?.headers['x-custom'], 'keep-me')
  } finally {
    await r.stop()
  }
})

test('/gateway: unknown or missing handle → 401', async () => {
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler })
  try {
    const bad = await call(r.port, '/gateway/v1/chat/completions', {
      body: '{}',
      headers: { authorization: 'Bearer barrito:ghost' },
    })
    assert.equal(bad.status, 401)
    const body = await json(bad)
    assert.equal(body.error?.type, 'authentication_error')
    const none = await call(r.port, '/gateway/v1/chat/completions', { body: '{}', headers: {} })
    assert.equal(none.status, 401)
    const nf = await call(r.port, '/gatewayfoo', { method: 'GET', headers: { authorization: 'Bearer barrito:work' } })
    assert.equal(nf.status, 404)
    assert.equal((await json(nf)).error?.type, 'not_found_error')
    assert.equal(cap.seen.length, 0)
  } finally {
    await r.stop()
  }
})

test('/gateway proxy records usage: OpenAI names mapped to Anthropic, Anthropic kept', async () => {
  const spend = fakeSpend()
  let n = 0
  const cap = capture((e) => {
    n++
    ok(
      e,
      n === 1
        ? '{"usage":{"prompt_tokens":11,"completion_tokens":22,"prompt_tokens_details":{"cached_tokens":4}}}'
        : '{"usage":{"input_tokens":7,"output_tokens":3}}',
    )
  })
  const r = await boot({ handler: cap.handler, spend })
  try {
    const gwHeaders = { 'content-type': 'application/json', authorization: 'Bearer barrito:work' }
    const openai = await call(r.port, '/gateway/v1/chat/completions', { body: '{"model":"openai/gpt-6"}', headers: gwHeaders })
    assert.equal(openai.status, 200)
    await openai.text()
    assert.deepEqual(spend.calls, [
      { id: 'work', model: 'openai/gpt-6', usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 4 } },
    ])
    const anthropic = await call(r.port, '/gateway/v1/chat/completions', { body: '{"model":"zai/glm-5.3"}', headers: gwHeaders })
    assert.equal(anthropic.status, 200)
    await anthropic.text()
    assert.deepEqual(spend.calls[1], { id: 'work', model: 'zai/glm-5.3', usage: { input_tokens: 7, output_tokens: 3 } })
  } finally {
    await r.stop()
  }
})

test('usage fields that are strings, objects, or negatives are dropped; finite non-negative numbers kept', async () => {
  const spend = fakeSpend()
  const cap = capture((e) =>
    ok(
      e,
      '{"usage":{"input_tokens":"100","output_tokens":{"x":1},"cache_read_input_tokens":3,"cache_creation_input_tokens":-2}}',
    ),
  )
  const r = await boot({ handler: cap.handler, spend })
  try {
    const res = await call(r.port, '/gateway/v1/chat/completions', {
      body: '{"model":"openai/gpt-6"}',
      headers: { 'content-type': 'application/json', authorization: 'Bearer barrito:work' },
    })
    assert.equal(res.status, 200)
    await res.text()
    assert.deepEqual(spend.calls, [{ id: 'work', model: 'openai/gpt-6', usage: { cache_read_input_tokens: 3 } }])
  } finally {
    await r.stop()
  }
})

test('missing gateway key → 500 doctor message on both gateway paths, no upstream call', async () => {
  const keys = fakeKeys({})
  const tiers = fakeTiers({ route: { to: 'gateway', model: 'zai/glm-5.3', reason: 'quota' } })
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler, keys, tiers })
  try {
    const message = 'barrito: gateway key for work missing (keychain "Vercel AI Gateway Work") — run barrito doctor'
    const claude = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(claude.status, 500)
    assert.equal((await json(claude)).error?.message, message)
    assert.equal(tiers.calls.observe.length, 0)
    const proxied = await call(r.port, '/gateway/v1/models', {
      method: 'GET',
      headers: { authorization: 'Bearer barrito:work' },
    })
    assert.equal(proxied.status, 500)
    assert.equal((await json(proxied)).error?.message, message)
    assert.equal(cap.seen.length, 0)
  } finally {
    await r.stop()
  }
})

test('request body over the cap → 413 Anthropic-shaped', async () => {
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler, maxBody: 1024 })
  try {
    const res = await call(r.port, '/v1/messages', { body: 'x'.repeat(4096), headers: claudeHeaders })
    assert.equal(res.status, 413)
    assert.deepEqual(await res.json(), {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'barrito: request body too large' },
    })
    assert.equal(cap.seen.length, 0)
  } finally {
    await r.stop()
  }
})

test('gateway key re-read and retried once on upstream 401', async () => {
  const keys = fakeKeys({ [SERVICE]: 'gw-old' })
  const cap = capture((e) => {
    if (e.headers.authorization !== 'Bearer gw-old') return ok(e, '{"ok":true}')
    keys.set(SERVICE, 'gw-new')
    e.res.writeHead(401, { 'content-type': 'application/json' })
    e.res.end('{}')
  })
  const r = await boot({ handler: cap.handler, keys })
  try {
    const res = await call(r.port, '/gateway/v1/chat/completions', {
      body: '{}',
      headers: { authorization: 'Bearer barrito:work' },
    })
    assert.equal(res.status, 200)
    assert.equal(cap.seen.length, 2)
    assert.equal(cap.seen[0]?.headers.authorization, 'Bearer gw-old')
    assert.equal(cap.seen[1]?.headers.authorization, 'Bearer gw-new')
    assert.deepEqual(keys.calls, [SERVICE, SERVICE])
    const again = await call(r.port, '/gateway/v1/chat/completions', {
      body: '{}',
      headers: { authorization: 'Bearer barrito:work' },
    })
    assert.equal(again.status, 200)
    assert.deepEqual(keys.calls, [SERVICE, SERVICE])
  } finally {
    await r.stop()
  }
})

test('GET /health and GET /status', async () => {
  const tiers = fakeTiers()
  tiers.snapshot = () => ({ work: { tier: 'max' } })
  const spend = fakeSpend()
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler, tiers, spend })
  try {
    const health = await call(r.port, '/health', { method: 'GET' })
    assert.deepEqual(await health.json(), { ok: true })
    const status = await call(r.port, '/status', { method: 'GET' })
    const body = await json(status)
    assert.equal(body.pid, process.pid)
    assert.ok((body.uptime ?? -1) >= 0)
    assert.deepEqual(body.identities, { work: { tier: 'max' } })
    assert.deepEqual(body.spend, { work: 1.5 })
  } finally {
    await r.stop()
  }
})

test('POST /pin pins via tiers; unknown identity → 400', async () => {
  const tiers = fakeTiers()
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const res = await call(r.port, '/pin', { body: JSON.stringify({ identity: 'work', value: 'max' }) })
    assert.deepEqual(await res.json(), { ok: true })
    assert.deepEqual(tiers.calls.pin, [{ id: 'work', value: 'max' }])
    const bad = await call(r.port, '/pin', { body: JSON.stringify({ identity: 'ghost', value: 'max' }) })
    assert.equal(bad.status, 400)
  } finally {
    await r.stop()
  }
})

test('POST /pin with a value tiers rejects → 400 carrying the thrown message', async () => {
  const tiers = fakeTiers()
  tiers.pin = () => {
    throw new Error('barrito pin: expected \'max\', a gateway model id (provider/model), or null — got "nonsense"')
  }
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const res = await call(r.port, '/pin', { body: JSON.stringify({ identity: 'work', value: 'nonsense' }) })
    assert.equal(res.status, 400)
    assert.deepEqual(await json(res), {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'barrito pin: expected \'max\', a gateway model id (provider/model), or null — got "nonsense"',
      },
    })
    assert.equal(tiers.calls.pin.length, 0)
  } finally {
    await r.stop()
  }
})

test('missing or unknown identity → 400 Anthropic-shaped error', async () => {
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler })
  try {
    for (const headers of [{ 'content-type': 'application/json' }, { ...claudeHeaders, 'x-barrito-identity': 'ghost' }]) {
      const res = await call(r.port, '/v1/messages', { body: '{"model":"claude-sonnet-4.5"}', headers })
      assert.equal(res.status, 400)
      assert.deepEqual(await res.json(), {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'barrito: no identity for this request — run barrito doctor' },
      })
    }
    assert.equal(cap.seen.length, 0)
  } finally {
    await r.stop()
  }
})

test('explicit gateway routes bypass tiers: claude-code/*, *-fast, GET /v1/models, unparseable body', async () => {
  const tiers = fakeTiers()
  const cap = capture((e) => ok(e, '{"ok":true}'))
  const r = await boot({ handler: cap.handler, tiers })
  try {
    const explicit = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-code/zai/glm-5.3' }),
      headers: claudeHeaders,
    })
    assert.equal(explicit.status, 200)
    assert.equal(cap.seen[0]?.url, '/claude-code/v1/messages')
    assert.equal(parse(cap.seen[0]?.body).model, 'claude-code/zai/glm-5.3')

    const fast = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5-fast' }),
      headers: claudeHeaders,
    })
    assert.equal(fast.status, 200)
    assert.equal(cap.seen[1]?.url, '/claude-code/v1/messages')
    assert.equal(parse(cap.seen[1]?.body).model, 'claude-sonnet-4.5-fast')

    const models = await call(r.port, '/v1/models?beta=true', { method: 'GET', headers: { 'x-barrito-identity': 'work' } })
    assert.equal(models.status, 200)
    assert.equal(cap.seen[2]?.url, '/claude-code/v1/models?beta=true')
    assert.equal(cap.seen[2]?.method, 'GET')
    assert.equal(cap.seen[2]?.body.length, 0)

    const junk = await call(r.port, '/v1/messages', { body: 'not-json{{', headers: claudeHeaders })
    assert.equal(junk.status, 200)
    assert.equal(await junk.text(), '{"ok":true}')
    assert.equal(cap.seen[3]?.url, '/claude-code/v1/messages')
    assert.equal(cap.seen[3]?.body.toString(), 'not-json{{')

    for (const e of cap.seen) {
      assert.equal(e.headers.authorization, undefined)
      assert.ok(e.headers['x-ai-gateway-api-key'])
    }
    assert.equal(tiers.calls.route.length, 0)
    assert.equal(tiers.calls.observe.length, 0)
  } finally {
    await r.stop()
  }
})

// ── transforms ─────────────────────────────────────────────────────────────────

test('transforms: applied once per request — retries reuse the same rewritten body', async () => {
  const tiers = fakeTiers({ route: { to: 'direct' }, retries: [{ retry: { to: 'direct', delay: 0 } }] })
  const tx = fakeTransforms(
    { rtk: 2, caveman: 'lite', saved: 512 },
    (body) => ({ ...body, system: 'caveman says hi' }),
  )
  const cap = capture((e) => {
    if (cap.seen.length === 1) {
      e.res.writeHead(500, { 'content-type': 'application/json' })
      e.res.end('{}')
      return
    }
    ok(e, '{"ok":true}')
  })
  const r = await boot({ handler: cap.handler, tiers, transforms: tx })
  try {
    const res = await call(r.port, '/v1/messages', {
      body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 8 }),
      headers: claudeHeaders,
    })
    assert.equal(res.status, 200)
    assert.equal(tx.calls.length, 1, 'one transform per request, not per hop')
    assert.equal(cap.seen.length, 2)
    for (const e of cap.seen) assert.equal(parse(e.body).system, 'caveman says hi')
    assert.equal(res.headers.get('x-barrito-transforms'), 'rtk=2; caveman=lite')
    assert.match(r.logs.at(-1) ?? '', / t=rtk:2,cave:lite$/)
  } finally {
    await r.stop()
  }
})

test('transforms: nothing applied → original bytes forwarded verbatim, header rtk=0;caveman=off', async () => {
  const tx = fakeTransforms({ rtk: 0, caveman: 'off', saved: 0 })
  const raw = '{"model":"claude-sonnet-4.5",  "max_tokens":   8}'
  const cap = capture((e) => ok(e, '{"ok":true}'))
  const r = await boot({ handler: cap.handler, transforms: tx })
  try {
    const res = await call(r.port, '/v1/messages', { body: raw, headers: claudeHeaders })
    assert.equal(res.status, 200)
    assert.equal(tx.calls.length, 1)
    assert.equal(cap.seen[0]?.body.toString(), raw, 'byte-for-byte, no re-serialization')
    assert.equal(res.headers.get('x-barrito-transforms'), 'rtk=0; caveman=off')
    assert.match(r.logs[0] ?? '', / t=rtk:0,cave:off$/)
  } finally {
    await r.stop()
  }
})

test('transforms: junk bodies never reach the transform — bytes verbatim', async () => {
  const tx = fakeTransforms({ rtk: 3, caveman: 'ultra', saved: 10 }, (body) => ({ ...body, system: 'x' }))
  const cap = capture((e) => ok(e, '{"ok":true}'))
  const r = await boot({ handler: cap.handler, transforms: tx })
  try {
    const res = await call(r.port, '/v1/messages', { body: 'not-json{{', headers: claudeHeaders })
    assert.equal(res.status, 200)
    assert.equal(tx.calls.length, 0)
    assert.equal(cap.seen[0]?.body.toString(), 'not-json{{')
  } finally {
    await r.stop()
  }
})

test('gateway proxy: chat/completions → openai, messages → anthropic, other paths untouched', async () => {
  const tx = fakeTransforms({ rtk: 1, caveman: 'full', saved: 64 }, (body) => ({ ...body, system: 'terse' }))
  const cap = capture((e) => ok(e, '{"ok":true}'))
  const r = await boot({ handler: cap.handler, transforms: tx })
  try {
    const gw = { 'content-type': 'application/json', authorization: 'Bearer barrito:work' }
    const completions = await call(r.port, '/gateway/v1/chat/completions', { body: '{"model":"openai/gpt-6"}', headers: gw })
    assert.equal(completions.status, 200)
    assert.equal(parse(cap.seen[0]?.body).system, 'terse')
    assert.equal(completions.headers.get('x-barrito-transforms'), 'rtk=1; caveman=full')
    assert.match(r.logs[0] ?? '', / t=rtk:1,cave:full$/)

    const messages = await call(r.port, '/gateway/v1/messages', { body: '{"model":"anthropic/claude-opus-4.5"}', headers: gw })
    assert.equal(messages.status, 200)
    assert.equal(parse(cap.seen[1]?.body).system, 'terse')
    assert.deepEqual(tx.calls.map((c) => c.kind), ['openai', 'anthropic'])

    // other proxy paths (models, embeddings) pass through untouched
    const raw = '{"model":"openai/gpt-6",  "weird":  true}'
    const untouched = await call(r.port, '/gateway/v1/embeddings', { body: raw, headers: gw })
    assert.equal(untouched.status, 200)
    assert.equal(cap.seen[2]?.body.toString(), raw)
    assert.equal(untouched.headers.get('x-barrito-transforms'), 'rtk=0; caveman=off')
    assert.equal(tx.calls.length, 2)
  } finally {
    await r.stop()
  }
})

test('gateway proxy: non-JSON content-type bodies are never transformed', async () => {
  const tx = fakeTransforms({ rtk: 1, caveman: 'full', saved: 64 }, (body) => ({ ...body, system: 'terse' }))
  const raw = '{"model":"openai/gpt-6"}'
  const cap = capture((e) => ok(e, '{"ok":true}'))
  const r = await boot({ handler: cap.handler, transforms: tx })
  try {
    const res = await call(r.port, '/gateway/v1/chat/completions', {
      body: raw,
      headers: { 'content-type': 'text/plain', authorization: 'Bearer barrito:work' },
    })
    assert.equal(res.status, 200)
    assert.equal(tx.calls.length, 0)
    assert.equal(cap.seen[0]?.body.toString(), raw)
  } finally {
    await r.stop()
  }
})

test('POST /transforms sets state; invalid values and unknown identities 400', async (t) => {
  const tx = fakeTransforms({ rtk: 0, caveman: 'off', saved: 0 }, undefined, {
    set: (id: string, patch: unknown) => {
      if ((patch as { caveman?: unknown } | null)?.caveman === 'nope') throw new Error('barrito: caveman must be off|lite|full|ultra, got "nope"')
      return { rtk: true, caveman: 'ultra' }
    },
  })
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler, transforms: tx })
  t.after(() => r.stop())
  const good = await call(r.port, '/transforms', { body: JSON.stringify({ identity: 'work', rtk: true, caveman: 'ultra' }) })
  assert.equal(good.status, 200)
  assert.deepEqual(await good.json(), { ok: true, state: { rtk: true, caveman: 'ultra' } })

  const reset = await call(r.port, '/transforms', { body: JSON.stringify({ identity: 'work', reset: true }) })
  assert.equal(reset.status, 200)

  const bad = await call(r.port, '/transforms', { body: JSON.stringify({ identity: 'work', caveman: 'nope' }) })
  assert.equal(bad.status, 400)
  assert.equal((await json(bad)).error?.message, 'barrito: caveman must be off|lite|full|ultra, got "nope"')

  const ghost = await call(r.port, '/transforms', { body: JSON.stringify({ identity: 'ghost', caveman: 'lite' }) })
  assert.equal(ghost.status, 400)
  assert.equal((await json(ghost)).error?.message, NO_IDENTITY_MESSAGE)
})

test('GET /status carries transforms state, saved-today stats and rtk availability', async () => {
  const tx = fakeTransforms({ rtk: 0, caveman: 'off', saved: 0 }, undefined, {
    state: () => ({ rtk: true, caveman: 'ultra' }),
    stats: () => ({ work: { saved: 4096, compressed: 3 } }),
  })
  const cap = capture((e) => ok(e))
  const r = await boot({ handler: cap.handler, transforms: tx })
  try {
    const res = await call(r.port, '/status', { method: 'GET' })
    const body = await json(res)
    assert.equal(body.rtk, true)
    assert.deepEqual(body.transforms, {
      work: { state: { rtk: true, caveman: 'ultra' }, saved: 4096, compressed: 3 },
    })
  } finally {
    await r.stop()
  }
})

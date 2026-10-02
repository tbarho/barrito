import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  Applied, Attempt, GatewayIdentity, Keys, Log, Parsed, Pin, RouterConfig, RouterTiers, Spend, StartOpts, TransformState, Transforms, Upstreams, UpstreamResponse,
} from '../types.ts'
export type {
  Applied, Attempt, GatewayIdentity, Keys, LineInfo, Meter, Parsed, RouterConfig, SendOpts, StartOpts, TransformState, Transforms,
} from '../types.ts'
import {
  bare,
  body,
  catalogId,
  classify,
  fail,
  forward,
  json,
  line,
  meter,
  normalize,
  parse,
  reply,
  rewrite,
  sleep,
  tierHeader,
  transform,
  transformsHeader,
  transformsLog,
} from './routes.ts'
import { keyring, noKey, proxy, send } from './gateway.ts'

const NO_IDENTITY = 'barrito: no identity for this request — run barrito doctor'
const MAX_HOPS = 12

export interface ServeCtx {
  config: RouterConfig
  tiers: RouterTiers
  spend: Spend
  keys: Keys
  log: Log
  upstreams: Upstreams
  transforms?: Transforms
  t0: number
  maxBody: number
}

// observe sees the raw chain entry; spend and logs see the catalog id
const labels = (to: 'direct' | 'gateway', model: string | undefined, parsed: Parsed): { ask: string; price: string } => {
  const ask = to === 'gateway' ? String(model || parsed.model || '') : normalize(parsed.model)
  return { ask, price: to === 'direct' ? ask : catalogId(ask) }
}

// a retried hop's body is discarded anyway; surface the upstream error type/message (never request content)
const why = async (a: Attempt): Promise<string> => {
  if (!a.up) return ''
  try {
    const text = (await a.up.text()).slice(0, 2048)
    const body: unknown = JSON.parse(text)
    const err = typeof body === 'object' && body !== null && 'error' in body ? (body as { error: unknown }).error : null
    if (typeof err !== 'object' || err === null) return ''
    const e = err as { type?: unknown; message?: unknown }
    const msg = typeof e.message === 'string' ? e.message.replace(/\s+/g, ' ').slice(0, 200) : ''
    return ` [${typeof e.type === 'string' ? e.type : 'error'}${msg ? `: ${msg}` : ''}]`
  } catch {
    return ''
  }
}

// one upstream attempt: direct or gateway hop, body model rewritten per target
const attempt = async (
  req: IncomingMessage,
  {
    raw,
    parsed,
    to,
    model,
    identity,
    keys,
    upstreams,
    abort,
  }: {
    raw: Buffer
    parsed: Parsed
    to: 'direct' | 'gateway'
    model: string | undefined
    identity: GatewayIdentity
    keys: Keys
    upstreams: Upstreams
    abort: AbortController
  },
): Promise<Attempt> => {
  const base = to === 'direct' ? upstreams.direct : `${upstreams.gateway}/claude-code`
  const next = to === 'direct' ? normalize(parsed.model) : model ? `claude-code/${bare(model)}` : null
  const headers = forward(req.headers, { direct: to === 'direct', gateway: to === 'gateway' })
  let key: string | undefined
  if (to === 'gateway') {
    key = keys.get(identity) ?? undefined
    if (key == null) return { missing: true }
    headers['x-ai-gateway-api-key'] = `Bearer ${key}`
  }
  const buf = raw.length ? rewrite(raw, parsed, next) : undefined
  try {
    const up = await send(base + (req.url ?? ''), req, {
      headers,
      body: buf,
      key,
      keys,
      identity,
      keyHeader: 'x-ai-gateway-api-key',
      signal: abort.signal,
    })
    return { up }
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

const lower = (headers: UpstreamResponse['headers']): Record<string, string> => Object.fromEntries(headers)

const claude = async (req: IncomingMessage, res: ServerResponse, ctx: ServeCtx): Promise<void> => {
  const { config, tiers, spend, keys, log, upstreams, transforms, t0, maxBody } = ctx
  const id = String(req.headers['x-barrito-identity'] || '').trim()
  const identity = config.identities[id]
  if (!identity) {
    fail(res, 400, 'invalid_request_error', NO_IDENTITY)
    line(log, t0, { id: id || '-', method: req.method, path: req.url ?? '', to: '-', status: 400 })
    return
  }

  // client gone (Esc mid-generation) must cancel upstream or tokens keep burning
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const raw = await body(req, maxBody)
  if (abort.signal.aborted) return
  const parsed = parse(raw)
  const kind = classify(req.method ?? '', req.url ?? '', parsed.model)

  let to: 'direct' | 'gateway' = 'gateway'
  let model: string | undefined
  let reason = '-'
  if (kind === 'tiers') {
    const r = tiers.route(id, normalize(parsed.model))
    to = r.to
    model = 'model' in r ? r.model : undefined
    reason = ('reason' in r ? r.reason : undefined) || '-'
  }

  // transforms apply once per request — retries reuse the same rewritten bytes
  const t = transform(transforms, 'anthropic', id, raw)
  const applied = t.applied ?? { rtk: 0, caveman: 'off' as const, saved: 0 }

  const hops: string[] = []
  let up: UpstreamResponse | undefined
  let last: Attempt | undefined
  for (let n = 0; n < MAX_HOPS; n++) {
    const a = await attempt(req, { raw: t.out, parsed: t.body ?? parsed, to, model, identity, keys, upstreams, abort })
    last = a
    if (abort.signal.aborted) return // no observe, no bytes — the breaker must not see client aborts
    if (a.missing) {
      noKey(res, id, identity)
      line(log, t0, { id, method: req.method, path: req.url ?? '', to, reason, status: 500 })
      return
    }
    const { ask } = labels(to, model, parsed)
    hops.push(`${to}:${ask} ${a.error ? a.error.message : a.up.status}`)
    if (kind !== 'tiers') {
      if (a.error) break
      up = a.up
      break
    }
    const obs = tiers.observe(id, {
      to,
      model: ask,
      status: a.error ? 0 : a.up.status,
      headers: a.error ? {} : lower(a.up.headers),
      error: a.error?.message,
    })
    if (!obs?.retry) {
      if (a.error) break // connect error with no response → aggregate 502 below
      up = a.up // chain done but upstream answered → surface that response verbatim
      break
    }
    // every hop is logged, not just the final one — a silent 429 must be greppable
    log(`${new Date().toISOString()} ${id} ${req.method ?? ''} ${req.url ?? ''} ${ask} → ${to} ${a.error ? 0 : a.up.status} (retry)${await why(a)}`)
    to = obs.retry.to
    model = 'model' in obs.retry ? obs.retry.model : undefined
    reason = ('reason' in obs.retry ? obs.retry.reason : undefined) || reason
    if ('delay' in obs.retry && obs.retry.delay) {
      await sleep(obs.retry.delay, abort.signal)
      if (abort.signal.aborted) return
    }
  }
  if (!up && last?.up) up = last.up

  if (!up) {
    fail(res, 502, 'api_error', `barrito: all routes failed — ${hops.join('; ')}`)
    line(log, t0, { id, method: req.method, path: req.url ?? '', model: normalize(parsed.model), to, reason, status: 502 })
    return
  }

  const sse = (up.headers.get('content-type') || '').includes('text/event-stream')
  const { price } = labels(to, model, parsed)
  const m = meter()
  reply(up, res, {
    tier: tierHeader(tiers.snapshot()[id]),
    transforms: transforms ? transformsHeader(applied) : undefined,
    tap: (chunk: Buffer) => m.push(chunk, sse),
    done: () => {
      const usage = m.done(sse)
      // spend is gateway list price × usage; direct hops are Max plan, not API credits
      if (usage && to === 'gateway') spend.record(id, price, usage)
    },
  })
  line(log, t0, { id, method: req.method, path: req.url ?? '', model: price, to, reason, status: up.status, transforms: transforms ? transformsLog(applied) : undefined })
}

const pin = async (req: IncomingMessage, res: ServerResponse, ctx: ServeCtx): Promise<void> => {
  const { config, tiers, log, t0, maxBody } = ctx
  const parsed = parse(await body(req, maxBody))
  const identity = typeof parsed.identity === 'string' ? parsed.identity : ''
  if (!config.identities[identity]) {
    fail(res, 400, 'invalid_request_error', NO_IDENTITY)
    line(log, t0, { id: identity || '-', method: req.method, path: req.url ?? '', status: 400 })
    return
  }
  try {
    tiers.pin(identity, parsed.value as Pin)
  } catch (error) {
    // tiers.pin validates the value; surface its message, not a generic 500
    fail(res, 400, 'invalid_request_error', error instanceof Error ? error.message : String(error))
    line(log, t0, { id: identity, method: req.method, path: req.url ?? '', status: 400 })
    return
  }
  json(res, 200, { ok: true })
  line(log, t0, { id: identity, method: req.method, path: req.url ?? '', status: 200 })
}

const NO_TRANSFORMS = 'barrito: transforms not available on this router'

const setTransforms = async (req: IncomingMessage, res: ServerResponse, ctx: ServeCtx): Promise<void> => {
  const { config, transforms, log, t0, maxBody } = ctx
  const parsed = parse(await body(req, maxBody))
  const identity = typeof parsed.identity === 'string' ? parsed.identity : ''
  if (!config.identities[identity]) {
    fail(res, 400, 'invalid_request_error', NO_IDENTITY)
    line(log, t0, { id: identity || '-', method: req.method, path: req.url ?? '', status: 400 })
    return
  }
  if (!transforms) {
    fail(res, 404, 'not_found_error', NO_TRANSFORMS)
    line(log, t0, { id: identity, method: req.method, path: req.url ?? '', status: 404 })
    return
  }
  const patch = (parsed.reset ? null : { rtk: parsed.rtk, caveman: parsed.caveman }) as Partial<TransformState> | null
  try {
    const state = transforms.set(identity, patch)
    json(res, 200, { ok: true, state })
  } catch (error) {
    // transforms.set validates the patch; surface its message, not a generic 500
    fail(res, 400, 'invalid_request_error', error instanceof Error ? error.message : String(error))
    line(log, t0, { id: identity, method: req.method, path: req.url ?? '', status: 400 })
    return
  }
  line(log, t0, { id: identity, method: req.method, path: req.url ?? '', status: 200 })
}

// every configured identity plus any with saved-today stats, each with its state and today's savings
const transformsStatus = (ctx: ServeCtx): Record<string, { state: unknown; saved: number; compressed: number }> => {
  const tx = ctx.transforms
  if (!tx) return {}
  const stats = tx.stats()
  const ids = new Set([...Object.keys(ctx.config.identities), ...Object.keys(stats)])
  return Object.fromEntries(
    [...ids].map((id) => {
      const s = stats[id] ?? { saved: 0, compressed: 0 }
      return [id, { state: tx.state(id), ...s }] as const
    }),
  )
}

const serve = async (req: IncomingMessage, res: ServerResponse, ctx: ServeCtx): Promise<void> => {
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (req.method === 'GET' && path === '/health') {
    json(res, 200, { ok: true })
    line(ctx.log, ctx.t0, { method: req.method, path, status: 200 })
    return
  }
  if (req.method === 'GET' && path === '/status') {
    json(res, 200, {
      pid: process.pid,
      uptime: process.uptime(),
      identities: ctx.tiers.snapshot(),
      spend: ctx.spend.today(),
      transforms: transformsStatus(ctx),
      rtk: ctx.transforms?.available() ?? false,
    })
    line(ctx.log, ctx.t0, { method: req.method, path, status: 200 })
    return
  }
  if (req.method === 'POST' && path === '/pin') return pin(req, res, ctx)
  if (req.method === 'POST' && path === '/transforms') return setTransforms(req, res, ctx)
  if (/^\/gateway(\/|$)/.test(req.url ?? '')) return proxy(req, res, ctx)
  if ((req.url ?? '').startsWith('/gateway')) {
    fail(res, 404, 'not_found_error', 'barrito: not found')
    line(ctx.log, ctx.t0, { method: req.method, path, status: 404 })
    return
  }
  return claude(req, res, ctx)
}

export const start = ({
  config,
  port,
  tiers,
  spend,
  keychain,
  log,
  upstreams,
  transforms,
  maxBody = 64 * 1024 * 1024,
}: StartOpts): http.Server => {
  const keys = keyring(keychain)
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    const t0 = Date.now()
    serve(req, res, { config, tiers, spend, keys, log, upstreams, transforms, t0, maxBody }).catch((error: unknown) => {
      if (res.headersSent) return res.destroy()
      const status = error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined
      if (status) {
        const message = error instanceof Error ? error.message : String(error)
        return fail(res, status, 'invalid_request_error', message)
      }
      fail(res, 500, 'api_error', 'barrito: router error')
    })
  })
  server.on('error', (error: Error) => {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log(`barrito: port ${port} already in use`)
      process.exit(1)
    }
    throw error
  })
  server.listen(port, '127.0.0.1')
  return server
}

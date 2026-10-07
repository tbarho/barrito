import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { body, catalogId, fail, forward, line, meter, parse, reply, transform, transformsHeader, transformsLog } from './routes.ts'
import type { Gate } from './gate.ts'
import type {
  Applied, GatewayIdentity, Keychain, Keys, Log, RawHeaders, RouterConfig, SendOpts, Spend, Transforms, Upstreams, UpstreamResponse,
} from '../types.ts'

// gateway keys live in the Keychain; cache in memory, re-read once on upstream 401
export const keyring = (keychain: Keychain): Keys => {
  const cache = new Map<string, string | null>()
  return {
    get(identity: GatewayIdentity) {
      if (!cache.has(identity.id)) cache.set(identity.id, keychain.get(identity.keychain?.gateway ?? ''))
      return cache.get(identity.id) ?? null
    },
    bust(identity: GatewayIdentity) {
      cache.delete(identity.id)
    },
  }
}

// HTTP/1.1 on purpose. undici's HTTP/2 pool kept a dead session and queued every
// later request on it until the process restarted; a dead 1.1 socket is just replaced.
const HEADERS_TIMEOUT = 120_000
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 64 })
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 64 })

const codeOf = (err: unknown): string => {
  if (!err || typeof err !== 'object') return ''
  const e = err as { code?: unknown; cause?: { code?: unknown } }
  if (typeof e.cause?.code === 'string') return e.cause.code
  if (typeof e.code === 'string') return e.code
  return ''
}

// idle keep-alive closed under us — worth one fresh socket. timeouts and HTTP/2
// stream errors are congestion, and an immediate second upload makes them worse.
const STALE = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])
export const staleSocket = (err: unknown): boolean => STALE.has(codeOf(err))

const hop = (url: string, req: IncomingMessage, headers: RawHeaders, body: Buffer | undefined, signal: AbortSignal): Promise<UpstreamResponse> =>
  new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http
    const out: http.OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(headers)) {
      if (value != null) out[key] = value
    }
    if (body) out['content-length'] = body.length
    out['accept-encoding'] = 'identity' // we do not decompress; fetch used to, and lied about encoding
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const client = lib.request(
      url,
      { method: req.method, headers: out, agent: url.startsWith('https:') ? httpsAgent : httpAgent, signal },
      (res) => {
        client.setTimeout(0) // headers arrived; a generation can stream for minutes
        if (settled) return
        settled = true
        const head = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value == null) continue
          const list = Array.isArray(value) ? value : [value]
          list.forEach((item) => head.append(key, item))
        }
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode ?? 0, headers: head }))
      },
    )
    client.setTimeout(HEADERS_TIMEOUT, () => {
      fail(Object.assign(new Error('upstream headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))
      client.destroy()
    })
    client.on('error', fail)
    client.end(body)
  })

// one hop; a stale socket gets one immediate retry. a 401 may be a stale cached key — bust, re-read, resend once
export const send = async (
  url: string,
  req: IncomingMessage,
  { headers, body, key, keys, identity, keyHeader, signal }: SendOpts,
): Promise<UpstreamResponse> => {
  const up = await hop(url, req, headers, body, signal).catch((err: unknown) => {
    if (signal.aborted || !staleSocket(err)) throw err
    return hop(url, req, headers, body, signal)
  })
  if (up.status !== 401) return up
  keys.bust(identity)
  const fresh = keys.get(identity)
  if (fresh == null || fresh === key) return up
  return hop(url, req, { ...headers, [keyHeader]: `Bearer ${fresh}` }, body, signal)
}

export const noKey = (res: ServerResponse, id: string, identity: GatewayIdentity): void =>
  fail(
    res,
    500,
    'api_error',
    `barrito: gateway key for ${id} missing (keychain "${identity.keychain?.gateway}") — run barrito doctor`,
  )

const handleOf = (authorization: string | undefined): string | null => {
  const m = /^Bearer barrito:(.+)$/i.exec(authorization || '')
  return m ? m[1]!.trim() : null
}

// reverse proxy: /gateway/* → <gateway>/* with the identity key, everything else unchanged
export const proxy = async (
  req: IncomingMessage,
  res: ServerResponse,
  { config, keys, upstreams, spend, log, transforms, t0, maxBody, gate }: {
    config: RouterConfig
    keys: Keys
    upstreams: Upstreams
    spend: Spend
    log: Log
    transforms?: Transforms
    t0: number
    maxBody: number
    gate: Gate
  },
): Promise<void> => {
  const id = handleOf(req.headers.authorization)
  const identity = id && config.identities[id]
  if (!identity) {
    fail(res, 401, 'authentication_error', 'barrito: unknown handle — run barrito doctor')
    line(log, t0, { id: id || '-', method: req.method, path: req.url ?? '', to: 'gateway', status: 401 })
    return
  }
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const raw = await body(req, maxBody)
  if (abort.signal.aborted) return
  const key = keys.get(identity)
  if (key == null) {
    noKey(res, id || '-', identity)
    line(log, t0, { id: id || '-', method: req.method, path: req.url ?? '', to: 'gateway', status: 500 })
    return
  }
  const headers = forward(req.headers, { proxy: true })
  headers.authorization = `Bearer ${key}`
  // /gateway/*/chat/completions bodies go through the openai shape, /gateway/*/messages the anthropic one
  const target = (req.url ?? '').replace(/^\/gateway/, '')
  const isJson = String(req.headers['content-type'] ?? '').includes('application/json')
  const kind: 'openai' | 'anthropic' | null = /\/chat\/completions$/.test(target)
    ? 'openai'
    : /\/messages$/.test(target)
      ? 'anthropic'
      : null
  const t = kind && isJson ? transform(transforms, kind, id ?? '', raw) : { out: raw, body: null, applied: undefined as Applied | undefined }
  const applied = t.applied ?? { rtk: 0, caveman: 'off' as const, saved: 0 }
  const url = upstreams.gateway + target
  const release = await gate.acquire(id ?? '', abort.signal)
  if (abort.signal.aborted) return
  if (!release) {
    fail(res, 503, 'api_error', 'barrito: upstream busy — retry shortly')
    line(log, t0, { id, method: req.method, path: req.url ?? '', to: 'gateway', status: 503 })
    return
  }
  let up: UpstreamResponse
  try {
    up = await send(url, req, {
      headers,
      body: t.out.length ? t.out : undefined,
      key,
      keys,
      identity,
      keyHeader: 'authorization',
      signal: abort.signal,
    })
  } catch (error) {
    fail(res, 502, 'api_error', `barrito: gateway unreachable — ${error instanceof Error ? error.message : String(error)}`)
    line(log, t0, { id: id || '-', method: req.method, path: req.url ?? '', to: 'gateway', status: 502 })
    return
  } finally {
    release()
  }
  const sse = (up.headers.get('content-type') || '').includes('text/event-stream')
  const model = catalogId(parse(t.out).model)
  const m = meter()
  reply(up, res, {
    transforms: transforms ? transformsHeader(applied) : undefined,
    tap: (chunk: Buffer) => m.push(chunk, sse),
    done: () => {
      const usage = m.done(sse)
      if (usage && model) spend.record(id || '-', model, usage)
    },
  })
  line(log, t0, {
    id: id || '-',
    method: req.method,
    path: req.url ?? '',
    to: 'gateway',
    status: up.status,
    transforms: transforms ? transformsLog(applied) : undefined,
  })
}

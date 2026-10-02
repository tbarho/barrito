import type { IncomingMessage, ServerResponse } from 'node:http'
import { body, catalogId, fail, forward, line, meter, parse, reply, transform, transformsHeader, transformsLog } from './routes.ts'
import type {
  Applied, GatewayIdentity, Keychain, Keys, Log, RouterConfig, SendOpts, Spend, Transforms, Upstreams, UpstreamResponse,
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

// fetch one hop; on a 401 the cached key may be stale — bust, re-read, resend once
export const send = async (
  url: string,
  req: IncomingMessage,
  { headers, body, key, keys, identity, keyHeader, signal }: SendOpts,
): Promise<UpstreamResponse> => {
  const opts = {
    method: req.method,
    headers: headers as Record<string, string>,
    body,
    redirect: 'manual' as const,
    signal,
  }
  const up = await fetch(url, opts)
  if (up.status !== 401) return up
  keys.bust(identity)
  const fresh = keys.get(identity)
  if (fresh == null || fresh === key) return up
  return fetch(url, { ...opts, headers: { ...headers, [keyHeader]: `Bearer ${fresh}` } as Record<string, string> })
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
  { config, keys, upstreams, spend, log, transforms, t0, maxBody }: {
    config: RouterConfig
    keys: Keys
    upstreams: Upstreams
    spend: Spend
    log: Log
    transforms?: Transforms
    t0: number
    maxBody: number
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

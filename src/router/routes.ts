import { StringDecoder } from 'node:string_decoder'
import { Readable, Transform, pipeline } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LineInfo, Log, Meter, Parsed, RawHeaders, TierSnapshot, UpstreamResponse, Usage } from '../types.ts'

const DROP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'accept-encoding',
  'x-router-anthropic',
])

// fetch decompresses for us, so upstream framing/encoding headers would lie
export const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

export const normalize = (model: unknown): string =>
  typeof model === 'string'
    ? model.toLowerCase().replace(/^claude-code\//, '').replace(/^anthropic\//, '').replace(/\[1m\]$/, '')
    : ''

export const bare = (model: unknown): string => String(model || '').replace(/\[1m\]$/i, '')

// gateway catalog id: strip claude-code/ and [1m], keep provider prefixes like anthropic/
export const catalogId = (model: unknown): string =>
  String(model || '').replace(/^claude-code\//i, '').replace(/\[1m\]$/i, '')

// 'gateway' = explicit choice, bypasses the state machine; 'tiers' = bare Claude model
export const classify = (method: string, url: string, model: unknown): 'gateway' | 'tiers' => {
  if (method === 'GET' && url.startsWith('/v1/models')) return 'gateway'
  if (typeof model !== 'string' || /^claude-code\//i.test(model)) return 'gateway'
  const id = normalize(model)
  if (id.endsWith('-fast')) return 'gateway'
  return /^claude-/.test(id) ? 'tiers' : 'gateway'
}

export const forward = (
  headers: RawHeaders,
  { direct = false, gateway = false, proxy = false }: { direct?: boolean; gateway?: boolean; proxy?: boolean } = {},
): RawHeaders =>
  Object.entries(headers).reduce((memo, [key, value]) => {
    if (DROP.has(key)) return memo
    if (key.startsWith('x-barrito-')) return memo // barrito headers are internal, never forwarded
    if ((direct || proxy) && key === 'x-ai-gateway-api-key') return memo
    if (gateway && key === 'authorization') return memo
    memo[key] = value
    return memo
  }, {} as RawHeaders)

export const rewrite = (buf: Buffer, parsed: Parsed, next: string | null): Buffer =>
  !next || next === parsed.model ? buf : Buffer.from(JSON.stringify({ ...parsed, model: next }))

export const body = (req: IncomingMessage, max = 64 * 1024 * 1024): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const stop = <T>(settle: (value: T) => void, value: T): void => {
      if (done) return
      done = true
      settle(value)
    }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > max) {
        stop(reject, Object.assign(new Error('barrito: request body too large'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => stop(resolve, Buffer.concat(chunks)))
    req.on('error', (error: Error) => stop(reject, error))
    req.on('close', () => {
      if (!req.complete) stop(reject, Object.assign(new Error('barrito: client aborted request'), { status: 400 }))
    })
  })

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

export const parse = (buf: Buffer): Parsed => {
  try {
    const raw: unknown = JSON.parse(buf.toString('utf8'))
    if (typeof raw !== 'object' || raw === null) return {}
    return raw as Parsed
  } catch {
    return {}
  }
}

export const json = (res: ServerResponse, status: number, obj: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

export const fail = (res: ServerResponse, status: number, type: string, message: string): void =>
  json(res, status, { type: 'error', error: { type, message } })

export const line = (log: Log, t0: number, { id = '-', method, path, model = '-', to = 'local', reason = '-', status }: LineInfo): void =>
  log(
    `${new Date().toISOString()} ${id} ${method} ${path} ${model || '-'} → ${to} (${reason}) ${status} ${
      Date.now() - t0
    }ms`,
  )

const iso = (at: number): string => new Date(at < 1e12 ? at * 1000 : at).toISOString()

export const tierHeader = (snap: Partial<TierSnapshot> | undefined): string => {
  if (!snap || snap.tier === 'max') return 'max'
  if (snap.tier === 'pinned') return snap.model && snap.model !== 'max' ? `pinned:${snap.model}` : 'max'
  const reset = snap.resetAt ? `; reset=${iso(snap.resetAt)}` : ''
  return `fallback:${snap.model}; reason=${snap.reason || '-'}${reset}`
}

// only finite non-negative numbers count as usage; strings/objects/negatives are dropped
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

const put = (usage: Usage, key: keyof Usage, v: unknown): void => {
  const n = num(v)
  if (n !== undefined) usage[key] = n
}

// OpenAI usage names → Anthropic names; Anthropic-shaped usage passes through (validated)
const mapUsage = (u: unknown): Usage | null => {
  if (u == null || typeof u !== 'object') return null
  const r: Record<string, unknown> = u as Record<string, unknown>
  if (r['prompt_tokens'] != null || r['completion_tokens'] != null) {
    const usage: Usage = {}
    put(usage, 'input_tokens', r['prompt_tokens'])
    put(usage, 'output_tokens', r['completion_tokens'])
    const details = r['prompt_tokens_details']
    if (details != null && typeof details === 'object') {
      put(usage, 'cache_read_input_tokens', (details as Record<string, unknown>)['cached_tokens'])
    }
    return usage
  }
  const usage: Usage = {}
  put(usage, 'input_tokens', r['input_tokens'])
  put(usage, 'output_tokens', r['output_tokens'])
  put(usage, 'cache_read_input_tokens', r['cache_read_input_tokens'])
  put(usage, 'cache_creation_input_tokens', r['cache_creation_input_tokens'])
  return usage
}

// tee a response body: SSE parsed line by line, JSON buffered then parsed once
export const meter = (): Meter => {
  const dec = new StringDecoder('utf8')
  let tail = ''
  let whole: Buffer[] = []
  let usage: Usage | null = null
  const grab = (obj: unknown): void => {
    if (obj == null || typeof obj !== 'object') return
    const r: Record<string, unknown> = obj as Record<string, unknown>
    const msg = r['message'] as Record<string, unknown> | null | undefined
    const found = [r['usage'], msg?.['usage']].map(mapUsage).filter((u): u is Usage => u !== null)
    if (found.length) usage = found.reduce((memo, u) => ({ ...memo, ...u }), usage ?? {})
  }
  const data = (text: string): void => {
    if (!text.startsWith('data:')) return
    try {
      grab(JSON.parse(text.slice(5).trim()))
    } catch {}
  }
  return {
    push(chunk: Buffer, sse: boolean) {
      if (!sse) {
        whole.push(chunk)
        return
      }
      tail += dec.write(chunk)
      const lines = tail.split('\n')
      tail = lines.pop() ?? ''
      lines.forEach(data)
    },
    done(sse: boolean) {
      if (tail) {
        data(tail)
        tail = ''
      }
      if (!sse && whole.length) {
        try {
          grab(JSON.parse(Buffer.concat(whole).toString('utf8')))
        } catch {}
      }
      return usage
    },
  }
}

export const reply = (
  up: UpstreamResponse,
  res: ServerResponse,
  { tier, tap, done }: { tier?: string; tap?: (chunk: Buffer) => void; done?: () => void } = {},
): void => {
  const head: Record<string, string> = {}
  up.headers.forEach((value: string, key: string) => {
    if (!DROP_RES.has(key)) head[key] = value
  })
  if (tier) head['x-barrito-tier'] = tier
  res.writeHead(up.status, head)
  if (!up.body) {
    done && done()
    res.end()
    return
  }
  const through = new Transform({
    transform(chunk: Buffer, _enc: string, cb: (err: Error | null, data?: Buffer) => void) {
      tap && tap(chunk)
      cb(null, chunk)
    },
  })
  pipeline(Readable.fromWeb(up.body as NodeWebReadableStream<Uint8Array>), through, res, () => done && done())
}

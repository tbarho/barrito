// one tiny server plays BOTH upstreams: the router tells them apart by URL
// prefix — direct → /v1/messages, gateway → /claude-code/v1/messages and
// /v1/chat/completions — so one port can stand in for api.anthropic.com and
// ai-gateway.vercel.sh at the same time.
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

const port = Number(process.argv[2] ?? 0)

type Mode = '200' | '429'
let direct: Mode = '200'

interface Entry {
  method: string
  path: string
  headers: Record<string, string>
  model: string | null
}
const log: Entry[] = []

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((done) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => done(Buffer.concat(chunks)))
  })

const modelOf = (buf: Buffer): string | null => {
  try {
    const model = (JSON.parse(buf.toString('utf8')) as { model?: unknown }).model
    return typeof model === 'string' ? model : null
  } catch {
    return null
  }
}

const now = (): number => Math.floor(Date.now() / 1000)

// 200 SSE shaped like Anthropic, carrying the unified rate-limit headers
const ok = (res: ServerResponse): void => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
    'anthropic-ratelimit-unified-7d-utilization': '0.31',
    'anthropic-ratelimit-unified-5h-reset': String(now() + 3 * 3600),
    'anthropic-ratelimit-unified-7d-reset': String(now() + 60 * 3600),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  })
  res.end(
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
    'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n' +
    'data: [DONE]\n\n',
  )
}

// 429 with the unified status rejected + a 5h reset, like a spent Max quota
const rejected = (res: ServerResponse): void => {
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-status': 'limited',
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': String(now() + 5 * 3600),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  })
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'unified quota exhausted' } }))
}

const gateway = (res: ServerResponse, buf: Buffer, anthropic: boolean): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(anthropic
    ? { id: 'msg_fake', type: 'message', model: modelOf(buf), usage: { input_tokens: 12, output_tokens: 8 } }
    : { id: 'chatcmpl_fake', object: 'chat.completion', model: modelOf(buf), usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }))
}

const server = http.createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const buf = await read(req)
    const headers = Object.entries(req.headers).reduce<Record<string, string>>((memo, [key, value]) => {
      if (key === 'host' || key === 'connection' || key === 'content-length' || key === 'transfer-encoding') return memo
      memo[key] = Array.isArray(value) ? value.join(', ') : String(value)
      return memo
    }, {})
    log.push({ method: req.method ?? '?', path, headers, model: modelOf(buf) })

    if (path === '/__mode' && req.method === 'POST') {
      const want = (JSON.parse(buf.toString('utf8') || '{}') as { direct?: unknown }).direct
      if (want !== '200' && want !== '429') return json(res, 400, { error: 'direct must be "200" or "429"' })
      direct = want
      return json(res, 200, { ok: true, direct })
    }
    if (path === '/__log' && req.method === 'GET') return json(res, 200, log)
    if (path === '/__log' && req.method === 'DELETE') {
      log.length = 0
      return json(res, 200, { ok: true })
    }
    if (path === '/v1/messages') return direct === '200' ? ok(res) : rejected(res)
    if (path === '/claude-code/v1/messages') return gateway(res, buf, true)
    if (path === '/v1/chat/completions') return gateway(res, buf, false)
    return json(res, 404, { error: `no fake route for ${path}` })
  })()
})

server.listen(port, '127.0.0.1', () => {
  const addr = server.address()
  console.log(typeof addr === 'object' && addr ? addr.port : port)
})

import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { resolve } from '../identity.ts'
import { label } from '../router/tiers.ts'
import { classify } from '../router/routes.ts'
import { glyphs } from '../glyphs.ts'
import { base, fetchJson, hhmm, parse as parseStatus } from './status.ts'
import type { CommandCtx, Config, FetchJson, Resolution, StatuslineInput } from '../types.ts'

const read = (stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<string> => new Promise((done) => {
  if (stream.isTTY) return done('')
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (c) => { buf += c })
  stream.on('end', () => done(buf))
  stream.on('error', () => done(''))
})

// epoch seconds or ISO → ms, null if absent/unparseable
const when = (v: string | undefined): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n
  const p = Date.parse(v)
  return Number.isNaN(p) ? null : p
}

// pretty form of a model id: strip claude-code/ and the provider prefix, drop
// [1m], digit-digit hyphens become dots (opus-5-5 → Opus 5.5), 1-3 letter
// words go upper-case (glm → GLM, gpt → GPT)
const pretty = (id: string): string => {
  const word = (w: string): string => /^[a-z]{1,3}$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
  const name = (id.replace(/^claude-code\//i, '').replace(/\[[^\]]*\]$/, '').split('/').pop() ?? '')
    .replace(/^claude-/, '')
  return name.replace(/(\d)-(\d)/g, '$1.$2').split('-').map(word).join(' ')
}

interface OursOpts {
  fetch?: FetchJson
  resolve?: (cwd: string | undefined, opts: { config: Config }) => Resolution
}

const ours = async (raw: string, config: Config, { fetch: f = fetch, resolve: r = resolve }: OursOpts = {}): Promise<string> => {
  let input: StatuslineInput = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) input = parsed as StatuslineInput
  } catch {}
  const { id } = r(input.workspace?.current_dir ?? input.cwd, { config })
  const mid = typeof input.model?.id === 'string' && input.model.id ? input.model.id : null
  const m = mid
    ? typeof input.model?.display_name === 'string' && input.model.display_name ? input.model.display_name : pretty(mid)
    : null
  const data = parseStatus(await fetchJson(`${base(config)}/status`, { timeout: 50, fetch: f }))
  if (!data) return m ? [id, m].join(glyphs.sep) : id

  const s = data.identities?.[id]
  const limits = input.rate_limits ?? {}
  const resets = when(limits.resets_at)
  const pct = limits.five_hour?.used_percentage ?? (s?.util5h != null ? s.util5h * 100 : null)
  const used = pct == null ? null : Math.round(pct)
  // an explicit gateway pick (claude-code/… row) bypasses tiers — no arrow, no Max
  const explicit = m !== null && mid !== null && classify('POST', '/v1/messages', mid) === 'gateway'

  // token savers on the tail — parts that are off are omitted
  const st = data.transforms?.[id]?.state
  const savers = [st?.rtk ? 'rtk' : '', st && st.caveman !== 'off' ? `cave:${st.caveman}` : ''].filter(Boolean)
  const tail = savers.length ? glyphs.sep + savers.join(glyphs.sep) : ''

  const api = Number(data.spend?.[id] ?? 0) > 0
  const on = (model: string): string => api ? `${model} ${glyphs.api}` : model
  const reset = (): string => {
    const at = resets ?? s?.resetAt ?? null
    if (at == null) return ''
    return s?.reason === 'throttle' ? `${glyphs.throttled} ${hhmm(at)}` : `${glyphs.resets} ${hhmm(at)}`
  }

  if (explicit) return [id, on(m ?? '')].join(glyphs.sep) + tail
  if (s?.pin && s.pin !== 'max') {
    return [id, on(`${glyphs.pin} ${label(config, s.pin)}`), reset()].filter(Boolean).join(glyphs.sep) + tail
  }
  if (s?.tier === 'fallback' && s.model) {
    const head = m ? `${m}${glyphs.reroute}` : `${glyphs.warn} `
    return [id, on(`${head}${label(config, s.model)}`), reset()].filter(Boolean).join(glyphs.sep) + tail
  }
  const parts = [id, ...(m ? [m] : [])]
  if (used != null) parts.push(`Max ${used}%`)
  if (s?.pin === 'max') parts.push(glyphs.pinMax)
  return parts.join(glyphs.sep) + tail
}

export type SpawnLike = (cmd: string, opts: { shell: boolean; input: string; encoding: 'utf8' }) => { stdout: string }

export interface StatuslineOpts {
  fetch?: FetchJson
  resolve?: OursOpts['resolve']
  stdin?: string | NodeJS.ReadableStream
  spawn?: SpawnLike
}

export default async (argv: string[], ctx: CommandCtx, { fetch: f, resolve: r, stdin: input, spawn = spawnSync }: StatuslineOpts = {}): Promise<void> => {
  const { values } = parseArgs({ args: argv, options: { append: { type: 'string' } } })
  const raw = typeof input === 'string' ? input : await read()
  let line = ''
  try {
    line = await ours(raw, ctx.config, { fetch: f, resolve: r })
  } catch {}
  if (values.append) {
    let res = null
    try {
      res = spawn(values.append, { shell: true, input: raw, encoding: 'utf8' })
    } catch {}
    if (res?.stdout) line = `${res.stdout.trimEnd()}  ${line}`
  }
  ctx.print(line)
}

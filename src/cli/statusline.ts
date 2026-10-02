import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { resolve } from '../identity.ts'
import { label } from '../router/tiers.ts'
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
  const data = parseStatus(await fetchJson(`${base(config)}/status`, { timeout: 50, fetch: f }))
  if (!data) return id

  const s = data.identities?.[id]
  const limits = input.rate_limits ?? {}
  const resets = when(limits.resets_at)

  if (!s || s.tier === 'max' || s.pin === 'max' || !s.model) {
    const used = limits.five_hour?.used_percentage ?? (s?.util5h != null ? Math.round(s.util5h * 100) : null)
    return used == null ? id : `${id} · Max ${Math.round(used)}%`
  }

  const parts = [id, `⚠ ${label(config, s.model)}`]
  if (Number(data.spend?.[id] ?? 0) > 0) parts.push('API $')
  const reset = resets ?? s.resetAt
  if (reset) parts.push(`Max ↺ ${hhmm(reset)}`)
  return parts.join(' · ')
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

import { parseArgs } from 'node:util'
import { paths } from '../paths.ts'
import * as catalog from '../catalog.ts'
import { check, select } from '../models.ts'
import { read as readSettings } from '../settings.ts'
import type { CatalogModel, ClaudeSettings, CommandCtx, Config, FetchJson, StatusData, TierSnapshot } from '../types.ts'

export const port = (config: Config | null): number => Number(process.env.BARRITO_PORT ?? config?.port ?? 4141)
export const base = (config: Config | null): string => `http://127.0.0.1:${port(config)}`

// resolve null on timeout/refusal/non-2xx; a hanging fetch still loses the race
export const fetchJson = async (url: string, { timeout = 1000, fetch: f = fetch }: { timeout?: number; fetch?: FetchJson } = {}): Promise<unknown> => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  const lose = new Promise<null>((done) => ac.signal.addEventListener('abort', () => done(null)))
  try {
    const res = await Promise.race([f(url, { signal: ac.signal }), lose])
    if (!res || !res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// → { status } | null (unreachable)
export const postJson = async (url: string, body: unknown, { timeout = 1000, fetch: f = fetch }: { timeout?: number; fetch?: FetchJson } = {}): Promise<{ status: number } | null> => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  const lose = new Promise<null>((done) => ac.signal.addEventListener('abort', () => done(null)))
  try {
    const res = await Promise.race([
      f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      }),
      lose,
    ])
    return res ? { status: res.status ?? 0 } : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const pct = (v: number | null | undefined): string => v == null ? '—' : `${Math.round(v * 100)}%`
const short = (model: string): string => catalog.bare(model).split('/').pop() ?? ''

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// /status JSON → StatusData; null when it isn't an object
export const parse = (v: unknown): StatusData | null => {
  if (!isObj(v)) return null
  const spend = Object.fromEntries(Object.entries(isObj(v.spend) ? v.spend : {})
    .flatMap(([id, amount]) => typeof amount === 'number' ? [[id, amount] as const] : []))
  return {
    pid: num(v.pid),
    uptime: num(v.uptime),
    identities: isObj(v.identities) ? v.identities as Record<string, Partial<TierSnapshot>> : {},
    spend,
  }
}

const ids = (config: { identities?: Record<string, unknown> } | null, data: StatusData | null): string[] => [
  ...Object.keys(config?.identities ?? {}),
  ...Object.keys(data?.identities ?? {}).filter((id) => !config?.identities?.[id]),
]

export const table = (config: { identities?: Record<string, unknown> } | null, data: StatusData | null): string[] => {
  const row = (id: string): string => {
    const s = data?.identities?.[id]
    const tier = !s || s.tier === 'max' || s.pin === 'max'
      ? 'max'
      : `⚠ ${short(s.model ?? '')}`
    return [
      id.padEnd(11),
      tier.padEnd(14),
      pct(s?.util5h).padEnd(9),
      pct(s?.util7d).padEnd(9),
      (s?.resetAt ? hhmm(s.resetAt) : '—').padEnd(9),
      `$${Number(data?.spend?.[id] ?? 0).toFixed(2)}`,
    ].join('')
  }
  return [
    `${'IDENTITY'.padEnd(11)}${'TIER'.padEnd(14)}${'MAX 5H'.padEnd(9)}${'MAX 7D'.padEnd(9)}${'RESETS'.padEnd(9)}API TODAY`,
    ...ids(config, data).map(row),
  ]
}

// GFM cell-safe: pipes and backticks would break the table, newlines break the row
const cell = (s: string): string => s.replaceAll('|', '\\|').replaceAll('`', '\\`').replace(/[\r\n]+/g, ' ')

// GitHub-flavored step summary: table plus a loud line per identity on the fallback chain
export const markdown = (config: { identities?: Record<string, unknown> } | null, data: StatusData | null): string[] => {
  const row = (id: string): string => {
    const s = data?.identities?.[id]
    const tier = !s || s.tier === 'max' || s.pin === 'max' ? 'max' : short(s.model ?? '')
    return `| ${cell(id)} | ${cell(tier)} | ${pct(s?.util5h)} | ${pct(s?.util7d)} | ${s?.resetAt ? hhmm(s.resetAt) : '—'} | $${Number(data?.spend?.[id] ?? 0).toFixed(2)} |`
  }
  const fell = (id: string): string => {
    const s = data?.identities?.[id]
    return `⚠ ${cell(id)} fell back to ${cell(short(s?.model ?? ''))} (${cell(s?.reason ?? 'fallback')})`
  }
  return [
    '| Identity | Tier | Max 5h | Max 7d | Resets | API today |',
    '| --- | --- | --- | --- | --- | --- |',
    ...ids(config, data).map(row),
    ...ids(config, data).filter((id) => data?.identities?.[id]?.tier === 'fallback').map(fell),
  ]
}

// configured models that left the catalog, and catalog models the picker hasn't seen yet
export const nudges = (
  config: Config | null,
  models: CatalogModel[] | null,
  { read = readSettings }: { read?: (dir: string) => ClaudeSettings } = {},
): { missing: string[]; fresh: string[] } => {
  if (!models || !config) return { missing: [], fresh: [] }
  const missing = check(config, models)
  const dir = Object.values(config?.identities ?? {})[0]?.claude_config_dir
  const opts = dir ? (read(dir)?.modelPicker?.options ?? []) : []
  const have = new Set(opts.map((o) => catalog.bare(o.model)))
  const fresh = select(models, config?.models ?? {})
    .filter((m) => !have.has(catalog.bare(m.id)))
    .map((m) => m.id)
  return { missing, fresh }
}

export default async (argv: string[], ctx: CommandCtx): Promise<void> => {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, markdown: { type: 'boolean' } } })
  const data = await fetchJson(`${base(ctx.config)}/status`)
  if (!data) {
    if (values.markdown) return ctx.print('> barrito: router not running')
    console.error('router not running — barrito doctor')
    return ctx.exit(1)
  }
  if (values.json) return ctx.print(JSON.stringify(data, null, 2))
  if (values.markdown) return markdown(ctx.config, parse(data)).forEach((line) => ctx.print(line))

  table(ctx.config, parse(data)).forEach((line) => ctx.print(line))

  const models = catalog.cached({ statePath: paths.state })
  if (!models) return
  const { missing, fresh } = nudges(ctx.config, models)
  if (missing.length) ctx.print(`! ${missing.length} configured model${missing.length > 1 ? 's' : ''} missing from the gateway catalog → barrito doctor`)
  if (fresh.length) ctx.print(`! ${fresh.length} new gateway models match your rules → barrito models sync`)
}

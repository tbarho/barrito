import pc from 'picocolors'
import { parseArgs } from 'node:util'
import { paths } from '../paths.ts'
import { glyphs } from '../glyphs.ts'
import * as catalog from '../catalog.ts'
import { check, select } from '../models.ts'
import { read as readSettings } from '../settings.ts'
import type { Caveman, CatalogModel, ClaudeSettings, CommandCtx, Config, FetchJson, StatusData, StatusTransforms, TierSnapshot } from '../types.ts'

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

// → { status, data? } | null (unreachable); data is the parsed JSON of a 2xx response
export const postJson = async (url: string, body: unknown, { timeout = 3000, fetch: f = fetch }: { timeout?: number; fetch?: FetchJson } = {}): Promise<{ status: number; data?: unknown } | null> => {
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
    if (!res) return null
    if (!res.ok) return { status: res.status ?? 0 }
    let data: unknown
    try {
      data = await res.json()
    } catch {
      return null
    }
    return { status: res.status ?? 200, data }
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

const CAVEMAN = ['off', 'lite', 'full', 'ultra']

// /status JSON → StatusData; null when it isn't an object
export const parse = (v: unknown): StatusData | null => {
  if (!isObj(v)) return null
  const spend = Object.fromEntries(Object.entries(isObj(v.spend) ? v.spend : {})
    .flatMap(([id, amount]) => typeof amount === 'number' ? [[id, amount] as const] : []))
  const transforms = Object.fromEntries(Object.entries(isObj(v.transforms) ? v.transforms : {})
    .flatMap(([id, t]) => {
      if (!isObj(t) || !isObj(t.state)) return []
      const st = t.state
      const caveman = typeof st.caveman === 'string' && CAVEMAN.includes(st.caveman) ? (st.caveman as Caveman) : 'off'
      return [[id, {
        state: { rtk: st.rtk === true, caveman },
        saved: num(t.saved) ?? 0,
        compressed: num(t.compressed) ?? 0,
      }] as [string, StatusTransforms]]
    }))
  return {
    pid: num(v.pid),
    uptime: num(v.uptime),
    identities: isObj(v.identities) ? v.identities as Record<string, Partial<TierSnapshot>> : {},
    spend,
    transforms,
    rtk: v.rtk === true,
  }
}

export const bytes = (n: number): string =>
  n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}kB` : `${(n / 1024 / 1024).toFixed(1)}MB`

// TRANSFORMS cell: rtk · cave:<level> (parts that are off omitted) plus bytes saved today
export const cellTransforms = (t: StatusTransforms | undefined): string => {
  if (!t) return '—'
  const parts = [t.state.rtk ? 'rtk' : '', t.state.caveman !== 'off' ? `cave:${t.state.caveman}` : '']
    .filter(Boolean)
  if (t.saved > 0) parts.push(`${bytes(t.saved)} saved`)
  return parts.length ? parts.join(' · ') : '—'
}

const ids = (config: { identities?: Record<string, unknown> } | null, data: StatusData | null): string[] => [
  ...Object.keys(config?.identities ?? {}),
  ...Object.keys(data?.identities ?? {}).filter((id) => !config?.identities?.[id]),
]

type Paint = Pick<ReturnType<typeof pc.createColors>, 'dim' | 'green' | 'yellow'>

// columns keep their classic widths and grow for longer cells, so every row stays aligned;
// paint colors after padding (max green, fallback yellow, header dim) — plain by default
export const table = (
  config: { identities?: Record<string, unknown> } | null,
  data: StatusData | null,
  paint: Paint = pc.createColors(false),
): string[] => {
  const head = ['IDENTITY', 'TIER', 'MAX 5H', 'MAX 7D', 'RESETS', 'API TODAY', 'TRANSFORMS']
  const min = [11, 14, 9, 9, 9, 11, 0]
  const rows = ids(config, data).map((id) => {
    const s = data?.identities?.[id]
    const max = !s || s.tier === 'max' || s.pin === 'max'
    return {
      max,
      cells: [
        id,
        max ? 'max' : `${glyphs.warn} ${short(s.model ?? '')}`,
        pct(s?.util5h),
        pct(s?.util7d),
        s?.resetAt ? hhmm(s.resetAt) : '—',
        `$${Number(data?.spend?.[id] ?? 0).toFixed(2)}`,
        cellTransforms(data?.transforms?.[id]),
      ],
    }
  })
  const widths = min.map((w, i) => i === min.length - 1 ? 0 : Math.max(w, ...[head, ...rows.map((r) => r.cells)].map((c) => (c[i] ?? '').length + 2)))
  const line = (cells: string[], color: (cell: string, i: number) => string): string =>
    cells.map((cell, i) => color(cell.padEnd(widths[i] ?? 0), i)).join('').trimEnd()
  return [
    line(head, (cell) => paint.dim(cell)),
    ...rows.map((r) => line(r.cells, (cell, i) => i !== 1 ? cell : r.max ? paint.green(cell) : paint.yellow(cell))),
  ]
}

// unconfirmed 429s passed through to Claude Code's own backoff — visible so burst patterns show
export const throttles = (config: { identities?: Record<string, unknown> } | null, data: StatusData | null): string[] =>
  ids(config, data).flatMap((id) => {
    const n = num(data?.identities?.[id]?.throttled429Today) ?? 0
    return n > 0 ? [`${id}: ${n} throttled 429${n > 1 ? 's' : ''} passed to Claude Code today`] : []
  })

// GFM cell-safe: pipes and backticks would break the table, newlines break the row
const cell = (s: string): string => s.replaceAll('|', '\\|').replaceAll('`', '\\`').replace(/[\r\n]+/g, ' ')

// GitHub-flavored step summary: table plus a loud line per identity on the fallback chain
export const markdown = (config: { identities?: Record<string, unknown> } | null, data: StatusData | null): string[] => {
  const row = (id: string): string => {
    const s = data?.identities?.[id]
    const tier = !s || s.tier === 'max' || s.pin === 'max' ? 'max' : short(s.model ?? '')
    return `| ${cell(id)} | ${cell(tier)} | ${pct(s?.util5h)} | ${pct(s?.util7d)} | ${s?.resetAt ? hhmm(s.resetAt) : '—'} | $${Number(data?.spend?.[id] ?? 0).toFixed(2)} | ${cell(cellTransforms(data?.transforms?.[id]))} |`
  }
  const fell = (id: string): string => {
    const s = data?.identities?.[id]
    return `${glyphs.warn} ${cell(id)} fell back to ${cell(short(s?.model ?? ''))} (${cell(s?.reason ?? 'fallback')})`
  }
  return [
    '| Identity | Tier | Max 5h | Max 7d | Resets | API today | Transforms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...ids(config, data).map(row),
    ...ids(config, data).filter((id) => data?.identities?.[id]?.tier === 'fallback').map(fell),
    ...throttles(config, data).map(cell),
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

  table(ctx.config, parse(data), pc).forEach((line) => ctx.print(line))
  throttles(ctx.config, parse(data)).forEach((line) => ctx.print(pc.dim(line)))

  const models = catalog.cached({ statePath: paths.state })
  if (!models) return
  const { missing, fresh } = nudges(ctx.config, models)
  if (missing.length) ctx.print(`${pc.yellow('!')} ${missing.length} configured model${missing.length > 1 ? 's' : ''} missing from the gateway catalog → barrito doctor`)
  if (fresh.length) ctx.print(`${pc.yellow('!')} ${fresh.length} new gateway models match your rules → barrito models sync`)
}

import { existsSync, readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import type { CatalogCache, CatalogModel, Clock, FetchJson, Price, Reader, Writer } from './types.ts'

const url = (): string => `${process.env.BARRITO_GATEWAY || 'https://ai-gateway.vercel.sh'}/v1/models`

export const bare = (id: string): string => id.replace(/^claude-code\//, '').replace(/\[1m\]$/, '')

const isModel = (v: unknown): v is CatalogModel =>
  typeof v === 'object' && v !== null &&
  typeof (v as Record<string, unknown>).id === 'string' &&
  typeof (v as Record<string, unknown>).name === 'string' &&
  typeof (v as Record<string, unknown>).type === 'string'

const asCache = (v: unknown): CatalogCache | null => {
  if (typeof v !== 'object' || v === null) return null
  const c = v as Record<string, unknown>
  if (typeof c.fetchedAt !== 'number' || !Array.isArray(c.data)) return null
  return { fetchedAt: c.fetchedAt, data: c.data.filter(isModel) }
}

const read = (file: string, fs: Reader): CatalogCache | null => {
  if (!fs.existsSync(file)) return null
  try {
    return asCache(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export const refresh = async ({ fetch: f = fetch, key, statePath, fs = fsp, now = Date.now, write = true }: {
  fetch?: FetchJson
  key?: string
  statePath: string
  fs?: Writer
  now?: Clock
  write?: boolean
}): Promise<CatalogModel[]> => {
  const res = await f(url(), { headers: key ? { authorization: `Bearer ${key}` } : {} })
  if (!res.ok) throw new Error(`gateway catalog ${res.status}`)
  const { data } = await res.json() as { data?: unknown }
  if (!Array.isArray(data)) throw new Error('gateway catalog: unexpected payload')
  if (!write) return data
  const file = `${statePath}/catalog.json`
  await fs.mkdir(statePath, { recursive: true })
  await fs.writeFile(`${file}.tmp`, JSON.stringify({ fetchedAt: now(), data }))
  await fs.rename(`${file}.tmp`, file)
  return data
}

export const cached = ({ statePath, maxAge = 86400e3, now = Date.now(), fs = { existsSync, readFileSync }, stale = false }: {
  statePath: string
  maxAge?: number
  now?: number
  fs?: Reader
  stale?: boolean
}): CatalogModel[] | null => {
  const cache = read(`${statePath}/catalog.json`, fs)
  if (!cache) return null
  if (!stale && now - cache.fetchedAt > maxAge) return null
  return cache.data
}

// the cache itself, any age: { fetchedAt, data } | null
export const last = ({ statePath, fs = { existsSync, readFileSync } }: { statePath: string; fs?: Reader }): CatalogCache | null =>
  read(`${statePath}/catalog.json`, fs)

// base-tier per-token prices; long-context surcharge tiers are ignored (spend undercounts past the tier threshold)
export const price = (models: CatalogModel[], id: string): Price | null => {
  const entry = models.find((m) => m.id === bare(id))
  const p = entry?.pricing
  if (!p || p.input == null || p.output == null) return null
  return { input: Number(p.input), output: Number(p.output), input_cache_read: Number(p.input_cache_read ?? 0) }
}

import fs from 'node:fs'
import path from 'node:path'
import type { Clock, Price, Spend, Usage } from '../types.ts'

const round = (n: number) => Math.round(n * 1e6) / 1e6

type Days = Record<string, Record<string, number>>

export const create = ({
  prices, statePath, now = Date.now,
}: {
  prices: (id: string) => Price | null
  statePath: string
  now?: Clock
}): Spend => {
  const file = path.join(statePath, 'spend.json')

  const day = (t: number): string => {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const load = (): Days => {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
    let raw: unknown
    try { raw = JSON.parse(text) } catch { raw = null }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      try { fs.renameSync(file, `${file}.bad-${now()}`) } catch {} // corrupt → set aside, start fresh
      return {}
    }
    return Object.entries(raw).reduce((memo, [key, value]) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return memo
      memo[key] = Object.entries(value).reduce((ids, [id, n]) => {
        if (typeof n === 'number') ids[id] = n
        return ids
      }, {} as Record<string, number>)
      return memo
    }, {} as Days)
  }
  let days: Days = load()

  const save = (): void => {
    try {
      fs.mkdirSync(statePath, { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(days))
      fs.renameSync(tmp, file)
    } catch {}
  }

  const record = (id: string, model: string, usage: Usage = {}): number => {
    const p = prices(model)
    if (!p) return 0
    const {
      input_tokens: input = 0,
      output_tokens: output = 0,
      cache_read_input_tokens: read = 0,
      cache_creation_input_tokens: created = 0,
    } = usage
    // cache creation is priced at 1.25 × input
    const usd = input * p.input + output * p.output + read * (p.input_cache_read ?? 0) + created * p.input * 1.25
    const key = day(now())
    const ids = days[key] ?? {}
    days = { [key]: ids } // local-midnight rollover drops old days
    const total = round((ids[id] ?? 0) + usd)
    ids[id] = total
    save()
    return total
  }

  const today = (): Record<string, number> => days[day(now())] ?? {}

  return { record, today }
}

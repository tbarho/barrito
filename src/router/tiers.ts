import fs from 'node:fs'
import path from 'node:path'
import type {
  Clock, Notify, Observation, Reason, Retry, TierSnapshot, TierState, Tiers, TiersConfig,
} from '../types.ts'

const HOUR = 3600e3
const WINDOW = 60e3
const MAX_BACKOFF = 15 * 60e3

type Headers = Record<string, string | null | undefined>
// Observation accepts omitted model/headers on direct hops (server always sends both)
type Obs = Omit<Observation, 'headers' | 'model'> & { model?: string; headers?: Record<string, string> }
type Verdict = { retry: Retry | null }

// outageRetry: the one free direct retry a first 5xx/connect failure earns.
// t429Day/t429: unconfirmed 429s passed through to Claude Code today (local day)
type State = Omit<TierState, 'retryDirect'> & { outageRetry: boolean; t429Day: string | null; t429: number }

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const day = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const label = (config: TiersConfig | null | undefined, id: string): string => {
  const custom = config?.models?.labels?.[id]
  if (custom) return custom
  const bare = String(id).split('/').pop() ?? ''
  return bare.replace(/\[[^\]]*\]$/, '').replace(/-/g, ' ').toUpperCase()
}

// epoch seconds or RFC3339 → ms; null when absent/unparseable
const when = (v: string | null | undefined): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n
  const p = Date.parse(v)
  return Number.isNaN(p) ? null : p
}

const num = (headers: Headers, key: string): number | null => {
  const v = headers[key]
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

const H = {
  claim: 'anthropic-ratelimit-unified-representative-claim',
  reset5h: 'anthropic-ratelimit-unified-5h-reset',
  reset7d: 'anthropic-ratelimit-unified-7d-reset',
  status5h: 'anthropic-ratelimit-unified-5h-status',
  status7d: 'anthropic-ratelimit-unified-7d-status',
  unifiedStatus: 'anthropic-ratelimit-unified-status',
  unifiedReset: 'anthropic-ratelimit-unified-reset',
  util5h: 'anthropic-ratelimit-unified-5h-utilization',
  util7d: 'anthropic-ratelimit-unified-7d-utilization',
}

// binding window reset: claim picks the window; claim absent or its reset missing →
// the blocked (limited/rejected) window's reset (7d wins if both); then unified-reset
const blocked = (v: string | null | undefined): boolean => v === 'limited' || v === 'rejected'
const resetFrom = (h: Headers): number | null => {
  const claim = h[H.claim]
  if (claim === 'seven_day') { const v = when(h[H.reset7d]); if (v !== null) return v }
  if (claim === 'five_hour') { const v = when(h[H.reset5h]); if (v !== null) return v }
  if (blocked(h[H.status7d])) { const v = when(h[H.reset7d]); if (v !== null) return v }
  if (blocked(h[H.status5h])) { const v = when(h[H.reset5h]); if (v !== null) return v }
  return when(h[H.unifiedReset])
}

// …then retry-after, else 5h from now
const quotaReset = (h: Headers, now: Clock): number =>
  resetFrom(h)
  ?? (() => { const ra = num(h, 'retry-after'); return ra === null ? null : now() + ra * 1000 })()
  ?? now() + 5 * HOUR

const limited = (h: Headers): boolean => h[H.status5h] === 'limited' || h[H.status7d] === 'limited'

// a 429 means "Max spent" only when the unified headers confirm it; a bare 429
// (or one whose status headers still say allowed) is a transient burst throttle
// that Claude Code backs off and retries itself — barrito passes it through
const confirmed = (h: Headers): boolean => {
  if (h[H.unifiedStatus] === 'rejected') return true
  if (blocked(h[H.status5h]) || blocked(h[H.status7d])) return true
  const claim = h[H.claim]
  if (claim !== 'five_hour' && claim !== 'seven_day') return false
  const util = num(h, claim === 'seven_day' ? H.util7d : H.util5h)
  return util !== null && util >= 1
}

const ok = (status: number): boolean => status >= 200 && status < 300

// chain membership ignores [1m]-style suffixes (case-insensitive); returned models stay raw
const bare = (id: string | null | undefined): string => String(id).replace(/\[[^\]]*\]$/i, '').toLowerCase()

export const create = ({
  config, statePath, notify, now = Date.now,
}: {
  config?: TiersConfig | null
  statePath: string
  notify?: Notify
  now?: Clock
}): Tiers => {
  const file = path.join(statePath, 'tiers.json')

  const blank = (): State => ({
    tier: 'max', reason: null, model: null, since: null,
    resetAt: null, util5h: null, util7d: null, pin: null,
    halfOpenAt: null, backoff: null, failAt: null, outageRetry: false, t429Day: null, t429: 0,
  })

  const load = (): Record<string, State> => {
    let raw: unknown
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.entries(raw).reduce((memo, [id, s]) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return memo // garbage → drop
      const known = blank()
      const patch = Object.fromEntries(Object.entries(s).filter(([k]) => k in known)) as Partial<State>
      // the retired 'throttle' fallback loads as max (keeps pin, utilization, counter)
      const retired = (s as { reason?: unknown }).reason === 'throttle'
      memo[id] = retired
        ? { ...known, ...patch, tier: 'max', reason: null, model: null, since: null, resetAt: null }
        : { ...known, ...patch }
      return memo
    }, {} as Record<string, State>)
  }
  const states = load()

  const save = (): void => {
    try {
      fs.mkdirSync(statePath, { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(states))
      fs.renameSync(tmp, file)
    } catch {}
  }

  const say = (id: string, message: string): void => {
    if (!notify) return
    try { notify('barrito', message, id) } catch {}
  }

  const st = (id: string): State => (states[id] ??= blank())
  const chain = (id: string): string[] => config?.identities?.[id]?.fallback ?? []

  const toMax = (id: string, s: State): void => {
    s.tier = 'max'
    s.reason = null
    s.model = null
    s.halfOpenAt = null
    s.backoff = null
    s.failAt = null
    s.outageRetry = false
    save()
    say(id, `${id} — Max is back.`)
  }

  // unconfirmed 429 → no tier change, no notice: forwarded verbatim, only counted
  const passthrough = (s: State): Verdict => {
    const today = day(now())
    s.t429 = s.t429Day === today ? s.t429 + 1 : 1
    s.t429Day = today
    save()
    return { retry: null }
  }

  const quota = (id: string, s: State, ch: string[], h: Headers): Verdict => {
    if (!confirmed(h)) return passthrough(s)
    if (!ch.length || s.pin === 'max') return { retry: null }
    const head = ch[0]!
    const was = s.tier === 'fallback' && s.reason === 'quota'
    s.tier = 'fallback'
    s.reason = 'quota'
    s.model = head
    const resetAt = quotaReset(h, now)
    s.resetAt = resetAt
    s.failAt = null
    s.outageRetry = false
    if (!was) s.since = now() // since marks entering a state, not repeats
    save()
    if (!was) say(id, `${id} — Max spent. Now ${label(config, head)} on API credits until ${hhmm(resetAt)}.`)
    return { retry: { to: 'gateway', model: head, reason: 'quota' } }
  }

  const outage = (id: string, s: State, ch: string[]): Verdict => {
    const t = now()
    if (s.tier === 'fallback' && s.reason === 'outage') {
      const backoff = Math.min((s.backoff ?? WINDOW) * 2, MAX_BACKOFF)
      s.backoff = backoff
      s.halfOpenAt = t + backoff
      save()
      const model = s.model ?? ch[0] // failed half-open probe resumes the chain where it left off
      return model ? { retry: { to: 'gateway', model, reason: 'outage' } } : { retry: null }
    }
    if (!s.outageRetry && !(s.failAt !== null && t - s.failAt <= WINDOW)) {
      // first failure: one free direct retry, no tier change
      s.failAt = t
      s.outageRetry = true
      save()
      return { retry: { to: 'direct', delay: 0 } }
    }
    if (!ch.length || s.pin === 'max') {
      s.failAt = null
      s.outageRetry = false
      save()
      return { retry: null }
    }
    const head = ch[0]!
    s.tier = 'fallback'
    s.reason = 'outage'
    s.model = head
    s.since = t
    s.resetAt = null
    s.backoff = WINDOW
    s.halfOpenAt = t + WINDOW
    s.failAt = null
    s.outageRetry = false
    save()
    say(id, `${id} — Anthropic unreachable. Now ${label(config, head)} on API credits.`)
    return { retry: { to: 'gateway', model: head, reason: 'outage' } }
  }

  // limited-on-2xx refreshes the quota window but never transitions tiers (it answered)
  const quietQuota = (s: State, h: Headers): Verdict => {
    if (s.tier !== 'fallback' || s.reason !== 'quota') return { retry: null }
    const at = quotaReset(h, now)
    if (at !== s.resetAt) { s.resetAt = at; save() }
    return { retry: null }
  }

  const landed = (id: string, s: State, h: Headers): Verdict => {
    let dirty = ([['util5h', H.util5h], ['util7d', H.util7d]] as ['util5h' | 'util7d', string][])
      .reduce((memo, [k, header]) => {
        const v = num(h, header)
        if (v === null || s[k] === v) return memo
        s[k] = v
        return true
      }, false)
    const reset = resetFrom(h)
    if (reset !== null && s.resetAt !== reset) { s.resetAt = reset; dirty = true }
    if (s.failAt !== null || s.outageRetry) { s.failAt = null; s.outageRetry = false; dirty = true }
    if (dirty) save()
    // quota keeps its window; a limited-status 2xx only refreshes it (it answered)
    if (limited(h)) return quietQuota(s, h)
    if (s.tier === 'fallback') toMax(id, s)
    return { retry: null }
  }

  const direct = (
    id: string, s: State, ch: string[],
    { status, headers = {} }: { status: number; headers?: Headers },
  ): Verdict => {
    if (ok(status)) return landed(id, s, headers)
    if (status === 429) return quota(id, s, ch, headers)
    if (!status || status === 529 || status >= 500) return outage(id, s, ch)
    return { retry: null }
  }

  const hopFail = (id: string, s: State, ch: string[], model: string | undefined): Verdict => {
    // a pin is that model only (or max only): its failure surfaces to the caller.
    // max never routes gateway, so a hop failure outside a fallback tier also surfaces.
    if (s.pin || s.tier !== 'fallback') return { retry: null }
    const i = ch.findIndex((entry) => bare(entry) === bare(model))
    const next = i === -1 ? ch[0] : ch[i + 1] ?? null
    s.model = next ?? ch[0] ?? null // exhausted → fresh walk from the head next request
    save()
    return next ? { retry: { to: 'gateway', model: next, reason: s.reason as Reason } } : { retry: null }
  }

  return {
    route(id, _model) {
      const s = st(id)
      if (s.pin === 'max') return { to: 'direct' }
      if (s.pin) return { to: 'gateway', model: s.pin, reason: 'pinned' }
      if (s.tier !== 'fallback') return { to: 'direct' }
      if (s.reason === 'quota' && s.resetAt !== null && now() >= s.resetAt) return { to: 'direct' }
      if (s.reason === 'outage' && s.halfOpenAt !== null && now() >= s.halfOpenAt) return { to: 'direct' }
      const ch = chain(id)
      const model = ch.find((entry) => bare(entry) === bare(s.model)) ?? ch[0] // stale → head
      return model ? { to: 'gateway', model, reason: s.reason as Reason } : { to: 'direct' }
    },

    observe(id: string, { to, model, status, headers = {} }: Obs): Verdict {
      const s = st(id)
      const ch = chain(id)
      if (to === 'direct') return direct(id, s, ch, { status, headers })
      if (ok(status)) return { retry: null }
      if (status === 429 || !status || status === 529 || status >= 500) return hopFail(id, s, ch, model)
      return { retry: null }
    },

    pin(id, value) {
      if (value == null) { st(id).pin = null; save(); return }
      if (value !== 'max' && (typeof value !== 'string' || !value.includes('/'))) {
        throw new Error(`barrito pin: expected 'max', a gateway model id (provider/model), or null — got ${JSON.stringify(value)}`)
      }
      st(id).pin = value
      save()
    },

    snapshot(): Record<string, TierSnapshot> {
      return Object.fromEntries(Object.entries(states).map(([id, s]): [string, TierSnapshot] => {
        const pinned = Boolean(s.pin)
        return [id, {
          tier: pinned ? 'pinned' : s.tier,
          reason: pinned ? 'pinned' : s.reason,
          model: pinned ? (s.pin === 'max' ? null : s.pin) : s.model,
          since: s.since,
          resetAt: s.resetAt,
          util5h: s.util5h,
          util7d: s.util7d,
          pin: s.pin,
          throttled429Today: s.t429Day === day(now()) ? s.t429 : 0,
        }]
      }))
    },
  }
}

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { root } from '../paths.ts'

// optional, toggleable token savers applied to request bodies:
// RTK compresses noisy tool_result content through the user's `rtk` CLI,
// caveman appends a terse-response instruction to the system prompt.

export type Caveman = 'off' | 'lite' | 'full' | 'ultra'

export interface TransformState { rtk: boolean; caveman: Caveman }
export interface Applied { rtk: number; caveman: Caveman; saved: number }

export type TransformExec = (args: string[], input: string, timeoutMs: number) => string | null

export interface Transforms {
  state(id: string): TransformState
  set(id: string, patch: Partial<TransformState> | null): TransformState
  anthropic(id: string, body: Record<string, unknown>): { body: Record<string, unknown>; applied: Applied }
  openai(id: string, body: Record<string, unknown>): { body: Record<string, unknown>; applied: Applied }
  available(): boolean
  stats(): Record<string, { saved: number; compressed: number }>
}

const MIN = 1500
const TIMEOUT = 300
const CAVEMANS = new Set(['off', 'lite', 'full', 'ultra'])

// rtk 0.49 `pipe` filter names — the only ones `--filter` accepts
const FILTERS = new Set([
  'cargo-test', 'pytest', 'go-test', 'go-build', 'ctest', 'tsc', 'vitest', 'grep', 'rg', 'find', 'fd',
  'git-log', 'git-diff', 'git-status', 'log', 'mypy', 'ruff-check', 'ruff-format', 'sqlfluff-lint',
  'prettier', 'phpunit', 'pest', 'paratest', 'php-test', 'ecs', 'phpstan', 'pint',
])

// strings rtk emits when it has already filtered output — re-filtering would double-compress
const MARKERS = [
  /\[\+\d+ lines omitted\]/,
  /\(\d+ lines omitted\)/,
  /\d+ matches in \d+ files?:/,
  /matches in \d+F:/,
  /\d+ files in \d+ dirs:/,
  /^\[file\] /m,
  /\s\+\d+ -\d+\s*$/,   // git-diff summary tail
  /^\s*\+\d+$/m,         // find per-dir file tail
]

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// insertion-ordered Map: hit re-inserts (LRU), overflow evicts the oldest key
const lru = <V>(cap = 2000) => {
  const m = new Map<string, V>()
  return {
    get(k: string): V | undefined {
      const v = m.get(k)
      if (v === undefined) return v
      m.delete(k)
      m.set(k, v)
      return v
    },
    set(k: string, v: V): void {
      if (!m.has(k) && m.size >= cap) {
        const oldest = m.keys().next().value
        if (oldest !== undefined) m.delete(oldest)
      }
      m.set(k, v)
    },
  }
}

export const create = (o: {
  defaults: (identityId: string) => TransformState
  statePath: string
  exec?: TransformExec
  rtkPath?: string | null
  now?: () => number
}): Transforms => {
  const { defaults, statePath, now = Date.now } = o
  const file = path.join(statePath, 'transforms.json')

  const day = (t: number): string => {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const valid = (v: unknown): v is TransformState =>
    isObj(v) && typeof v.rtk === 'boolean' && typeof v.caveman === 'string' && CAVEMANS.has(v.caveman)

  const load = (): { overrides: Record<string, TransformState>; days: Record<string, Record<string, { saved: number; compressed: number }>> } => {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { return { overrides: {}, days: {} } }
    let raw: unknown
    try { raw = JSON.parse(text) } catch { raw = null }
    if (!isObj(raw)) {
      try { fs.renameSync(file, `${file}.bad-${now()}`) } catch {}
      return { overrides: {}, days: {} }
    }
    const overrides = Object.entries(isObj(raw.overrides) ? raw.overrides : {}).reduce((memo, [id, v]) => {
      if (valid(v)) memo[id] = v
      return memo
    }, {} as Record<string, TransformState>)
    const days = Object.entries(isObj(raw.days) ? raw.days : {}).reduce((memo, [day, ids]) => {
      if (!isObj(ids)) return memo
      const clean = Object.entries(ids).reduce((acc, [id, v]) => {
        if (isObj(v) && typeof v.saved === 'number' && typeof v.compressed === 'number') acc[id] = { saved: v.saved, compressed: v.compressed }
        return acc
      }, {} as Record<string, { saved: number; compressed: number }>)
      if (Object.keys(clean).length > 0) memo[day] = clean
      return memo
    }, {} as Record<string, Record<string, { saved: number; compressed: number }>>)
    return { overrides, days }
  }

  const loaded = load()
  let overrides = loaded.overrides
  let days = loaded.days

  const save = (): void => {
    try {
      fs.mkdirSync(statePath, { recursive: true })
      const today = day(now())
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ overrides, days: days[today] === undefined ? {} : { [today]: days[today] } }))
      fs.renameSync(tmp, file)
    } catch {}
  }

  const state = (id: string): TransformState => overrides[id] ?? defaults(id)

  const set = (id: string, patch: Partial<TransformState> | null): TransformState => {
    if (patch === null) {
      delete overrides[id]
    } else {
      if (patch.caveman !== undefined && !(typeof patch.caveman === 'string' && CAVEMANS.has(patch.caveman))) throw new Error(`barrito: caveman must be off|lite|full|ultra, got "${String(patch.caveman)}"`)
      if (patch.rtk !== undefined && typeof patch.rtk !== 'boolean') throw new Error('barrito: rtk must be a boolean')
      overrides[id] = { ...state(id), ...patch }
    }
    save()
    return state(id)
  }

  let bin: string | null | undefined
  const resolve = (): string | null => {
    if (bin !== undefined) return bin
    if (o.rtkPath !== undefined) bin = o.rtkPath
    else if (o.exec) bin = 'rtk' // an injected exec plays rtk — there is no binary to find
    else {
      const probe = spawnSync('sh', ['-c', `command -v ${JSON.stringify('rtk')}`], { stdio: 'ignore' })
      bin = probe.error == null && probe.status === 0 ? 'rtk' : null
    }
    return bin
  }

  const available = (): boolean => resolve() !== null

  const run: TransformExec = o.exec ?? ((args, input, timeoutMs) => {
    try {
      return execFileSync(resolve() ?? 'rtk', args, { input, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    } catch (e) {
      const err = e as { killed?: boolean; stdout?: unknown; code?: unknown }
      if (err.killed) return null
      if (typeof err.code === 'string' && err.code.includes('MAXBUFFER')) return null
      return typeof err.stdout === 'string' && err.stdout.length > 0 ? err.stdout : null // rtk rewrite exits 3 on success — stdout is the truth
    }
  })

  const rewrites = lru<string | null>()
  const pipes = lru<string>()

  const map = (rewritten: string | null): string | null => {
    if (!rewritten || !rewritten.startsWith('rtk ')) return null
    const words = rewritten.split(/\s+/)
    const a = words[1]
    const b = words[2]
    if (!a) return null
    if (b && FILTERS.has(`${a}-${b}`)) return `${a}-${b}` // rtk git log → git-log
    return FILTERS.has(a) ? a : null // rtk grep … → grep
  }

  const filterFor = (command: string): string | null => {
    const hit = rewrites.get(command)
    if (hit !== undefined) return map(hit)
    const out = run(['rewrite', command], '', TIMEOUT)
    const rewritten = out !== null && out.trim().length > 0 ? out.trim() : null
    rewrites.set(command, rewritten)
    return map(rewritten)
  }

  const pipe = (filter: string, content: string): string | null => {
    const key = crypto.createHash('sha256').update(`${filter}\u0000${content}`).digest('hex')
    const hit = pipes.get(key)
    if (hit !== undefined) return hit
    const out = run(['pipe', '--filter', filter], content, TIMEOUT)
    // empty output means the filter didn't recognize the content — keep raw
    const ok = out !== null && out.trim().length > 0 && out.length < content.length ? out : null
    if (ok) pipes.set(key, ok)
    return ok
  }

  const squeeze = (text: string, command: unknown, write: (t: string) => void): number => {
    if (text.length < MIN) return 0
    if (typeof command !== 'string' || command.length === 0) return 0
    if (MARKERS.some((m) => m.test(text))) return 0
    const filter = filterFor(command)
    if (!filter) return 0
    const out = pipe(filter, text)
    if (!out) return 0
    write(out)
    return text.length - out.length
  }

  const squeezeAnthropic = (messages: unknown): { saved: number; n: number } => {
    const commands = new Map<string, string>()
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (!isObj(m) || m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (!isObj(b) || b.type !== 'tool_use' || typeof b.id !== 'string') continue
          const input = isObj(b.input) ? b.input : {}
          if (typeof input.command === 'string') commands.set(b.id, input.command)
        }
      }
    }
    if (commands.size === 0) return { saved: 0, n: 0 }
    return (Array.isArray(messages) ? messages : []).reduce((acc, m) => {
      if (!isObj(m) || m.role !== 'user' || !Array.isArray(m.content)) return acc
      for (const b of m.content) {
        if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        const c = b.content
        if (typeof c === 'string') {
          const saved = squeeze(c, commands.get(b.tool_use_id), (t) => { b.content = t })
          if (saved > 0) { acc.saved += saved; acc.n++ }
          continue
        }
        if (!Array.isArray(c)) continue
        const texts = c.filter((p): p is { text: string } => isObj(p) && p.type === 'text' && typeof p.text === 'string')
        if (texts.length !== 1) continue // multi-text tool_results are left alone
        const first = texts[0]!
        const saved = squeeze(first.text, commands.get(b.tool_use_id), (t) => { first.text = t })
        if (saved > 0) { acc.saved += saved; acc.n++ }
      }
      return acc
    }, { saved: 0, n: 0 })
  }

  const squeezeOpenai = (messages: unknown): { saved: number; n: number } => {
    const commands = new Map<string, string>()
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (!isObj(m) || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
        for (const tc of m.tool_calls) {
          if (!isObj(tc) || !isObj(tc.function) || typeof tc.id !== 'string' || typeof tc.function.arguments !== 'string') continue
          try {
            const args: unknown = JSON.parse(tc.function.arguments)
            if (isObj(args) && typeof args.command === 'string') commands.set(tc.id, args.command)
          } catch {}
        }
      }
    }
    if (commands.size === 0) return { saved: 0, n: 0 }
    return (Array.isArray(messages) ? messages : []).reduce((acc, m) => {
      if (!isObj(m) || m.role !== 'tool' || typeof m.content !== 'string' || typeof m.tool_call_id !== 'string') return acc
      const saved = squeeze(m.content, commands.get(m.tool_call_id), (t) => { m.content = t })
      if (saved > 0) { acc.saved += saved; acc.n++ }
      return acc
    }, { saved: 0, n: 0 })
  }

  const prompts = new Map<Caveman, string | null>()
  const cavemanText = (level: Caveman): string | null => {
    if (prompts.has(level)) return prompts.get(level) ?? null
    let text: string | null = null
    try { text = fs.readFileSync(path.join(root(), 'templates', 'caveman', `${level}.md`), 'utf8').replace(/\s+$/, '') } catch {}
    prompts.set(level, text)
    return text
  }

  const cavemanAnthropic = (body: Record<string, unknown>, prompt: string): void => {
    const sys = body.system
    if (typeof sys === 'string') body.system = `${sys}\n\n${prompt}`
    else if (Array.isArray(sys)) sys.push({ type: 'text', text: prompt }) // appended after every existing block — cache_control stays put
    else body.system = prompt
  }

  const cavemanOpenai = (body: Record<string, unknown>, prompt: string): void => {
    const messages = body.messages
    if (!Array.isArray(messages)) return
    const first = messages.find((m) => isObj(m) && (m.role === 'system' || m.role === 'developer')) as Record<string, unknown> | undefined
    if (first === undefined) {
      messages.unshift({ role: 'system', content: prompt })
      return
    }
    if (typeof first.content === 'string') first.content = `${first.content}\n\n${prompt}`
    else if (Array.isArray(first.content)) first.content.push({ type: 'text', text: prompt })
    else first.content = prompt
  }

  const bump = (id: string, applied: Applied): void => {
    if (applied.rtk === 0) return
    const key = day(now())
    const ids = days[key] ?? {}
    days = { [key]: ids } // local-midnight rollover drops old days
    const s = ids[id] ?? { saved: 0, compressed: 0 }
    s.saved += applied.saved
    s.compressed += applied.rtk
    ids[id] = s
    save()
  }

  const transform = (id: string, raw: Record<string, unknown>, squeeze: (messages: unknown) => { saved: number; n: number }, caveman: (body: Record<string, unknown>, prompt: string) => void): { body: Record<string, unknown>; applied: Applied } => {
    const st = state(id)
    const useRtk = st.rtk && available()
    const prompt = st.caveman === 'off' ? null : cavemanText(st.caveman)
    const applied: Applied = { rtk: 0, caveman: st.caveman, saved: 0 }
    if (!useRtk && !prompt) return { body: raw, applied }
    const body = structuredClone(raw) // the caller's body is never mutated, so a retried request can't double-apply
    if (useRtk) {
      const { saved, n } = squeeze(body.messages)
      applied.saved = saved
      applied.rtk = n
      bump(id, applied)
    }
    if (prompt) caveman(body, prompt)
    return { body, applied }
  }

  const anthropic = (id: string, body: Record<string, unknown>) => transform(id, body, squeezeAnthropic, cavemanAnthropic)
  const openai = (id: string, body: Record<string, unknown>) => transform(id, body, squeezeOpenai, cavemanOpenai)

  const stats = () => days[day(now())] ?? {}

  return { state, set, anthropic, openai, available, stats }
}

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import statusline from '../src/cli/statusline.ts'
import type { StatuslineOpts } from '../src/cli/statusline.ts'
import type { CommandCtx, Config, FetchJson, Identity } from '../src/types.ts'

const keys = ['BARRITO_HOME']
let prev: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-statusline-'))
  process.env.BARRITO_HOME = tmp
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

const idn = (over: Partial<Identity> = {}): Identity => ({
  id: '',
  claude_config_dir: '',
  share_from: null,
  fallback: [],
  match: { remotes: [], paths: [] },
  keychain: {},
  ...over,
})

const config = (): Config => ({
  port: 4141,
  default: 'personal',
  identities: { work: idn(), personal: idn() },
  models: { include: [], exclude: [], require: [], max_input_price: null, pin: [], labels: {}, suffix: {}, agents: {} },
  graft: { roots: [], repos: [] },
  harness: {},
})

type TestCtx = CommandCtx & { printed: string[]; codes: number[] }

const run = async (argv: string[], stdin: string, fetch: FetchJson, over: Partial<StatuslineOpts> = {}): Promise<string[]> => {
  const out = { printed: [] as string[], codes: [] as number[] }
  const c: TestCtx = {
    printed: out.printed,
    codes: out.codes,
    config: config(),
    print: (s: string) => { out.printed.push(s) },
    exit: (x: number) => { out.codes.push(x) },
  }
  await statusline(argv, c, {
    stdin,
    fetch,
    resolve: (cwd, { config: cfg }) => ({ id: cwd && cfg.identities[cwd] ? cwd : 'work', rule: 'default', detail: '' }),
    ...over,
  })
  return c.printed
}

const ok = (data: unknown): FetchJson => async () => ({ ok: true, json: async () => data })
const at = (h: number, m: number): string => {
  const d = new Date(2026, 9, 1, h, m)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── legacy rows (no session model in the stdin JSON) ──────────────────────────

test('max tier shows identity and Max percentage', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.62 } }, spend: {} }
  const out = await run([], JSON.stringify({ cwd: 'work', rate_limits: { five_hour: { used_percentage: 62 } } }), ok(data))
  assert.deepEqual(out, ['work | Max 62%'])
})

test('Claude Code rate limits win over the router snapshot', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.5 } }, spend: {} }
  const out = await run([], JSON.stringify({
    workspace: { current_dir: 'work' },
    rate_limits: { five_hour: { used_percentage: 47 } },
  }), ok(data))
  assert.deepEqual(out, ['work | Max 47%'])
})

test('falls back to snapshot utilization when rate limits are absent', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.62 } }, spend: {} }
  const out = await run([], JSON.stringify({ cwd: 'work' }), ok(data))
  assert.deepEqual(out, ['work | Max 62%'])
})

test('pinned to max renders like max plus the pin marker', async () => {
  const data = { identities: { work: { tier: 'pinned', pin: 'max', model: null, util5h: 0.9 } }, spend: {} }
  const out = await run([], JSON.stringify({ cwd: 'work' }), ok(data))
  assert.deepEqual(out, ['work | Max 90% | pin max'])
})

test('fallback tier shows label, API spend and reset', async () => {
  const resetAt = new Date(2026, 9, 1, 14, 5).getTime()
  const data = {
    identities: { personal: { tier: 'fallback', model: 'zai/glm-5.3', resetAt } },
    spend: { personal: 1.84 },
  }
  const out = await run([], JSON.stringify({ cwd: 'personal' }), ok(data))
  assert.deepEqual(out, [`personal | ! GLM 5.3 (API) | Max resets ${at(14, 5)}`])
})

test('pinned model shows the pin, without spend when $0', async () => {
  const resetAt = new Date(2026, 9, 1, 14, 5).getTime()
  const data = {
    identities: { personal: { tier: 'pinned', pin: 'zai/glm-5.3', model: 'zai/glm-5.3', resetAt } },
    spend: { personal: 0 },
  }
  const out = await run([], JSON.stringify({ cwd: 'personal' }), ok(data))
  assert.deepEqual(out, [`personal | pin GLM 5.3 | Max resets ${at(14, 5)}`])
})

test('rate_limits.resets_at beats the snapshot reset', async () => {
  const data = {
    identities: { personal: { tier: 'fallback', model: 'zai/glm-5.3', resetAt: new Date(2099, 0, 1).getTime() } },
    spend: { personal: 1 },
  }
  const iso = new Date(2026, 9, 1, 9, 41)
  const out = await run([], JSON.stringify({
    cwd: 'personal',
    rate_limits: { resets_at: iso.toISOString() },
  }), ok(data))
  assert.deepEqual(out, [`personal | ! GLM 5.3 (API) | Max resets ${at(9, 41)}`])
})

test('router unreachable prints just the identity', async () => {
  const hang = (): FetchJson => () => new Promise(() => {})
  const started = Date.now()
  const out = await run([], JSON.stringify({ cwd: 'work' }), hang())
  assert.deepEqual(out, ['work'])
  assert.ok(Date.now() - started < 1000)
})

test('fetch rejection degrades to the identity', async () => {
  const boom = (): FetchJson => async () => { throw new Error('refused') }
  const out = await run([], JSON.stringify({ cwd: 'work' }), boom())
  assert.deepEqual(out, ['work'])
})

test('garbage stdin never throws', async () => {
  const out = await run([], 'not json at all', ok({ identities: {}, spend: {} }))
  assert.deepEqual(out, ['work'])
})

test('--append prints their statusline first, two spaces, then ours', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.62 } }, spend: {} }
  const spawn = (cmd: string, opts: { shell: boolean; input: string; encoding: 'utf8' }) => {
    assert.equal(cmd, 'their-statusline')
    assert.equal(opts.input, JSON.stringify({ cwd: 'work' }))
    return { stdout: 'existing line\n' }
  }
  const out = await run(['--append', 'their-statusline'], JSON.stringify({ cwd: 'work' }), ok(data), { spawn })
  assert.deepEqual(out, ['existing line  work | Max 62%'])
})

test('--append with a failing command prints ours alone', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.62 } }, spend: {} }
  const out = await run(['--append', 'broken'], JSON.stringify({ cwd: 'work' }), ok(data), {
    spawn: () => ({ stdout: '' }),
  })
  assert.deepEqual(out, ['work | Max 62%'])
})

// ── session-model rows (model.id + model.display_name in the stdin JSON) ──────

test('max tier shows the session model first, then Max percentage', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.03 } }, spend: {} }
  const stdin = JSON.stringify({
    cwd: 'work',
    model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
    rate_limits: { five_hour: { used_percentage: 3 } },
  })
  const out = await run([], stdin, ok(data))
  assert.deepEqual(out, ['work | Fable 5.1 | Max 3%'])
})

test('model pretty-printing without a display_name: claude-opus-5-5 → Opus 5.5', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.03 } }, spend: {} }
  const out = await run([], JSON.stringify({ cwd: 'work', model: { id: 'claude-opus-5-5' } }), ok(data))
  assert.deepEqual(out, ['work | Opus 5.5 | Max 3%'])
})

test('fallback tier: session model, arrow, the model actually answering, spend, reset', async () => {
  const resetAt = new Date(2026, 9, 1, 17, 50).getTime()
  const data = {
    identities: { work: { tier: 'fallback', reason: 'quota', model: 'zai/glm-5.3', resetAt } },
    spend: { work: 1.2 },
  }
  const out = await run([], JSON.stringify({ cwd: 'work', model: { id: 'claude-opus-5-5' } }), ok(data))
  assert.deepEqual(out, [`work | Opus 5.5 > GLM 5.3 (API) | Max resets ${at(17, 50)}`])
})

test('throttle fallback says throttled with the short probe reset', async () => {
  const resetAt = new Date(2026, 9, 1, 17, 56).getTime()
  const data = {
    identities: { work: { tier: 'fallback', reason: 'throttle', model: 'zai/glm-5.3', resetAt } },
    spend: { work: 0.4 },
  }
  const out = await run([], JSON.stringify({ cwd: 'work', model: { id: 'claude-opus-5-5' } }), ok(data))
  assert.deepEqual(out, [`work | Opus 5.5 > GLM 5.3 (API) | throttled, retry ${at(17, 56)}`])
})

test('explicit gateway picker row: no arrow, no Max, just the model (and spend)', async () => {
  const data = { identities: { personal: { tier: 'max' } }, spend: { personal: 0.5 } }
  const stdin = JSON.stringify({
    cwd: 'personal',
    model: { id: 'claude-code/openai/gpt-6-astra', display_name: 'GPT-6 Astra' },
  })
  const out = await run([], stdin, ok(data))
  assert.deepEqual(out, ['personal | GPT-6 Astra (API)'])
})

test('explicit gateway picker with no spend drops the API marker', async () => {
  const data = { identities: { personal: { tier: 'fallback', model: 'zai/glm-5.3' } }, spend: { personal: 0 } }
  const stdin = JSON.stringify({ cwd: 'personal', model: { id: 'claude-code/openai/gpt-6-astra', display_name: 'GPT-6 Astra' } })
  const out = await run([], stdin, ok(data))
  assert.deepEqual(out, ['personal | GPT-6 Astra'])
})

test('identity pinned to a model shows the pin, not the session model', async () => {
  const data = {
    identities: { work: { tier: 'pinned', pin: 'zai/glm-5.3', model: 'zai/glm-5.3' } },
    spend: { work: 0.75 },
  }
  const out = await run([], JSON.stringify({ cwd: 'work', model: { id: 'claude-opus-5-5' } }), ok(data))
  assert.deepEqual(out, ['work | pin GLM 5.3 (API)'])
})

test('pinned to max shows the session model, Max percentage, then pin max', async () => {
  const data = { identities: { work: { tier: 'pinned', pin: 'max', model: null, util5h: 0.03 } }, spend: {} }
  const stdin = JSON.stringify({
    cwd: 'work',
    model: { id: 'claude-opus-5-5' },
    rate_limits: { five_hour: { used_percentage: 3 } },
  })
  const out = await run([], stdin, ok(data))
  assert.deepEqual(out, ['work | Opus 5.5 | Max 3% | pin max'])
})

test('router unreachable with a session model shows identity and model only', async () => {
  const hang = (): FetchJson => () => new Promise(() => {})
  const out = await run([], JSON.stringify({ cwd: 'work', model: { id: 'claude-opus-5-5' } }), hang())
  assert.deepEqual(out, ['work | Opus 5.5'])
})

// ── transforms suffix ─────────────────────────────────────────────────────────

test('statusline appends rtk | cave:<level> to the max-tier line', async () => {
  const data = {
    identities: { work: { tier: 'max', util5h: 0.62 } },
    spend: {},
    transforms: { work: { state: { rtk: true, caveman: 'ultra' }, saved: 4096, compressed: 2 } },
  }
  const out = await run([], JSON.stringify({ cwd: 'work' }), ok(data))
  assert.deepEqual(out, ['work | Max 62% | rtk | cave:ultra'])
})

test('statusline appends the suffix to the fallback-tier line too, omitting off parts', async () => {
  const resetAt = new Date(2026, 9, 1, 14, 5).getTime()
  const data = {
    identities: { personal: { tier: 'fallback', model: 'zai/glm-5.3', resetAt } },
    spend: { personal: 1.84 },
    transforms: { personal: { state: { rtk: false, caveman: 'lite' }, saved: 0, compressed: 0 } },
  }
  const out = await run([], JSON.stringify({ cwd: 'personal' }), ok(data))
  assert.deepEqual(out, [`personal | ! GLM 5.3 (API) | Max resets ${at(14, 5)} | cave:lite`])
})

test('statusline omits the suffix when everything is off', async () => {
  const data = {
    identities: { work: { tier: 'max', util5h: 0.62 } },
    spend: {},
    transforms: { work: { state: { rtk: false, caveman: 'off' }, saved: 0, compressed: 0 } },
  }
  const out = await run([], JSON.stringify({ cwd: 'work' }), ok(data))
  assert.deepEqual(out, ['work | Max 62%'])
})

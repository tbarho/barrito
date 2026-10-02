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

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

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

test('max tier shows identity and Max percentage', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.62 } }, spend: {} }
  const out = await run([], JSON.stringify({ cwd: 'work', rate_limits: { five_hour: { used_percentage: 62 } } }), ok(data))
  assert.deepEqual(out, ['work · Max 62%'])
})

test('Claude Code rate limits win over the router snapshot', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.5 } }, spend: {} }
  const out = await run([], JSON.stringify({
    workspace: { current_dir: 'work' },
    rate_limits: { five_hour: { used_percentage: 47 } },
  }), ok(data))
  assert.deepEqual(out, ['work · Max 47%'])
})

test('falls back to snapshot utilization when rate limits are absent', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.62 } }, spend: {} }
  const out = await run([], JSON.stringify({ cwd: 'work' }), ok(data))
  assert.deepEqual(out, ['work · Max 62%'])
})

test('pinned to max renders like max', async () => {
  const data = { identities: { work: { tier: 'pinned', pin: 'max', model: null, util5h: 0.9 } }, spend: {} }
  const out = await run([], JSON.stringify({ cwd: 'work' }), ok(data))
  assert.deepEqual(out, ['work · Max 90%'])
})

test('fallback tier shows label, API spend and reset', async () => {
  const resetAt = new Date(2026, 9, 1, 14, 5).getTime()
  const data = {
    identities: { personal: { tier: 'fallback', model: 'zai/glm-5.3', resetAt } },
    spend: { personal: 1.84 },
  }
  const out = await run([], JSON.stringify({ cwd: 'personal' }), ok(data))
  assert.deepEqual(out, ['personal · ⚠ GLM 5.3 · API $ · Max ↺ 14:05'])
})

test('pinned model renders like fallback, without spend when $0', async () => {
  const resetAt = new Date(2026, 9, 1, 14, 5).getTime()
  const data = {
    identities: { personal: { tier: 'pinned', pin: 'zai/glm-5.3', model: 'zai/glm-5.3', resetAt } },
    spend: { personal: 0 },
  }
  const out = await run([], JSON.stringify({ cwd: 'personal' }), ok(data))
  assert.deepEqual(out, ['personal · ⚠ GLM 5.3 · Max ↺ 14:05'])
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
  assert.deepEqual(out, ['personal · ⚠ GLM 5.3 · API $ · Max ↺ 09:41'])
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
  assert.deepEqual(out, ['existing line  work · Max 62%'])
})

test('--append with a failing command prints ours alone', async () => {
  const data = { identities: { work: { tier: 'max', util5h: 0.62 } }, spend: {} }
  const out = await run(['--append', 'broken'], JSON.stringify({ cwd: 'work' }), ok(data), {
    spawn: () => ({ stdout: '' }),
  })
  assert.deepEqual(out, ['work · Max 62%'])
})

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { default as statusCmd, parse, table, markdown, throttles } from '../src/cli/status.ts'
import { default as pin } from '../src/cli/pin.ts'
import { default as unpin } from '../src/cli/unpin.ts'
import { root } from '../src/paths.ts'
import type { CatalogModel, CommandCtx, Config, Identity, ModelRules, StatusData } from '../src/types.ts'

const keys = ['BARRITO_HOME', 'BARRITO_STATE']
let prev: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-status-'))
  process.env.BARRITO_HOME = tmp
  process.env.BARRITO_STATE = path.join(tmp, 'state')
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

const startServer = (handler: http.RequestListener): Promise<http.Server> => new Promise((done) => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => done(server))
})

const portOf = (server: http.Server): number => {
  const a = server.address()
  return typeof a === 'object' && a !== null ? a.port : 0
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

const rules = (over: Partial<ModelRules> = {}): ModelRules => ({
  include: [],
  exclude: [],
  require: [],
  max_input_price: null,
  pin: [],
  labels: {},
  suffix: {},
  agents: {},
  ...over,
})

type TestCtx = CommandCtx & { printed: string[]; codes: number[] }

const ctx = (port: number, over: Partial<Config> = {}): TestCtx => {
  const out = { printed: [] as string[], codes: [] as number[] }
  return {
    printed: out.printed,
    codes: out.codes,
    config: {
      port,
      default: 'personal',
      identities: { work: idn(), personal: idn() },
      models: rules(),
      graft: { roots: [], repos: [] },
      harness: {},
      ...over,
    },
    print: (s: string) => { out.printed.push(s) },
    exit: (c: number) => { out.codes.push(c) },
  }
}

const catchErr = async (fn: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')) }
  try {
    await fn()
  } finally {
    console.error = orig
  }
  return lines
}

const resetA = new Date(2026, 9, 1, 15, 10).getTime()
const resetB = new Date(2026, 9, 1, 14, 5).getTime()

const payload: StatusData = {
  pid: 7085,
  uptime: 259200,
  identities: {
    work: { tier: 'max', reason: null, model: null, resetAt: resetA, util5h: 0.62, util7d: 0.41, pin: null },
    personal: { tier: 'fallback', reason: 'quota', model: 'zai/glm-5.3', resetAt: resetB, util5h: 1, util7d: 0.88, pin: null },
  },
  spend: { work: 0, personal: 1.84 },
}

const statusServer = () => startServer((req, res) => {
  if (req.url !== '/status') {
    res.writeHead(404)
    return res.end('{}')
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
})

test('table matches the plan layout', () => {
  const lines = table({ identities: { work: idn(), personal: idn() } }, payload)
  assert.deepEqual(lines, [
    'IDENTITY   TIER          MAX 5H   MAX 7D   RESETS   API TODAY  TRANSFORMS',
    `work       max           62%      41%      ${hhmm(resetA)}    $0.00      —`,
    'personal   ! glm-5.3     100%     88%      14:05    $1.84      —',
  ])
})

test('table TRANSFORMS column: rtk · cave:<level>, parts off omitted, saved today', () => {
  const withTx: StatusData = {
    ...payload,
    rtk: true,
    transforms: {
      work: { state: { rtk: true, caveman: 'ultra' }, saved: 4096, compressed: 2 },
      personal: { state: { rtk: false, caveman: 'off' }, saved: 0, compressed: 0 },
    },
  }
  const lines = table({ identities: { work: idn(), personal: idn() } }, withTx)
  assert.equal(lines[1], `work       max           62%      41%      ${hhmm(resetA)}    $0.00      rtk · cave:ultra · 4.0kB saved`)
  assert.equal(lines[2], 'personal   ! glm-5.3     100%     88%      14:05    $1.84      —')
})

test('parse extracts transforms state and rtk availability', () => {
  const data = parse({
    pid: 1,
    uptime: 0,
    identities: {},
    spend: {},
    rtk: true,
    transforms: {
      work: { state: { rtk: true, caveman: 'ultra' }, saved: 100, compressed: 3 },
      ghost: { state: { rtk: false, caveman: 'nope' }, saved: 0, compressed: 0 },
    },
  })
  assert.equal(data?.rtk, true)
  assert.deepEqual(data?.transforms?.work, { state: { rtk: true, caveman: 'ultra' }, saved: 100, compressed: 3 })
  assert.deepEqual(data?.transforms?.ghost?.state, { rtk: false, caveman: 'off' })
})

test('status prints the table from a live /status server', async (t) => {
  const server = await statusServer()
  t.after(() => server.close())
  const c = ctx(portOf(server))
  await statusCmd([], c)
  assert.deepEqual(c.printed, [
    'IDENTITY   TIER          MAX 5H   MAX 7D   RESETS   API TODAY  TRANSFORMS',
    `work       max           62%      41%      ${hhmm(resetA)}    $0.00      —`,
    'personal   ! glm-5.3     100%     88%      14:05    $1.84      —',
  ])
  assert.deepEqual(c.codes, [])
})

test('status --json dumps the raw payload', async (t) => {
  const server = await statusServer()
  t.after(() => server.close())
  const c = ctx(portOf(server))
  await statusCmd(['--json'], c)
  assert.equal(JSON.parse(c.printed[0] ?? '').pid, 7085)
})

test('status with the router down exits 1 and points at doctor', async () => {
  const server = await startServer(() => {})
  const port = portOf(server)
  await new Promise((done) => server.close(done)) // freed port: nothing answers
  const c = ctx(port)
  const errs = await catchErr(() => statusCmd([], c))
  assert.match(errs.join('\n'), /router not running — barrito doctor/)
  assert.deepEqual(c.codes, [1])
})

test('markdown renders the GFM table plus a line per fallen-back identity', () => {
  assert.deepEqual(markdown({ identities: { work: idn(), personal: idn() } }, payload), [
    '| Identity | Tier | Max 5h | Max 7d | Resets | API today | Transforms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| work | max | 62% | 41% | ${hhmm(resetA)} | $0.00 | — |`,
    '| personal | glm-5.3 | 100% | 88% | 14:05 | $1.84 | — |',
    '! personal fell back to glm-5.3 (quota)',
  ])
})

test('markdown escapes pipes, backticks and newlines in ids, models and reasons', () => {
  const weird: StatusData = {
    pid: 1,
    uptime: 0,
    identities: {
      'bo|t`x': { tier: 'fallback', reason: 'quota', model: 'zai/glm|5`', resetAt: null, util5h: 0.5, util7d: 0.5, pin: null },
    },
    spend: {},
  }
  const lines = markdown({ identities: { 'bo|t`x': idn() } }, weird)
  assert.equal(lines[2], '| bo\\|t\\`x | glm\\|5\\` | 50% | 50% | — | $0.00 | — |')
  assert.equal(lines[3], '! bo\\|t\\`x fell back to glm\\|5\\` (quota)')
})

test('markdown with the router down prints a one-line note and exits 0', async () => {
  const server = await startServer(() => {})
  const port = portOf(server)
  await new Promise((done) => server.close(done)) // freed port: nothing answers
  const c = ctx(port)
  await statusCmd(['--markdown'], c)
  assert.deepEqual(c.printed, ['> barrito: router not running'])
  assert.deepEqual(c.codes, [])
})

test('status --markdown prints the table from a live /status server', async (t) => {
  const server = await statusServer()
  t.after(() => server.close())
  const c = ctx(portOf(server))
  await statusCmd(['--markdown'], c)
  assert.deepEqual(c.printed, [
    '| Identity | Tier | Max 5h | Max 7d | Resets | API today | Transforms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| work | max | 62% | 41% | ${hhmm(resetA)} | $0.00 | — |`,
    '| personal | glm-5.3 | 100% | 88% | 14:05 | $1.84 | — |',
    '! personal fell back to glm-5.3 (quota)',
  ])
})

const catalog = (models: CatalogModel[]) => {
  mkdirSync(process.env.BARRITO_STATE ?? '', { recursive: true })
  writeFileSync(
    path.join(process.env.BARRITO_STATE ?? '', 'catalog.json'),
    JSON.stringify({ fetchedAt: Date.now(), data: models }),
  )
}

const catModels: CatalogModel[] = [
  { id: 'zai/glm-5.3', name: 'GLM 5.3', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '0.0000006', output: '0.000002' } },
  { id: 'zai/glm-6.0', name: 'GLM 6', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '0.0000006', output: '0.000002' } },
]

test('status nudges on missing and new models', async (t) => {
  catalog(catModels)
  const server = await statusServer()
  t.after(() => server.close())
  const workDir = path.join(tmp, 'claude-work')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(path.join(workDir, 'settings.json'), JSON.stringify({
    modelPicker: { options: [{ model: 'claude-code/zai/glm-5.3', label: 'GLM 5.3', description: 'GLM 5.3' }] },
  }))
  const c = ctx(portOf(server), {
    identities: {
      work: idn({ id: 'work', claude_config_dir: workDir, fallback: ['zai/glm-5.3'] }),
      personal: idn({ id: 'personal', fallback: ['deepseek/gone'] }),
    },
    models: rules({ include: ['zai/*'] }),
  })
  await statusCmd([], c)
  assert.equal(c.printed.some((l) => l === '! 1 configured model missing from the gateway catalog → barrito doctor'), true)
  assert.equal(c.printed.some((l) => l === '! 1 new gateway models match your rules → barrito models sync'), true)
})

test('pin posts {identity, value} and confirms', async (t) => {
  const seen: string[] = []
  const server = await startServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`, body)
      res.end('{}')
    })
  })
  t.after(() => server.close())
  const c = ctx(portOf(server))
  await pin(['work', 'zai/glm-5.3'], c)
  assert.deepEqual(seen, ['POST /pin', JSON.stringify({ identity: 'work', value: 'zai/glm-5.3' })])
  assert.deepEqual(c.printed, ['pinned work → zai/glm-5.3'])
})

test('pin resolves a short model name via the identity fallback chain', async (t) => {
  catalog([
    { id: 'zai/glm-5.3', name: 'GLM 5.3', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '0.0000006', output: '0.000002' } },
    { id: 'openai/glm-5.3', name: 'GLM 5.3 (OpenAI)', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '1', output: '1' } },
  ])
  const seen: string[] = []
  const server = await startServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push(body); res.end('{}') })
  })
  t.after(() => server.close())
  const c = ctx(portOf(server), { identities: { work: idn({ id: 'work', fallback: ['zai/glm-5.3'] }) } })
  await pin(['work', 'GLM-5.3[1m]'], c)
  assert.deepEqual(seen, [JSON.stringify({ identity: 'work', value: 'zai/glm-5.3' })])
  assert.deepEqual(c.printed, ['pinned work → zai/glm-5.3'])
})

test('pin prefers picker rows when the fallback chain misses', async (t) => {
  catalog([
    { id: 'zai/glm-5.3', name: 'GLM 5.3', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '0.0000006', output: '0.000002' } },
    { id: 'openai/glm-5.3', name: 'GLM 5.3 (OpenAI)', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '1', output: '1' } },
  ])
  const workDir = path.join(tmp, 'claude-picker')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(path.join(workDir, 'settings.json'), JSON.stringify({
    modelPicker: { options: [{ model: 'claude-code/openai/glm-5.3', label: 'GLM 5.3', description: 'GLM 5.3' }] },
  }))
  const seen: string[] = []
  const server = await startServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push(body); res.end('{}') })
  })
  t.after(() => server.close())
  const c = ctx(portOf(server), {
    identities: { work: idn({ id: 'work', claude_config_dir: workDir, fallback: ['deepseek/deepseek-v4.1-flash'] }) },
  })
  await pin(['work', 'glm-5.3'], c)
  assert.deepEqual(seen, [JSON.stringify({ identity: 'work', value: 'openai/glm-5.3' })])
})

test('pin short name with several candidates lists them and exits 2', async () => {
  catalog([
    { id: 'zai/glm-5.3', name: 'GLM 5.3', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '0.0000006', output: '0.000002' } },
    { id: 'openai/glm-5.3', name: 'GLM 5.3 (OpenAI)', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '1', output: '1' } },
  ])
  const c = ctx(4141)
  const errs = await catchErr(() => pin(['work', 'glm-5.3'], c))
  assert.match(errs.join('\n'), /"glm-5\.3" is ambiguous: zai\/glm-5\.3, openai\/glm-5\.3 — use the full id/)
  assert.deepEqual(c.codes, [2])
})

test('pin short name with no match points at models search and exits 2', async () => {
  catalog([{ id: 'zai/glm-5.3', name: 'GLM 5.3', type: 'language', tags: ['tool-use'], context_window: 200000, pricing: { input: '0.0000006', output: '0.000002' } }])
  const c = ctx(4141)
  const errs = await catchErr(() => pin(['work', 'glm-9.9'], c))
  assert.match(errs.join('\n'), /unknown model "glm-9\.9" — try barrito models search glm-9\.9/)
  assert.deepEqual(c.codes, [2])
})

test('the slash command passes the model through for the CLI to resolve', () => {
  const md = readFileSync(path.join(root(), 'templates', 'barrito-command.md'), 'utf8')
  assert.ok(md.includes('barrito pin "$BARRITO_IDENTITY" <model>'), 'pin path calls the CLI with the model as given')
  assert.ok(md.includes('short names'), 'the template tells Claude short names resolve inside the CLI')
})

test('pin normalizes claude-code/ prefixes and [1m]', async (t) => {
  const seen: string[] = []
  const server = await startServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push(body); res.end('{}') })
  })
  t.after(() => server.close())
  const c = ctx(portOf(server))
  await pin(['work', 'claude-code/zai/glm-5.3[1m]'], c)
  assert.deepEqual(seen, [JSON.stringify({ identity: 'work', value: 'zai/glm-5.3' })])
})

test('pin max passes through', async (t) => {
  const seen: string[] = []
  const server = await startServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push(body); res.end('{}') })
  })
  t.after(() => server.close())
  const c = ctx(portOf(server))
  await pin(['work', 'max'], c)
  assert.deepEqual(seen, [JSON.stringify({ identity: 'work', value: 'max' })])
  assert.deepEqual(c.printed, ['pinned work → max'])
})

test('pin warns (without blocking) on unknown catalog ids', async (t) => {
  catalog([{ id: 'zai/glm-5.3', name: 'GLM 5.3', type: 'language', tags: ['tool-use'], context_window: 1, pricing: { input: '1', output: '1' } }])
  const seen: string[] = []
  const server = await startServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push(body); res.end('{}') })
  })
  t.after(() => server.close())
  const c = ctx(portOf(server))
  const errs = await catchErr(() => pin(['work', 'zai/glm-9.9'], c))
  assert.match(errs.join('\n'), /not in the cached gateway catalog — pinning anyway/)
  assert.deepEqual(seen, [JSON.stringify({ identity: 'work', value: 'zai/glm-9.9' })])
  assert.deepEqual(c.printed, ['pinned work → zai/glm-9.9'])
})

test('pin rejects unknown identities without calling the router', async () => {
  const c = ctx(4141)
  const errs = await catchErr(() => pin(['nope', 'max'], c))
  assert.match(errs.join('\n'), /unknown identity "nope"/)
  assert.deepEqual(c.codes, [2])
})

test('pin with a down router exits 1', async () => {
  const server = await startServer(() => {})
  const port = portOf(server)
  await new Promise((done) => server.close(done))
  const c = ctx(port)
  const errs = await catchErr(() => pin(['work', 'max'], c))
  assert.match(errs.join('\n'), /router not running — barrito doctor/)
  assert.deepEqual(c.codes, [1])
})

test('pin surfaces a router error status', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(500)
    res.end('{}')
  })
  t.after(() => server.close())
  const c = ctx(portOf(server))
  const errs = await catchErr(() => pin(['work', 'max'], c))
  assert.match(errs.join('\n'), /rejected the pin \(500\)/)
  assert.deepEqual(c.codes, [1])
})

test('unpin posts {identity, value: null}', async (t) => {
  const seen: string[] = []
  const server = await startServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push(body); res.end('{}') })
  })
  t.after(() => server.close())
  const c = ctx(portOf(server))
  await unpin(['work'], c)
  assert.deepEqual(seen, [JSON.stringify({ identity: 'work', value: null })])
  assert.deepEqual(c.printed, ['unpinned work'])
})

test('unpin validates the identity', async () => {
  const c = ctx(4141)
  const errs = await catchErr(() => unpin(['nope'], c))
  assert.match(errs.join('\n'), /unknown identity "nope"/)
  assert.deepEqual(c.codes, [2])
})

test('unpin with no args prints usage and exits 2', async () => {
  const c = ctx(4141)
  const errs = await catchErr(() => unpin([], c))
  assert.match(errs.join('\n'), /usage: barrito unpin/)
  assert.deepEqual(c.codes, [2])
})

test('table columns grow for long cells so rows stay aligned; paint colors tiers after padding', () => {
  const long = 'a-very-long-identity'
  const lines = table({ identities: { [long]: idn(), personal: idn() } }, payload)
  const col = (l: string): number => l.indexOf('MAX 5H') >= 0 ? l.indexOf('MAX 5H') : l.search(/\d+%|—/)
  assert.equal(new Set(lines.map(col)).size, 1, lines.join('\n'))
  const tag = (v: string | number | null | undefined): string => {
    const s = String(v)
    return `<${s.trim()}>${' '.repeat(s.length - s.trimEnd().length)}`
  }
  const painted = table({ identities: { work: idn(), personal: idn() } }, payload, { dim: tag, green: tag, yellow: tag })
  assert.match(painted[0] ?? '', /^<IDENTITY> {3}<TIER>/)
  assert.match(painted[1] ?? '', /^work {7}<max>/)
  assert.match(painted[2] ?? '', /^personal {3}<! glm-5\.3>/)
})

test('throttles: per-identity note for unconfirmed 429s passed to Claude Code today', () => {
  const data = parse({
    pid: 1, uptime: 1, spend: {},
    identities: { work: { tier: 'max', throttled429Today: 12 }, personal: { tier: 'max', throttled429Today: 1 }, ci: { tier: 'max', throttled429Today: 0 } },
  })
  assert.deepEqual(throttles({ identities: { work: idn(), personal: idn(), ci: idn() } }, data), [
    'work: 12 throttled 429s passed to Claude Code today',
    'personal: 1 throttled 429 passed to Claude Code today',
  ])
  assert.deepEqual(throttles({ identities: { work: idn() } }, parse({ identities: { work: { tier: 'max' } } })), [])
})

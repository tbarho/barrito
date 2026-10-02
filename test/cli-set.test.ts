import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import set from '../src/cli/set.ts'
import type { CommandCtx, Config, FetchJson, Identity, ModelRules } from '../src/types.ts'

const keys = ['BARRITO_HOME', 'BARRITO_STATE']
let prev: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-set-'))
  process.env.BARRITO_HOME = tmp
  process.env.BARRITO_STATE = path.join(tmp, 'state')
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

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

const ctx = (port: number): TestCtx => {
  const out = { printed: [] as string[], codes: [] as number[] }
  return {
    printed: out.printed,
    codes: out.codes,
    config: {
      port,
      default: 'work',
      identities: { work: idn() },
      models: rules(),
      graft: { roots: [], repos: [] },
      harness: {},
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

// records POST /transforms bodies, answers with the given state
const txServer = (state: unknown = { rtk: true, caveman: 'ultra' }) => {
  const seen: string[] = []
  const server = startServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`, body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, state }))
    })
  })
  return { server, seen }
}

test('set posts {identity, rtk, caveman} and renders the resulting state', async (t) => {
  const { server, seen } = txServer()
  const s = await server
  t.after(() => s.close())
  const c = ctx(portOf(s))
  await set(['work', 'rtk', 'on', 'caveman', 'ultra'], c)
  assert.deepEqual(seen, [
    'POST /transforms',
    JSON.stringify({ identity: 'work', rtk: true, caveman: 'ultra', reset: undefined }),
  ])
  assert.deepEqual(c.printed, ['work → rtk on · caveman ultra'])
  assert.deepEqual(c.codes, [])
})

test('set --reset posts reset: true alone', async (t) => {
  const { server, seen } = txServer({ rtk: true, caveman: 'lite' })
  const s = await server
  t.after(() => s.close())
  const c = ctx(portOf(s))
  await set(['work', '--reset'], c)
  assert.deepEqual(seen, ['POST /transforms', JSON.stringify({ identity: 'work', rtk: undefined, caveman: undefined, reset: true })])
  assert.deepEqual(c.printed, ['work → rtk on · caveman lite'])
})

test('set rtk off alone only sends rtk', async (t) => {
  const { server, seen } = txServer({ rtk: false, caveman: 'lite' })
  const s = await server
  t.after(() => s.close())
  const c = ctx(portOf(s))
  await set(['work', 'rtk', 'off'], c)
  assert.deepEqual(seen, ['POST /transforms', JSON.stringify({ identity: 'work', rtk: false, caveman: undefined, reset: undefined })])
  assert.deepEqual(c.printed, ['work → rtk off · caveman lite'])
})

test('set validates values before calling the router', async () => {
  for (const args of [['work', 'rtk', 'maybe'], ['work', 'caveman', 'loud'], ['work', 'wat'], []]) {
    const c = ctx(4141)
    const errs = await catchErr(() => set(args, c))
    assert.match(errs.join('\n'), /usage: barrito set/, JSON.stringify(args))
    assert.deepEqual(c.codes, [2])
  }
})

test('set rejects unknown identities without calling the router', async () => {
  const c = ctx(4141)
  const errs = await catchErr(() => set(['nope', 'rtk', 'on'], c))
  assert.match(errs.join('\n'), /unknown identity "nope"/)
  assert.deepEqual(c.codes, [2])
})

test('set with a down router exits 1', async () => {
  const server = await startServer(() => {})
  const port = portOf(server)
  await new Promise((done) => server.close(done))
  const c = ctx(port)
  const errs = await catchErr(() => set(['work', 'rtk', 'on'], c))
  assert.match(errs.join('\n'), /router not running — barrito doctor/)
  assert.deepEqual(c.codes, [1])
})

test('set surfaces a router rejection', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'barrito: caveman must be off|lite|full|ultra, got "loud"' } }))
  })
  t.after(() => server.close())
  const c = ctx(portOf(server))
  // CLI-valid args — the router (not the CLI) is what rejects here
  const errs = await catchErr(() => set(['work', 'rtk', 'on'], c))
  assert.match(errs.join('\n'), /rejected the set \(400\)/)
  assert.deepEqual(c.codes, [1])
})

test('set without a state in the router answer exits 1', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  t.after(() => server.close())
  const c = ctx(portOf(server))
  const errs = await catchErr(() => set(['work', 'rtk', 'on'], c))
  assert.match(errs.join('\n'), /did not answer with a transform state/)
  assert.deepEqual(c.codes, [1])
})

test('the slash command template routes rtk/caveman through the CLI', async () => {
  const { root } = await import('../src/paths.ts')
  const { readFileSync } = await import('node:fs')
  const md = readFileSync(path.join(root(), 'templates', 'barrito-command.md'), 'utf8')
  assert.ok(md.includes('barrito set "$BARRITO_IDENTITY" rtk <on|off>'), 'rtk path calls the set CLI with the identity')
  assert.ok(md.includes('barrito set "$BARRITO_IDENTITY" caveman <level>'), 'caveman path calls the set CLI with the identity')
})

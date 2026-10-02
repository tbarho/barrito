import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import stop from '../src/cli/stop.ts'
import type { StopOpts } from '../src/cli/stop.ts'
import { stopDetached } from '../src/cli/serve.ts'
import type { CommandCtx, Config, Exec, FetchJson } from '../src/types.ts'

const keys = ['BARRITO_HOME', 'BARRITO_STATE', 'BARRITO_PLATFORM']
let prev: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]] as const))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-stop-'))
  process.env.BARRITO_HOME = tmp
  process.env.BARRITO_STATE = path.join(tmp, 'state')
  delete process.env.BARRITO_PLATFORM
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

// stop never reads ctx.config, but CommandCtx requires one
const cfg = (): Config => ({
  port: 4141,
  default: 'personal',
  identities: {},
  models: { include: [], exclude: [], require: [], max_input_price: null, pin: [], labels: {}, agents: {} },
  graft: { roots: [], repos: [] },
  harness: {},
})

type TestCtx = CommandCtx & { printed: string[]; codes: number[] }

const ctx = (): TestCtx => {
  const out = { printed: [] as string[], codes: [] as number[] }
  return {
    printed: out.printed,
    codes: out.codes,
    config: cfg(),
    print: (s: string) => { out.printed.push(s) },
    exit: (x: number) => { out.codes.push(x) },
  }
}

// every run checks the service manager first, so every test needs an injected exec
const noService: Exec = () => '' // launchctl print of an unloaded service / systemctl show inactive

const run = async (over: StopOpts = {}, c: TestCtx = ctx()): Promise<TestCtx> => {
  await stop([], c, { exec: noService, ...over })
  return c
}

test('stop: detached router was stopped', async () => {
  const c = await run({ stop: async () => true })
  assert.deepEqual(c.printed, ['barrito stopped'])
  assert.deepEqual(c.codes, [0])
})

test('stop: nothing running and no service → says so, exit 0', async () => {
  const c = await run({ stop: async () => false })
  assert.deepEqual(c.printed, ['no barrito router is running'])
  assert.deepEqual(c.codes, [0])
})

test('stop: launchd service running → points at uninstall/launchctl, never signals the service child', async () => {
  const exec: Exec = () => '  pid = 7085\n  state = running\n'
  let called = false
  const c = await run({ stop: async () => { called = true; return true }, exec })
  assert.equal(called, false) // service check comes first — stopDetached is never reached
  assert.match(c.printed[0] ?? '', /barrito runs as a system service/)
  assert.match(c.printed[0] ?? '', /`barrito uninstall`/)
  assert.match(c.printed[0] ?? '', /launchctl bootout/)
  assert.deepEqual(c.codes, [1])
})

test('stop: systemd service running → points at systemctl, exit 1', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const exec: Exec = () => 'ActiveState=active\nMainPID=9\n'
  const c = await run({ exec })
  assert.match(c.printed[0] ?? '', /systemctl --user stop barrito/)
  assert.deepEqual(c.codes, [1])
})

test('stop: status lookup that throws counts as not running', async () => {
  const exec: Exec = () => { throw new Error('launchctl not found') }
  const c = await run({ stop: async () => false, exec })
  assert.deepEqual(c.printed, ['no barrito router is running'])
  assert.deepEqual(c.codes, [0])
})

test('stop falls back to the real stopDetached (no pidfile here), fetch injected', async () => {
  const c = await run()
  assert.deepEqual(c.printed, ['no barrito router is running'])
  assert.deepEqual(c.codes, [0])
})

test('stop: unverified pidfile (nothing answers) is dropped without signaling', async () => {
  mkdirSync(process.env.BARRITO_STATE ?? '', { recursive: true })
  const file = path.join(process.env.BARRITO_STATE ?? '', 'barrito.pid')
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, port: 1, startedAt: Date.now(), token: 't' })}\n`)
  // port 1 never answers → unverified → stale; the default path must not signal our own pid
  const c = await run()
  assert.deepEqual(c.printed, ['no barrito router is running'])
  assert.deepEqual(c.codes, [0])
  assert.equal(existsSync(file), false)
})

test('stopDetached is re-exported from serve and the default path finds no pidfile', async () => {
  const dead: FetchJson = async () => ({ ok: false, json: async () => ({}) })
  assert.equal(typeof stopDetached, 'function')
  assert.equal(await stopDetached({ statePath: process.env.BARRITO_STATE, fetch: dead }), false)
})

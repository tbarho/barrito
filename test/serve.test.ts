import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import serve from '../src/cli/serve.ts'
import type { ServeOpts, ServerLike, StartArgs } from '../src/cli/serve.ts'
import { startDetached, stopDetached, transformDefaults } from '../src/cli/serve.ts'
import * as catalog from '../src/catalog.ts'
import type { CommandCtx, Config, FetchJson, Identity, Spawn, Transforms } from '../src/types.ts'

const keys = ['BARRITO_HOME', 'BARRITO_STATE', 'BARRITO_LOG', 'BARRITO_PORT']
let prev: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-serve-'))
  process.env.BARRITO_HOME = tmp
  process.env.BARRITO_STATE = path.join(tmp, 'state')
  process.env.BARRITO_LOG = path.join(tmp, 'barrito.log')
  delete process.env.BARRITO_PORT
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

const config = (): Config => ({
  port: 4142,
  default: 'personal',
  identities: {
    work: {
      id: 'work',
      claude_config_dir: path.join(tmp, 'claude'),
      share_from: null,
      fallback: ['zai/glm-5.3'],
      match: { remotes: [], paths: [] },
      keychain: { gateway: 'Vercel AI Gateway Work' },
    } satisfies Identity,
  },
  models: { include: [], exclude: [], require: [], max_input_price: null, pin: [], labels: {}, suffix: {}, agents: {} },
  graft: { roots: [], repos: [] },
  harness: {},
})

const fakeServer = (): ServerLike & { listens: Array<{ port: number; host: string }>; closed: number; idle: number } => {
  const s: ServerLike & { listens: Array<{ port: number; host: string }>; closed: number; idle: number } = {
    listens: [],
    closed: 0,
    idle: 0,
    listen: (port, host, cb) => { s.listens.push({ port, host }); cb?.() },
    close: (cb) => { s.closed++; cb?.() },
    closeIdleConnections: () => { s.idle++ },
  }
  return s
}

type TestCtx = CommandCtx & { printed: string[]; codes: number[] }

const run = async (args: string[] = [], over: Partial<ServeOpts> = {}, cfg: Config = config()) => {
  const out = { printed: [] as string[], codes: [] as number[] }
  const sig: Record<string, () => void> = {}
  const server = fakeServer()
  const state: { started: StartArgs | null } = { started: null }
  const opts: ServeOpts = {
    start: async (args2) => { state.started = args2; return server },
    keychain: { get: (s: string) => (s === 'Vercel AI Gateway Work' ? 'key-material' : null) },
    refresh: async () => {},
    on: (s2, fn) => { sig[s2] = fn },
    exit: (x) => { out.codes.push(x) },
    ...over,
  }
  const c: TestCtx = {
    printed: out.printed,
    codes: out.codes,
    config: cfg,
    print: (s: string) => { out.printed.push(s) },
    exit: (x: number) => { out.codes.push(x) },
  }
  await serve(args, c, opts)
  return { c, sig, server, started: state.started, opts }
}

test('serve wires tiers, spend, keychain, log and defaults to start()', async () => {
  const { started, server } = await run()
  assert.equal(started?.config.port, 4142)
  assert.equal(started?.port, 4142)
  assert.equal(started?.keychain.get('Vercel AI Gateway Work'), 'key-material')
  assert.deepEqual(started?.upstreams, {
    direct: 'https://api.anthropic.com',
    gateway: 'https://ai-gateway.vercel.sh',
  })
  assert.equal(typeof started?.log, 'function')
  assert.equal(typeof started?.tiers.route, 'function')
  assert.equal(typeof started?.tiers.pin, 'function')
  assert.equal(typeof started?.tiers.observe, 'function')
  assert.equal(typeof started?.tiers.snapshot, 'function')
  assert.equal(typeof started?.spend.record, 'function')
  assert.equal(typeof started?.spend.today, 'function')

  // tiers is live against the config, log writes to the injected log path
  assert.deepEqual(started?.tiers.route('work', 'claude-opus-5'), { to: 'direct' })
  started?.log('hello serve')
  assert.equal(readFileSync(process.env.BARRITO_LOG ?? '', 'utf8'), 'hello serve\n')

  assert.deepEqual(server.listens, [{ port: 4142, host: '127.0.0.1' }])
})

test('serve wires transforms to start() — injectable for tests', async () => {
  const tx: Transforms = {
    state: () => ({ rtk: true, caveman: 'lite' }),
    set: () => ({ rtk: true, caveman: 'lite' }),
    anthropic: (_id, body) => ({ body, applied: { rtk: 0, caveman: 'off', saved: 0 } }),
    openai: (_id, body) => ({ body, applied: { rtk: 0, caveman: 'off', saved: 0 } }),
    available: () => true,
    stats: () => ({}),
  }
  const { started } = await run([], { transforms: tx })
  assert.equal(started?.transforms, tx)
})

test('transformDefaults resolves [transforms] globals with per-identity overrides', () => {
  const cfg = config()
  cfg.transforms = { rtk: false, caveman: 'ultra' }
  cfg.identities.work!.transforms = { rtk: true }
  const defaults = transformDefaults(cfg)
  assert.deepEqual(defaults('work'), { rtk: true, caveman: 'ultra' })
  assert.deepEqual(defaults('ghost'), { rtk: false, caveman: 'ultra' })

  const bare = config() // config without [transforms] → the built-in defaults
  assert.deepEqual(transformDefaults(bare)('work'), { rtk: true, caveman: 'lite' })
})

test('serve prints the listening line', async () => {
  const { c } = await run()
  assert.deepEqual(c.printed, ['barrito listening on http://127.0.0.1:4142'])
})

test('BARRITO_PORT overrides config.port', async () => {
  process.env.BARRITO_PORT = '4599'
  const { started, c } = await run()
  assert.equal(started?.port, 4599)
  assert.deepEqual(c.printed, ['barrito listening on http://127.0.0.1:4599'])
})

test('SIGTERM and SIGINT close the server and exit 0', async () => {
  const { sig, server, c } = await run()
  sig.SIGTERM?.()
  assert.equal(server.closed, 1)
  assert.equal(server.idle, 1)
  assert.deepEqual(c.codes, [0])
  sig.SIGINT?.()
  assert.equal(server.closed, 1) // second signal is a no-op
  assert.deepEqual(c.codes, [0])
})

test('default catalog refresh uses the first identity gateway key and never crashes', async () => {
  const fetchCalls: Array<{ url: string; headers: Record<string, string> | undefined }> = []
  const { started } = await run([], {
    refresh: undefined,
    fetch: async (url, init) => {
      fetchCalls.push({ url, headers: init?.headers })
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'zai/glm-5.3', name: 'GLM 5.3', type: 'language', tags: [], context_window: 200000, pricing: { input: '0.0000006', output: '0.000002' } }] }),
      }
    },
  })
  assert.equal(typeof started, 'object')
  // daily() kicked off with the keychain key; wait for catalog.json to land
  const file = path.join(process.env.BARRITO_STATE ?? '', 'catalog.json')
  for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((done) => setTimeout(done, 10))
  assert.equal(existsSync(file), true)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0]?.headers?.authorization, 'Bearer key-material')
  assert.equal(fetchCalls[0]?.url, 'https://ai-gateway.vercel.sh/v1/models')
  const cached = catalog.cached({ statePath: process.env.BARRITO_STATE ?? '' })
  assert.equal(cached?.[0]?.id, 'zai/glm-5.3')
})

test('refresh failures never surface', async () => {
  const { c } = await run([], {
    refresh: async () => { throw new Error('boom') },
  })
  assert.deepEqual(c.printed, ['barrito listening on http://127.0.0.1:4142'])
  await new Promise((done) => setTimeout(done, 20))
  assert.deepEqual(c.codes, [])
})

// ── serve --detach ────────────────────────────────────────────────────────────

const pidAt = (): string => path.join(process.env.BARRITO_STATE ?? '', 'barrito.pid')
const writePid = (data: unknown): void => {
  mkdirSync(path.dirname(pidAt()), { recursive: true })
  writeFileSync(pidAt(), `${JSON.stringify(data)}\n`)
}
const pidJson = (): unknown => JSON.parse(readFileSync(pidAt(), 'utf8'))

const fakeSpawn = (pid: number, exitCode: number | null = null) => {
  const spawned: Array<{ cmd: string[]; opts: { detached?: boolean; stdio?: unknown; env?: Record<string, string | undefined> } }> = []
  const spawn: Spawn = (cmd, opts) => {
    spawned.push({ cmd, opts: opts ?? {} })
    return { pid, exitCode, unref: () => {} }
  }
  return { spawn, spawned }
}

// /status answers with this router pid
const statusFetch = (pid: number, urls?: string[]): FetchJson => async (url) => {
  urls?.push(url)
  return { ok: true, json: async () => ({ pid }) }
}

// the wait() injection doubles as "the child just wrote its pidfile"
const childWritesPid = (pid: number, port: number) => {
  let wrote = false
  return async (): Promise<void> => {
    if (wrote) return
    wrote = true
    writePid({ pid, port, startedAt: Date.now(), token: 't' })
  }
}

test('serve --detach spawns detached, waits for the child pidfile + /status pid match', async () => {
  const f = fakeSpawn(4321)
  const urls: string[] = []
  const { c } = await run(['--detach'], {
    spawn: f.spawn,
    fetch: statusFetch(4321, urls),
    node: '/opt/node/bin/node',
    bin: '/usr/local/bin/barrito',
    wait: childWritesPid(4321, 4142),
  })
  assert.equal(f.spawned.length, 1)
  assert.deepEqual(f.spawned[0]?.cmd, ['/opt/node/bin/node', '/usr/local/bin/barrito', 'serve'])
  assert.equal(f.spawned[0]?.opts.detached, true)
  assert.equal((f.spawned[0]?.opts.stdio as unknown[])[0], 'ignore')
  assert.equal(f.spawned[0]?.opts.env?.BARRITO_PORT, '4142')
  assert.deepEqual(urls, ['http://127.0.0.1:4142/status']) // one poll, matched
  const pid = pidJson() as { pid: number; port: number; startedAt: number; token: string }
  assert.equal(pid.pid, 4321)
  assert.equal(pid.port, 4142)
  assert.equal(typeof pid.startedAt, 'number')
  assert.equal(existsSync(process.env.BARRITO_LOG ?? ''), true) // stdio append fd created it
  assert.deepEqual(c.printed, ['barrito listening on http://127.0.0.1:4142 (pid 4321)'])
  assert.deepEqual(c.codes, [0])
})

test('serve --detach merges env additions into the child env (for ci)', async () => {
  const f = fakeSpawn(4321)
  await run(['--detach'], {
    spawn: f.spawn,
    fetch: statusFetch(4321),
    env: { BARRITO_CONFIG: '/tmp/ci-config.toml', BARRITO_STATE: '/tmp/ci-state' },
    wait: childWritesPid(4321, 4142),
  })
  assert.equal(f.spawned[0]?.opts.env?.BARRITO_CONFIG, '/tmp/ci-config.toml')
  assert.equal(f.spawned[0]?.opts.env?.BARRITO_STATE, '/tmp/ci-state')
  assert.equal(f.spawned[0]?.opts.env?.BARRITO_PORT, '4142') // port still wins
})

test('serve --detach: live verified router → already running, no spawn', async () => {
  writePid({ pid: 999, port: 4142, startedAt: 1, token: 't' })
  const f = fakeSpawn(4321)
  const urls: string[] = []
  const { c } = await run(['--detach'], {
    spawn: f.spawn,
    fetch: statusFetch(999, urls),
    alive: () => true,
  })
  assert.equal(f.spawned.length, 0)
  assert.deepEqual(urls, ['http://127.0.0.1:4142/status'])
  assert.deepEqual(c.printed, ['barrito already running on http://127.0.0.1:4142 (pid 999)'])
  assert.deepEqual(c.codes, [0])
})

test('serve --detach: pidfile pointing at an unrelated live process is stale, never signaled, fresh start', async () => {
  writePid({ pid: 999, port: 4142, startedAt: 1, token: 't' })
  const f = fakeSpawn(4321)
  const urls: string[] = []
  // first /status poll (verifying pid 999) answers with a foreign pid; from then on our child answers
  const flip: FetchJson = async (url) => {
    urls.push(url)
    return { ok: true, json: async () => ({ pid: urls.length === 1 ? 1234 : 4321 }) }
  }
  const { c } = await run(['--detach'], {
    spawn: f.spawn,
    fetch: flip,
    alive: () => true,
    wait: childWritesPid(4321, 4142),
  })
  assert.equal(f.spawned.length, 1) // old entry discarded, no error, no kill
  assert.equal(urls.length, 2) // verification failed once, then the fresh child verified
  assert.equal((pidJson() as { pid: number }).pid, 4321)
  assert.deepEqual(c.printed, ['barrito listening on http://127.0.0.1:4142 (pid 4321)'])
  assert.deepEqual(c.codes, [0])
})

test('serve --detach: invalid pidfile (pid 0) is discarded, never a kill target', async () => {
  writePid({ pid: 0, port: 4142, startedAt: 1 })
  const f = fakeSpawn(4321)
  const { c } = await run(['--detach'], {
    spawn: f.spawn,
    fetch: statusFetch(4321),
    alive: () => true, // pid 0 would "verify" against anything if accepted
    wait: childWritesPid(4321, 4142),
  })
  assert.equal(f.spawned.length, 1)
  assert.equal((pidJson() as { pid: number }).pid, 4321)
  assert.deepEqual(c.codes, [0])
})

test('serve --detach: child exits early (EADDRINUSE etc.) → fail fast with the log tail', async () => {
  writeFileSync(process.env.BARRITO_LOG ?? '', 'EADDRINUSE boom\n')
  const f = fakeSpawn(77, 1)
  const { c } = await run(['--detach'], {
    spawn: f.spawn,
    fetch: statusFetch(77),
    wait: async () => {},
  })
  assert.equal(f.spawned.length, 1)
  assert.match(c.printed[0] ?? '', /router exited early with code 1/)
  assert.ok(c.printed.includes('EADDRINUSE boom'))
  assert.deepEqual(c.codes, [1])
})

test('serve --detach: router never answers → exit 1 with the log tail', async () => {
  writeFileSync(process.env.BARRITO_LOG ?? '', 'boom one\nboom two\n')
  let tries = 0
  const { c } = await run(['--detach'], {
    spawn: fakeSpawn(55).spawn,
    fetch: async () => { tries++; return { ok: false, json: async () => ({}) } },
    wait: childWritesPid(55, 4142), // pidfile lands, but /status never confirms it
    tries: 3,
  })
  assert.equal(tries, 2) // 3 poll rounds: the first predates the child pidfile
  assert.match(c.printed[0] ?? '', /did not answer \/status within 5s/)
  assert.ok(c.printed.includes('boom two'))
  assert.deepEqual(c.codes, [1])
})

// ── foreground serve owns the pidfile ─────────────────────────────────────────

test('serve writes the router-owned pidfile on listening and removes it on stop', async () => {
  const { sig } = await run()
  const pid = pidJson() as { pid: number; port: number; startedAt: number; token: string }
  assert.equal(pid.pid, process.pid)
  assert.equal(pid.port, 4142)
  assert.equal(typeof pid.startedAt, 'number')
  assert.equal(typeof pid.token, 'string')
  assert.ok(pid.token.length > 0)
  sig.SIGTERM?.()
  assert.equal(existsSync(pidAt()), false)
})

// ── startDetached / stopDetached (exported for `barrito ci`) ──────────────────

test('startDetached returns the existing pid/port untouched', async () => {
  writePid({ pid: 999, port: 4242, startedAt: 1, token: 't' })
  const f = fakeSpawn(1)
  const r = await startDetached({
    config: config(),
    statePath: process.env.BARRITO_STATE,
    spawn: f.spawn,
    fetch: statusFetch(999),
    alive: () => true,
  })
  assert.deepEqual(r, { pid: 999, port: 4242, existing: true })
  assert.equal(f.spawned.length, 0)
})

test('stopDetached: verified router gets SIGTERM, pidfile removed, true', async () => {
  writePid({ pid: 555, port: 4142, startedAt: 1, token: 't' })
  const live = new Set([555])
  const kills: Array<[number, string | number | undefined]> = []
  const stopped = await stopDetached({
    statePath: process.env.BARRITO_STATE,
    fetch: statusFetch(555),
    kill: (pid, sig) => { kills.push([pid, sig]); live.delete(pid) },
    alive: (pid) => live.has(pid),
    wait: async () => {},
  })
  assert.equal(stopped, true)
  assert.deepEqual(kills, [[555, 'SIGTERM']])
  assert.equal(existsSync(pidAt()), false)
})

test('stopDetached: unrelated live process answering /status with a different pid is never signaled', async () => {
  writePid({ pid: 555, port: 4142, startedAt: 1, token: 't' })
  const kills: Array<[number, string | number | undefined]> = []
  const stopped = await stopDetached({
    statePath: process.env.BARRITO_STATE,
    fetch: statusFetch(1234), // some other process owns that pid now
    kill: (pid, sig) => kills.push([pid, sig]),
    alive: () => true,
    wait: async () => {},
  })
  assert.equal(stopped, false)
  assert.deepEqual(kills, [])
  assert.equal(existsSync(pidAt()), false) // pidfile cleaned, nothing killed
})

test('stopDetached: nothing answering → stale, no signal', async () => {
  writePid({ pid: 555, port: 4142, startedAt: 1, token: 't' })
  const kills: Array<[number, string | number | undefined]> = []
  const stopped = await stopDetached({
    statePath: process.env.BARRITO_STATE,
    fetch: async () => { throw new Error('ECONNREFUSED') },
    kill: (pid, sig) => kills.push([pid, sig]),
    alive: () => true,
    wait: async () => {},
  })
  assert.equal(stopped, false)
  assert.deepEqual(kills, [])
  assert.equal(existsSync(pidAt()), false)
})

test('stopDetached: SIGKILL after 3s of ignoring SIGTERM', async () => {
  writePid({ pid: 556, port: 4142, startedAt: 1, token: 't' })
  const kills: Array<[number, string | number | undefined]> = []
  const stopped = await stopDetached({
    statePath: process.env.BARRITO_STATE,
    fetch: statusFetch(556),
    kill: (pid, sig) => kills.push([pid, sig]),
    alive: () => true,
    wait: async () => {},
  })
  assert.equal(stopped, true)
  assert.deepEqual(kills, [[556, 'SIGTERM'], [556, 'SIGKILL']])
  assert.equal(existsSync(pidAt()), false)
})

test('stopDetached: stale pidfile (dead pid) → false, cleaned up, no signal', async () => {
  writePid({ pid: 557, port: 4142, startedAt: 1, token: 't' })
  const kills: Array<[number, string | number | undefined]> = []
  const stopped = await stopDetached({
    statePath: process.env.BARRITO_STATE,
    kill: (pid, sig) => kills.push([pid, sig]),
    alive: () => false,
    wait: async () => {},
  })
  assert.equal(stopped, false)
  assert.deepEqual(kills, [])
  assert.equal(existsSync(pidAt()), false)
})

test('stopDetached: invalid pidfile (pid 0 / -1 / non-integer) is removed, never a target', async () => {
  for (const pid of [0, -1, 1.5]) {
    writePid({ pid, port: 4142, startedAt: 1 })
    const kills: Array<[number, string | number | undefined]> = []
    const stopped = await stopDetached({
      statePath: process.env.BARRITO_STATE,
      kill: (p, sig) => kills.push([p, sig]),
      alive: () => true,
      wait: async () => {},
    })
    assert.equal(stopped, false)
    assert.deepEqual(kills, [])
    assert.equal(existsSync(pidAt()), false)
  }
})

test('stopDetached: no pidfile → false', async () => {
  assert.equal(await stopDetached({ statePath: process.env.BARRITO_STATE, fetch: statusFetch(1) }), false)
})

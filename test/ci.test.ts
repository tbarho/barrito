import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { default as ci, flags, build, envLines } from '../src/cli/ci.ts'
import { load as loadConfig } from '../src/config.ts'
import { account } from '../src/claude.ts'
import type { CommandCtx, Config } from '../src/types.ts'

const keys = ['BARRITO_HOME']
let prev: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-ci-'))
  process.env.BARRITO_HOME = tmp
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

// ci never reads ctx.config (it builds its own), but CommandCtx requires one
const cfg = (): Config => ({
  port: 4141,
  default: 'ci',
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
    exit: (c: number) => { out.codes.push(c); throw new Error(`exit ${c}`) },
  }
}

const ghaEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  GITHUB_ACTIONS: 'true',
  RUNNER_TEMP: path.join(tmp, 'runner'),
  GITHUB_PATH: path.join(tmp, 'github-path'),
  GITHUB_ENV: path.join(tmp, 'github-env'),
  GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'),
  ...over,
})

test('flags: defaults', () => {
  const f = flags([])
  assert.deepEqual(f, { identity: 'ci', gatewayKey: 'env:AI_GATEWAY_API_KEY', fallback: [], port: null, config: null, stop: false })
})

test('flags: identity, gateway-key, repeatable + comma fallback, port, stop', () => {
  const f = flags([
    '--identity', 'bots', '--gateway-key', 'file:/run/secrets/gw',
    '--fallback', 'zai/glm-5.3', '--fallback', ' a/b , c/d ', '--port', '5123', 'stop',
  ])
  assert.equal(f.identity, 'bots')
  assert.equal(f.gatewayKey, 'file:/run/secrets/gw')
  assert.deepEqual(f.fallback, ['zai/glm-5.3', 'a/b', 'c/d'])
  assert.equal(f.port, 5123)
  assert.equal(f.stop, true)
})

test('flags: rejects a bad port and unknown positionals', () => {
  assert.throws(() => flags(['--port', 'nope']), /--port must be an integer/)
  assert.throws(() => flags(['--port', '99999']), /--port must be an integer/)
  assert.throws(() => flags(['bogus']), /usage: barrito ci/)
})

test('build: rejects keyring gateway refs', () => {
  assert.throws(
    () => build(flags(['--gateway-key', 'Vercel AI Gateway'])),
    /CI has no keyring; use env:VAR or file:\/path/,
  )
})

test('build: one identity, gateway ref, fallback, claude dir under home', () => {
  const input = build(flags(['--identity', 'ci', '--fallback', 'zai/glm-5.3', '--port', '5123']))
  assert.equal(input.port, 5123)
  assert.equal(input.default, 'ci')
  assert.deepEqual(input.identities?.ci, {
    claude_config_dir: path.join(tmp, '.claude'),
    fallback: ['zai/glm-5.3'],
    keychain: { gateway: 'env:AI_GATEWAY_API_KEY' },
  })
})

test('ci writes config, shims, GITHUB_PATH/ENV and starts the router detached', async () => {
  const env = ghaEnv()
  const c = ctx()
  const started: { config: { default: string }; port: number; statePath?: string; logFile?: string; env?: NodeJS.ProcessEnv }[] = []
  await ci(['--fallback', 'zai/glm-5.3'], c, {
    env,
    start: async (args) => { started.push(args); return { pid: 4242, port: args.port } },
  })

  const base = path.join(String(env.RUNNER_TEMP), 'barrito')
  const cfg = loadConfig(path.join(base, 'config.toml'))
  assert.equal(cfg.default, 'ci')
  assert.equal(cfg.port, 4141)
  assert.equal(cfg.identities.ci?.keychain.gateway, 'env:AI_GATEWAY_API_KEY')
  assert.deepEqual(cfg.identities.ci?.fallback, ['zai/glm-5.3'])
  assert.equal(cfg.identities.ci?.claude_config_dir, path.join(tmp, '.claude'))

  assert.equal(readFileSync(String(env.GITHUB_PATH), 'utf8'), `${path.join(base, 'shims')}\n`)
  assert.deepEqual(readFileSync(String(env.GITHUB_ENV), 'utf8').trim().split('\n'), envLines({
    config: path.join(base, 'config.toml'),
    state: path.join(base, 'state'),
    shims: path.join(base, 'shims'),
    log: path.join(base, 'barrito.log'),
    identity: 'ci',
  }))
  assert.equal(existsSync(path.join(base, 'shims', 'claude')), true)

  assert.equal(started.length, 1)
  assert.equal(started[0]?.port, 4141)
  assert.equal(started[0]?.statePath, path.join(base, 'state'))
  assert.equal(started[0]?.logFile, path.join(base, 'barrito.log'))
  assert.deepEqual(started[0]?.env, {
    BARRITO_CONFIG: path.join(base, 'config.toml'),
    BARRITO_STATE: path.join(base, 'state'),
    BARRITO_LOG: path.join(base, 'barrito.log'),
    BARRITO_SHIMS: path.join(base, 'shims'),
  })
  assert.ok(c.printed.some((l) => l === '::notice::CLAUDE_CODE_OAUTH_TOKEN not set — Claude Code will run on the gateway only (fallback zai/glm-5.3) — no Max'))
  assert.ok(c.printed.some((l) => l === 'barrito ci ready · identity ci · fallback zai/glm-5.3 · http://127.0.0.1:4141'))
  assert.deepEqual(c.codes, [])
})

test('a newline in --identity is rejected before anything is written', async () => {
  assert.throws(() => flags(['--identity', 'ci\nEVIL=1']), /--identity .*must match/)
  const env = ghaEnv()
  const c = ctx()
  let started = 0
  await assert.rejects(
    () => ci(['--identity', 'ci\nEVIL=1'], c, { env, start: async () => { started++; return { pid: 1, port: 1 } } }),
    /--identity/,
  )
  assert.equal(started, 0)
  assert.equal(existsSync(String(env.GITHUB_PATH)), false)
  assert.equal(existsSync(String(env.GITHUB_ENV)), false)
  assert.equal(existsSync(path.join(String(env.RUNNER_TEMP), 'barrito', 'config.toml')), false)
})

test('a newline in RUNNER_TEMP is rejected before anything is written', async () => {
  const env = ghaEnv({ RUNNER_TEMP: `${tmp}\nEVIL=1` })
  const c = ctx()
  let started = 0
  await assert.rejects(
    () => ci([], c, { env, start: async () => { started++; return { pid: 1, port: 1 } } }),
    /contains a newline — refusing to write it to the GitHub Actions environment/,
  )
  assert.equal(started, 0)
  assert.equal(existsSync(String(env.GITHUB_PATH)), false)
  assert.equal(existsSync(String(env.GITHUB_ENV)), false)
  assert.equal(existsSync(path.join(env.RUNNER_TEMP ?? '', 'barrito', 'config.toml')), false)
})

test('--config: keyring gateway refs in the loaded identities are rejected', async () => {
  const file = path.join(tmp, 'keyring.toml')
  writeFileSync(file, [
    'port = 4141',
    'default = "ci"',
    '',
    '[identities.ci]',
    `claude_config_dir = "${tmp}/.claude"`,
    'keychain = { gateway = "Vercel AI Gateway" }',
    '',
  ].join('\n'))
  const env = ghaEnv()
  const c = ctx()
  let started = 0
  await assert.rejects(
    () => ci(['--config', file], c, { env, start: async () => { started++; return { pid: 1, port: 1 } } }),
    /identities\.ci\.keychain\.gateway "Vercel AI Gateway" is a keyring item name/,
  )
  assert.equal(started, 0)
  assert.equal(existsSync(String(env.GITHUB_ENV)), false)
})

test('ci: no notice when CLAUDE_CODE_OAUTH_TOKEN is set, ready line shows none for empty chain', async () => {
  const env = ghaEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' })
  const c = ctx()
  await ci([], c, { env, start: async () => ({ pid: 1, port: 4141 }) })
  assert.ok(!c.printed.some((l) => l.startsWith('::notice::')))
  assert.ok(c.printed.some((l) => l === 'barrito ci ready · identity ci · fallback none · http://127.0.0.1:4141'))
})

test('ci outside GitHub Actions prints export lines instead of appending', async () => {
  const c = ctx()
  await ci([], c, {
    env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
    tmp,
    start: async () => ({ pid: 1, port: 4141 }),
  })
  const base = path.join(tmp, 'barrito-ci')
  assert.deepEqual(c.printed.filter((l) => !/^(wrote|linked) /.test(l)), [
    `export PATH=${JSON.stringify(path.join(base, 'shims'))}:$PATH`,
    `export ${JSON.stringify(`BARRITO_CONFIG=${path.join(base, 'config.toml')}`)}`,
    `export ${JSON.stringify(`BARRITO_STATE=${path.join(base, 'state')}`)}`,
    `export ${JSON.stringify(`BARRITO_SHIMS=${path.join(base, 'shims')}`)}`,
    `export ${JSON.stringify(`BARRITO_LOG=${path.join(base, 'barrito.log')}`)}`,
    'export "BARRITO_IDENTITY=ci"',
    'barrito ci ready · identity ci · fallback none · http://127.0.0.1:4141',
  ])
})

test('ci --config loads the given file and points BARRITO_CONFIG at it', async () => {
  const file = path.join(tmp, 'given.toml')
  const env = ghaEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' })
  const c = ctx()
  const started: { config: { default: string }; port: number }[] = []
  await ci(['--config', file, '--port', '5123'], c, {
    env,
    start: async (args) => { started.push(args); return { pid: 1, port: args.port } },
  })
  assert.equal(readFileSync(String(env.GITHUB_ENV), 'utf8').includes(`BARRITO_CONFIG=${file}`), true)
  assert.equal(started[0]?.port, 5123)
})

test('ci stop: markdown to the step summary, then stop, exit 0', async () => {
  const env = ghaEnv()
  const c = ctx()
  let stopped = 0
  const statusCalls: string[][] = []
  await ci(['stop'], c, {
    env,
    status: async (argv, sctx) => {
      statusCalls.push(argv)
      sctx.print('| Identity | Tier | Max 5h | Max 7d | Resets | API today |')
      sctx.print('⚠ ci fell back to glm-5.3 (quota)')
    },
    stop: async () => { stopped++; return true },
  })
  assert.deepEqual(statusCalls, [['--markdown']])
  assert.equal(stopped, 1)
  assert.equal(readFileSync(String(env.GITHUB_STEP_SUMMARY), 'utf8'), '| Identity | Tier | Max 5h | Max 7d | Resets | API today |\n⚠ ci fell back to glm-5.3 (quota)\n\n')
  assert.deepEqual(c.codes, [])
})

test('ci stop: never fails the job — stop errors become warnings', async () => {
  const env = ghaEnv()
  const c = ctx()
  await ci(['stop'], c, {
    env,
    status: async () => {},
    stop: async () => { throw new Error('no pidfile') },
  })
  assert.ok(c.printed.some((l) => l === 'barrito: warning: could not stop the ci router — no pidfile'))
  assert.deepEqual(c.codes, [])
})

test('ci stop outside GHA: prints the markdown, no summary file, exit 0', async () => {
  const c = ctx()
  let stopped = 0
  await ci(['stop'], c, {
    env: {},
    status: async (_argv, sctx) => { sctx.print('> barrito: router not running') },
    stop: async () => { stopped++; return true },
  })
  assert.deepEqual(c.printed, ['> barrito: router not running'])
  assert.equal(stopped, 1)
  assert.deepEqual(c.codes, [])
})

test('CLAUDE_CODE_OAUTH_TOKEN in env counts as logged in without touching the filesystem', () => {
  const fs = {
    readFileSync: () => { throw new Error('should not read ~/.claude.json') },
  }
  assert.deepEqual(account(path.join(tmp, '.claude'), { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, fs, home: tmp }), { loggedIn: true, email: null })
})

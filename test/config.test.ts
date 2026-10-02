import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { load, save, defaults } from '../src/config.ts'
import { paths, expand, home } from '../src/paths.ts'

const keys = ['BARRITO_HOME', 'BARRITO_CONFIG', 'BARRITO_STATE', 'BARRITO_LOG', 'BARRITO_SHIMS']
let prev: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]] as const))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-config-'))
  process.env.BARRITO_HOME = tmp
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

const file = (): string => path.join(tmp, 'config.toml')

test('paths are lazy — env set after import wins', () => {
  assert.equal(home(), tmp)
  assert.equal(paths.config, path.join(tmp, '.config', 'barrito', 'config.toml'))
  process.env.BARRITO_CONFIG = path.join(tmp, 'other.toml')
  assert.equal(paths.config, path.join(tmp, 'other.toml'))
  assert.equal(expand('~/x'), path.join(tmp, 'x'))
  assert.equal(expand('/abs/x'), '/abs/x')
})

test('missing file → defaults, no throw', () => {
  const config = load(path.join(tmp, 'nope.toml'))
  assert.equal(config.port, 4141)
  assert.equal(config.default, 'personal')
  assert.deepEqual(config.identities, {})
  assert.deepEqual(config.models.require, ['tool-use'])
  assert.deepEqual(config.models.agents, {
    astra: 'openai/gpt-6-astra', glm: 'zai/glm-5.3[1m]', deepseek: 'deepseek/deepseek-v4.1-flash[1m]',
  })
  assert.deepEqual(config.graft.roots, [])
  assert.deepEqual(config.warnings, [])
})

test('defaults export matches contract', () => {
  assert.deepEqual(defaults, {
    port: 4141, default: 'personal', identities: {}, models: {}, graft: { roots: [], repos: [] }, harness: {},
  })
})

test('parses TOML, merges defaults, expands ~, sets id; missing fallback = []', () => {
  writeFileSync(file(), `port = 4150
default = "work"

[identities.work]
claude_config_dir = "~/.claude"
match.remotes = ["github.com/acme/*"]
match.paths = ["~/Code/acme/**"]
keychain.gateway = "Vercel AI Gateway Work"

[identities.personal]
claude_config_dir = "~/.claude-personal"
share_from = "~/.claude"

[graft]
roots = ["~/Code"]
repos = [{ path = "~/Code/acme/api", summaries = false }]
`)
  const config = load(file())
  const work = config.identities.work!
  assert.equal(work.id, 'work')
  assert.equal(work.claude_config_dir, path.join(tmp, '.claude'))
  assert.equal(work.share_from, null)
  assert.deepEqual(work.fallback, [])
  assert.deepEqual(work.match.paths, [path.join(tmp, 'Code/acme/**')])
  assert.deepEqual(config.graft.roots, [path.join(tmp, 'Code')])
  assert.deepEqual(config.graft.repos, [{ path: path.join(tmp, 'Code/acme/api'), summaries: false }])
  const personal = config.identities.personal!
  assert.equal(personal.share_from, path.join(tmp, '.claude'))
})

test('default identity must exist', () => {
  writeFileSync(file(), `default = "ghost"

[identities.work]
claude_config_dir = "~/.claude"
`)
  assert.throws(() => load(file()), /default identity "ghost" is not defined.*add \[identities.ghost\]/)
})

test('port must be an integer', () => {
  writeFileSync(file(), 'port = "nope"')
  assert.throws(() => load(file()), /port must be an integer between 1 and 65535, got "nope"/)
})

test('port must be in 1..65535', () => {
  writeFileSync(file(), 'port = 70000')
  assert.throws(() => load(file()), /between 1 and 65535, got 70000/)
  writeFileSync(file(), 'port = 0')
  assert.throws(() => load(file()), /between 1 and 65535, got 0/)
})

test('match must be a table of string arrays', () => {
  writeFileSync(file(), `default = "work"

[identities.work]
match = "x"
`)
  assert.throws(() => load(file()), /identities\.work\.match must be a table/)
  writeFileSync(file(), 'default = "work"\n\n[identities.work]\nmatch.paths = [1]\n')
  assert.throws(() => load(file()), /identities\.work\.match\.paths must be an array of strings/)
  writeFileSync(file(), 'default = "work"\n\n[identities.work]\nmatch.remotes = "github.com/*"\n')
  assert.throws(() => load(file()), /identities\.work\.match\.remotes must be an array of strings/)
})

test('keychain must be a table of strings', () => {
  writeFileSync(file(), 'default = "work"\n\n[identities.work]\nkeychain = ["a"]\n')
  assert.throws(() => load(file()), /identities\.work\.keychain must be a table/)
  writeFileSync(file(), 'default = "work"\n\n[identities.work]\nkeychain.gateway = 5\n')
  assert.throws(() => load(file()), /identities\.work\.keychain\.gateway must be a string/)
})

test('unknown keys inside identities warn', () => {
  writeFileSync(file(), 'default = "work"\n\n[identities.work]\nclaude_config_dir = "~/.claude"\nwat = 1\n')
  const config = load(file())
  assert.equal(config.warnings.length, 1)
  assert.match(config.warnings[0]!, /unknown key "wat" in identities\.work ignored/)
})

test('unknown top-level keys warn', () => {
  writeFileSync(file(), 'wat = 1')
  const config = load(file())
  assert.match(config.warnings[0]!, /unknown key "wat" ignored/)
})

test('save → load round-trip collapses home, drops id/warnings/nulls, atomic', () => {
  const config = {
    port: 4150,
    default: 'work',
    identities: {
      work: {
        id: 'work',
        claude_config_dir: path.join(tmp, '.claude'),
        share_from: null,
        fallback: ['zai/glm-5.3'],
        match: { remotes: ['github.com/acme/*'], paths: [path.join(tmp, 'Code/acme/**')] },
        keychain: { gateway: 'Vercel AI Gateway Work' },
      },
    },
    models: { include: ['zai/*'], max_input_price: 5, labels: { 'openai/gpt-6-astra': 'Astra' } },
    graft: { roots: [path.join(tmp, 'Code')], repos: [{ path: path.join(tmp, 'Code/acme/api'), summaries: false }] },
    harness: { mybot: { bin: 'mybot', env: { OPENAI_BASE_URL: '{gateway}/v1' } } },
    warnings: ['whatever'],
  }
  save(config, file())
  const toml = readFileSync(file(), 'utf8')
  assert.match(toml, /claude_config_dir = "~\/.claude"/)
  assert.match(toml, /\[\[graft\.repos\]\]/)
  assert.match(toml, /path = "~\/Code\/acme\/api"/)
  assert.equal(toml.includes('id ='), false)
  assert.equal(toml.includes('warnings'), false)
  assert.equal(toml.includes('share_from'), false)
  assert.equal(toml.includes('max_input_price = 5'), true)
  assert.equal(existsSync(`${file()}.tmp`), false)

  const back = load(file())
  const expected = {
    port: 4150,
    default: 'work',
    identities: {
      work: {
        id: 'work',
        claude_config_dir: path.join(tmp, '.claude'),
        share_from: null,
        fallback: ['zai/glm-5.3'],
        match: { remotes: ['github.com/acme/*'], paths: [path.join(tmp, 'Code/acme/**')] },
        keychain: { gateway: 'Vercel AI Gateway Work' },
      },
    },
    models: {
      include: ['zai/*'], exclude: [], require: ['tool-use'], max_input_price: 5, pin: [], labels: { 'openai/gpt-6-astra': 'Astra' },
      agents: { astra: 'openai/gpt-6-astra', glm: 'zai/glm-5.3[1m]', deepseek: 'deepseek/deepseek-v4.1-flash[1m]' },
    },
    graft: { roots: [path.join(tmp, 'Code')], repos: [{ path: path.join(tmp, 'Code/acme/api'), summaries: false }] },
    harness: { mybot: { bin: 'mybot', env: { OPENAI_BASE_URL: '{gateway}/v1' } } },
    warnings: [],
  }
  assert.deepEqual(back, expected)
})

test('save round-trips identities without match/keychain/fallback', () => {
  save({
    port: 4141,
    default: 'solo',
    identities: { solo: { claude_config_dir: path.join(tmp, '.claude') } },
  }, file())
  const back = load(file())
  assert.deepEqual(back.identities.solo!.match, { remotes: [], paths: [] })
  assert.deepEqual(back.identities.solo!.keychain, {})
  assert.deepEqual(back.identities.solo!.fallback, [])
  assert.equal(back.identities.solo!.share_from, null)
})

test('save creates nested dirs and load defaults never mutate', () => {
  const before = JSON.stringify(defaults)
  save({ port: 4141, default: 'personal', identities: {}, models: {}, graft: { roots: [], repos: [] }, harness: {} }, path.join(tmp, 'a/b/config.toml'))
  assert.equal(JSON.stringify(defaults), before)
  assert.equal(existsSync(path.join(tmp, 'a/b/config.toml')), true)
})

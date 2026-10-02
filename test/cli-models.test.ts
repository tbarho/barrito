process.env.NO_COLOR = '1'

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import cmd from '../src/cli/models.ts'
import { load, save } from '../src/config.ts'
import { render, select } from '../src/models.ts'
import type { CommandCtx, Config } from '../src/types.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8')).data
const env = ['BARRITO_HOME', 'BARRITO_STATE', 'BARRITO_CONFIG']

const setup = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'barrito-cli-'))
  const had = Object.fromEntries(env.map((k) => [k, process.env[k]]))
  const state = join(root, 'state')
  const configFile = join(root, 'config.toml')
  process.env.BARRITO_HOME = root
  process.env.BARRITO_STATE = state
  process.env.BARRITO_CONFIG = configFile
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: fixture }))
  const dirs = { a: join(root, 'a'), b: join(root, 'b') }
  mkdirSync(dirs.a)
  mkdirSync(dirs.b)
  t.after(() => {
    chmodSync(dirs.b, 0o755)
    rmSync(root, { recursive: true, force: true })
    env.forEach((k) => { if (had[k] === undefined) delete process.env[k]; else process.env[k] = had[k] })
  })
  return { dirs, file: configFile, state }
}

const cfg = (dirs: { a: string; b: string }): Config => {
  const file = process.env.BARRITO_CONFIG
  if (!file) throw new Error('test bug: BARRITO_CONFIG not set — call setup() first')
  save({
    port: 4141,
    default: 'a',
    identities: { a: { claude_config_dir: dirs.a }, b: { claude_config_dir: dirs.b } },
    models: { include: ['zai/*', 'deepseek/*'] },
    graft: { roots: [], repos: [] },
  }, file)
  return load(file)
}

const run = async (args: string[], config: Config): Promise<{ out: string; code: number }> => {
  const out: string[] = []
  let code = 0
  await cmd(args, {
    config,
    print: (s: string) => { out.push(s) },
    exit: (c: number) => { code = c },
  })
  return { out: out.join('\n'), code }
}

const fakeFetch = (t: TestContext, fn: unknown) => {
  const real = globalThis.fetch
  globalThis.fetch = fn as typeof globalThis.fetch
  t.after(() => { globalThis.fetch = real })
}

test('models shows every identity dir picker', async (t) => {
  const { dirs } = setup(t)
  writeFileSync(join(dirs.a, 'settings.json'), JSON.stringify({
    modelPicker: { options: [{ model: 'claude-code/zai/glm-5.3[1m]', label: 'GLM 5.3', description: 'd' }] },
  }))
  const { out, code } = await run([], cfg(dirs))
  assert.match(out, new RegExp(dirs.a))
  assert.match(out, /GLM 5\.3/)
  assert.match(out, new RegExp(dirs.b))
  assert.match(out, /no picker yet/)
  assert.equal(code, 0)
})

test('models search reports no matches', async (t) => {
  const { dirs } = setup(t)
  const miss = await run(['search', 'zzz-nope'], cfg(dirs))
  assert.equal(miss.out, 'no matches for "zzz-nope"')
  assert.equal(miss.code, 0)
  const hit = await run(['search', 'glm-5.3-flash'], cfg(dirs))
  assert.match(hit.out, /zai\/glm-5\.3-flash /)
})

test('models add rejects models that fail the language/require checks', async (t) => {
  const { dirs, file } = setup(t)
  const config = cfg(dirs)
  const image = await run(['add', 'meta/muse-image-1.0'], config)
  assert.equal(image.code, 1)
  assert.match(image.out, /not a language model/)
  const noTool = await run(['add', 'stepfun/step-5-preview'], config)
  assert.equal(noTool.code, 1)
  assert.match(noTool.out, /missing tool-use/)
  assert.deepEqual(load(file).models.pin, []) // nothing saved
})

test('models add and rm round-trip pin and exclude', async (t) => {
  const { dirs, file } = setup(t)
  const config = cfg(dirs)
  const add = await run(['add', 'claude-code/zai/glm-5.3[1m]'], config)
  assert.equal(add.code, 0)
  assert.match(add.out, /pinned zai\/glm-5\.3/)
  assert.deepEqual(load(file).models.pin, ['zai/glm-5.3'])
  assert.deepEqual(load(file).models.exclude, [])

  const rm = await run(['rm', 'zai/glm-5.3'], config)
  assert.equal(rm.code, 0)
  assert.match(rm.out, /unpinned and excluded zai\/glm-5\.3/)
  assert.deepEqual(load(file).models.pin, [])
  assert.deepEqual(load(file).models.exclude, ['zai/glm-5.3'])

  const again = await run(['add', 'zai/glm-5.3'], config)
  assert.equal(again.code, 0)
  assert.deepEqual(load(file).models.pin, ['zai/glm-5.3'])
  assert.deepEqual(load(file).models.exclude, [])
})

test('models sync --dry-run writes nothing', async (t) => {
  const { dirs } = setup(t)
  const { out, code } = await run(['sync', '--dry-run'], cfg(dirs))
  assert.match(out, /\+ zai\/glm-5\.3 /)
  assert.match(out, /dry run/)
  assert.equal(existsSync(join(dirs.a, 'settings.json')), false)
  assert.equal(existsSync(join(dirs.a, 'agents')), false)
  assert.equal(code, 0)
})

test('models sync --dry-run refreshes in memory without caching', async (t) => {
  const { dirs, state } = setup(t)
  rmSync(join(state, 'catalog.json'))
  fakeFetch(t, async () => ({ ok: true, json: async () => ({ data: fixture }) }))
  await run(['sync', '--dry-run'], cfg(dirs))
  assert.equal(existsSync(join(state, 'catalog.json')), false)
  const write = await run(['sync'], cfg(dirs))
  assert.equal(existsSync(join(state, 'catalog.json')), true)
  assert.match(write.out, /new/)
})

test('models sync writes pickers and agents, rerun is a no-op', async (t) => {
  const { dirs } = setup(t)
  const config = cfg(dirs)
  const first = await run(['sync'], config)
  assert.match(first.out, /new/)
  assert.ok(existsSync(join(dirs.a, 'settings.json')))
  assert.match(readFileSync(join(dirs.a, 'agents', 'glm.md'), 'utf8'), /^model: claude-code\/zai\/glm-5\.3\[1m\]$/m)
  const second = await run(['sync'], config)
  assert.doesNotMatch(second.out, /new/)
  assert.doesNotMatch(second.out, /retired/)
  assert.doesNotMatch(second.out, /updated/)
  assert.match(second.out, /unchanged/)
  assert.equal(second.code, 0)
})

test('models sync --json exposes per-dir buckets and removed reasons', async (t) => {
  const { dirs } = setup(t)
  writeFileSync(join(dirs.a, 'settings.json'), JSON.stringify({
    modelPicker: { options: [{ model: 'claude-code/stepfun/step-3.7-flash', label: 'Step', description: 'old' }] },
  }))
  const { out } = await run(['sync', '--dry-run', '--json'], cfg(dirs))
  const result = JSON.parse(out)
  assert.equal(result.dirs.length, 2)
  assert.ok(result.dirs.every((d: { ok: boolean }) => d.ok))
  const a = result.dirs.find((d: { dir: string }) => d.dir === dirs.a)
  assert.deepEqual(a.removed, [{ id: 'stepfun/step-3.7-flash', reason: 'rules' }])
  assert.ok(a.added.length > 0)
  assert.deepEqual(result.removed, [{ id: 'stepfun/step-3.7-flash', reason: 'rules' }])
})

test('models sync prints per-dir diffs when dirs diverge', async (t) => {
  const { dirs } = setup(t)
  const config = cfg(dirs)
  const fresh = render(select(fixture, config.models), config).modelPicker.options
  writeFileSync(join(dirs.b, 'settings.json'), JSON.stringify({ modelPicker: { options: fresh } }))
  const { out } = await run(['sync', '--dry-run'], config)
  // one Picker section per diverging dir, home-relative
  assert.match(out, /^o {2}Picker - ~\/a$/m)
  assert.match(out, /^o {2}Picker - ~\/b$/m)
  assert.match(out, /= 0 unchanged/)
  assert.match(out, /= [12]\d unchanged/)
})

test('models sync isolates an unwritable dir, writes the rest, exits 1', async (t) => {
  if (process.getuid?.() === 0) t.skip('root ignores dir permissions')
  const { dirs } = setup(t)
  chmodSync(dirs.b, 0o555)
  const { out, code } = await run(['sync'], cfg(dirs))
  assert.equal(code, 1)
  assert.match(out, /^\| {2}x ~\/b {2}/m) // NO_COLOR: ASCII mark, inside the Notes section
  assert.ok(existsSync(join(dirs.a, 'settings.json')))
  assert.ok(existsSync(join(dirs.a, 'agents', 'glm.md')))
})

test('models sync with no identities fails', async (t) => {
  const { dirs } = setup(t)
  const config = cfg(dirs)
  config.identities = {}
  await assert.rejects(run(['sync'], config), /no identities in config — run barrito init/)
})

test('models falls back to a stale cache with a warning when refresh fails', async (t) => {
  const { dirs, state } = setup(t)
  writeFileSync(join(state, 'catalog.json'), JSON.stringify({
    fetchedAt: Date.now() - 30 * 86400e3,
    data: fixture,
  }))
  fakeFetch(t, async () => ({ ok: false, status: 503 }))
  const { out, code } = await run(['search', 'glm-5.3-flash'], cfg(dirs))
  assert.match(out, /catalog refresh failed \(gateway catalog 503\) — using cache from \d{4}-\d{2}-\d{2}/)
  assert.match(out, /zai\/glm-5\.3-flash/)
  assert.equal(code, 0)
})

test('models add proceeds without checks when the catalog is unavailable', async (t) => {
  const { dirs, file, state } = setup(t)
  rmSync(join(state, 'catalog.json'))
  fakeFetch(t, async () => ({ ok: false, status: 500 }))
  const { out, code } = await run(['add', 'zai/glm-5.3'], cfg(dirs))
  assert.equal(code, 0)
  assert.match(out, /pinned zai\/glm-5\.3/)
  assert.deepEqual(load(file).models.pin, ['zai/glm-5.3'])
})

test('models rejects unknown subcommands', async (t) => {
  const { dirs } = setup(t)
  const { out, code } = await run(['bogus'], cfg(dirs))
  assert.equal(code, 2)
  assert.match(out, /unknown subcommand/)
})

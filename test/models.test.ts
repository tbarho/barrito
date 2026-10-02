import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import * as catalog from '../src/catalog.ts'
import { check, per1m, render, select, skipped, sync } from '../src/models.ts'
import type { CatalogModel, ClaudeSettings, Fs, PickerRow, Selected, Settings } from '../src/types.ts'

const fixture: CatalogModel[] = JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8')).data
const templates = fileURLToPath(new URL('../templates/agents/', import.meta.url))

const rules = {
  include: ['zai/*', 'deepseek/*', 'openai/gpt-6*', 'google/gemini-3.8*', 'anthropic/*'],
  exclude: ['*-0731'],
  require: ['tool-use'],
  max_input_price: 5,
  pin: ['meta/muse-spark-1.3-contributor'],
  labels: { 'openai/gpt-6-astra': 'GPT-6 Astra · heavy / 2nd opinion' },
  agents: { astra: 'openai/gpt-6-astra', glm: 'zai/glm-5.3[1m]', deepseek: 'deepseek/deepseek-v4.1-flash[1m]' },
}

const config = {
  identities: {
    work: { claude_config_dir: '/home/a/.claude' },
    personal: { claude_config_dir: '/home/a/.claude' },
    other: { claude_config_dir: '/home/a/.claude-other' },
  },
  models: rules,
}

const ids = (rows: Selected[]): string[] => rows.map((m) => m.id)

test('select filters by type, require, include, exclude, price', () => {
  const got = ids(select(fixture, rules))
  assert.equal(got.includes('zai/glm-5.3[1m]'), true)
  assert.equal(got.includes('meta/muse-spark-1.3-contributor[1m]'), true)   // pin outside include
  assert.equal(got.includes('deepseek/deepseek-v4-flash-0731'), false)     // excluded by glob
  assert.equal(got.includes('anthropic/claude-opus-4'), false)              // $15/1M input
  assert.equal(got.includes('anthropic/claude-opus-5[1m]'), true)           // $5/1M input, at cap
  assert.equal(got.includes('stepfun/step-3.7-flash'), false)              // not in include
  assert.equal(got.includes('stepfun/step-5-preview'), false)               // no tool-use
  assert.equal(got.includes('google/gemini-3.8-flash[1m]'), true)
  assert.equal(got.some((id) => id.startsWith('meta/muse-image')), false)   // image type
})

test('select all skips include/exclude/price but keeps require', () => {
  const got = ids(select(fixture, { ...rules, all: true }))
  assert.equal(got.includes('stepfun/step-3.7-flash'), true)
  assert.equal(got.includes('meta/muse-glimmer-30b'), true)
  assert.equal(got.includes('anthropic/claude-opus-4'), true)              // price cap skipped
  assert.equal(got.includes('stepfun/step-5-preview'), false)               // still needs tool-use
  assert.equal(got.some((id) => id.includes('tts')), false)                 // still language only
})

test('select appends [1m] only without long-context surcharge', () => {
  const got = ids(select(fixture, { include: ['zai/glm-5.3*', 'openai/gpt-6-astra'], require: [] }))
  assert.deepEqual(got, ['openai/gpt-6-astra', 'zai/glm-5.3[1m]', 'zai/glm-5.3-fast[1m]', 'zai/glm-5.3-flash[1m]', 'zai/glm-5.3-flashx[1m]'])
  const small = ids(select(fixture, { include: ['stepfun/step-3.7*'], require: [] }))
  assert.deepEqual(small, ['stepfun/step-3.7-flash'])
})

test('select honors per-model suffix overrides', () => {
  const suffix: Record<string, '[1m]' | ''> = { 'openai/gpt-6-astra': '[1m]', 'zai/glm-5.3': '' }
  const got = ids(select(fixture, { include: ['zai/glm-5.3', 'openai/gpt-6-astra'], require: [], suffix }))
  assert.deepEqual(got, ['openai/gpt-6-astra[1m]', 'zai/glm-5.3'])
})

test('pins must still be language models with the required tags', () => {
  const pin = ['meta/muse-image-1.0', 'stepfun/step-5-preview', 'zai/glm-5.3']
  const got = ids(select(fixture, { require: ['tool-use'], pin }))
  assert.equal(got.includes('meta/muse-image-1.0'), false)
  assert.equal(got.includes('stepfun/step-5-preview'), false)
  assert.equal(got.includes('zai/glm-5.3[1m]'), true)
  assert.deepEqual(skipped(fixture, { require: ['tool-use'], pin }), [
    { id: 'meta/muse-image-1.0', why: 'not a language model' },
    { id: 'stepfun/step-5-preview', why: 'missing tool-use' },
  ])
})

test('select prices are base-tier per-token numbers', () => {
  const glm = select(fixture, rules).find((m) => m.id === 'zai/glm-5.3[1m]')
  assert.deepEqual(glm?.price, { input: 0.0000014, output: 0.0000044, input_cache_read: 0.00000014 })
  assert.equal(glm?.name, 'GLM 5.3')
  assert.deepEqual(select(fixture, { ...rules, max_input_price: null }).find((m) => m.id === 'openai/gpt-6-astra')?.tiers, { threshold: 272001, factor: 2 })
})

test('render labels, descriptions, tier note, and provider grouping', () => {
  const shown = select(fixture, { ...rules, max_input_price: null })
  const { modelPicker } = render(shown, config)
  const models = modelPicker.options.map((o) => o.model)
  assert.equal(models.includes('claude-code/zai/glm-5.3[1m]'), true)
  assert.equal(models.includes('claude-code/openai/gpt-6-astra'), true)      // no [1m] — tiered pricing
  const providers = models.map((m) => m.replace(/^claude-code\//, '').split('/')[0])
  assert.deepEqual(providers, [...providers].sort())
  const astra = modelPicker.options.find((o) => o.model === 'claude-code/openai/gpt-6-astra')
  assert.equal(astra?.label, 'GPT-6 Astra · heavy / 2nd opinion')             // label wins, keyed bare
  assert.equal(astra?.description, 'GPT-6 Astra · $10/$50 per 1M · 2× >272k')
  const glm = modelPicker.options.find((o) => o.model === 'claude-code/zai/glm-5.3[1m]')
  assert.equal(glm?.label, 'GLM 5.3')
  assert.equal(glm?.description, 'GLM 5.3 · $1.40/$4.40 per 1M')
})

test('per1m formats dollars per 1M sensibly', () => {
  assert.equal(per1m(0.0000014), '$1.40')
  assert.equal(per1m(0.000005), '$5')
  assert.equal(per1m(0.000000076), '$0.08')
})

const memfs = (): Fs & { writes: number; files: Map<string, string> } => {
  const files = new Map<string, string>()
  const read = (file: string): string => {
    if (!files.has(file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' })
    return files.get(file) as string
  }
  const fs: Fs & { writes: number; files: Map<string, string> } = {
    readFileSync: read,
    writeFileSync: (file, body) => { fs.writes += 1; files.set(file, body) },
    mkdirSync: () => {},
    writes: 0,
    files,
  }
  for (const name of ['astra', 'glm', 'deepseek']) {
    files.set(join(templates, `${name}.md`), readFileSync(join(templates, `${name}.md`), 'utf8'))
  }
  return fs
}

const fakeSettings = (opts: { throwFor?: string } = {}): Settings & { pickers: Map<string, { options: PickerRow[] }>; merges: number } => {
  const s: Settings & { pickers: Map<string, { options: PickerRow[] }>; merges: number } = {
    pickers: new Map(),
    merges: 0,
    read: (dir: string): ClaudeSettings => {
      if (opts.throwFor === dir) throw new Error('settings: cannot read')
      return s.pickers.has(dir) ? { modelPicker: s.pickers.get(dir) } : {}
    },
    merge: (dir: string, { modelPicker }: ClaudeSettings): ClaudeSettings => {
      s.merges += 1
      const picked = modelPicker ?? { options: [] }
      s.pickers.set(dir, picked)
      return { modelPicker: picked }
    },
  }
  return s
}

test('sync diffs, writes agents, dedupes dirs, and is idempotent', async () => {
  const settings = fakeSettings()
  const fs = memfs()
  const first = await sync({ config, catalog: fixture, settings, fs })
  assert.deepEqual(first.dirs.map((d) => d.dir), ['/home/a/.claude', '/home/a/.claude-other'])
  assert.ok(first.dirs.every((d) => d.ok))
  assert.equal(first.added.length > 0, true)
  assert.deepEqual(first.removed, [])
  assert.deepEqual(first.updated, [])
  assert.equal(settings.merges, 2)
  const written = fs.files.get('/home/a/.claude/agents/glm.md')!
  assert.match(written, /^model: claude-code\/zai\/glm-5\.3\[1m\]$/m)
  assert.match(written, /^# generated by barrito/m)

  const writes = fs.writes
  const second = await sync({ config, catalog: fixture, settings, fs })
  assert.deepEqual(second.added, [])
  assert.deepEqual(second.removed, [])
  assert.deepEqual(second.updated, [])
  assert.equal(second.unchanged.length, first.added.length)
  assert.equal(settings.merges, 2)
  assert.equal(fs.writes, writes)
})

test('sync dry-run reports the diff but writes nothing', async () => {
  const settings = fakeSettings()
  const fs = memfs()
  const result = await sync({ config, catalog: fixture, dryRun: true, settings, fs })
  assert.equal(result.added.length > 0, true)
  assert.equal(settings.merges, 0)
  assert.equal(fs.writes, 0)
  assert.equal(fs.files.has('/home/a/.claude/agents/glm.md'), false)
})

test('sync separates rules-removed from retired, and reports missing refs', async () => {
  const retired = fixture.filter((m) => m.id !== 'zai/glm-5.3')
  const cfg = { identities: { one: { claude_config_dir: '/home/a/.claude' } }, models: rules }
  const settings = fakeSettings()
  const stale = render(select(fixture, rules), config).modelPicker.options.concat([
    { model: 'claude-code/stepfun/step-3.7-flash', label: 'Step 3.7 Flash', description: 'old' },
  ])
  settings.pickers.set('/home/a/.claude', { options: stale })
  const fs = memfs()
  const result = await sync({ config: cfg, catalog: retired, settings, fs })
  assert.deepEqual(result.removed, [
    { id: 'zai/glm-5.3', reason: 'retired' },
    { id: 'stepfun/step-3.7-flash', reason: 'rules' },
  ])
  assert.ok(result.missing.includes('zai/glm-5.3[1m]'))
  assert.equal(result.protected.length, 0)
  assert.equal(fs.files.has('/home/a/.claude/agents/glm.md'), false) // agent model retired → skipped
})

test('sync flags label or description changes as updated', async () => {
  const cfg = { identities: { one: { claude_config_dir: '/home/a/.claude' } }, models: rules }
  const settings = fakeSettings()
  const fresh = render(select(fixture, rules), config).modelPicker.options
  settings.pickers.set('/home/a/.claude', { options: fresh.map((o, i) => (i === 0 ? { ...o, label: 'Old label' } : o)) })
  const result = await sync({ config: cfg, catalog: fixture, settings, fs: memfs() })
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.updated, [catalog.bare(fresh[0]?.model ?? '')])
  assert.equal(settings.merges, 1)
})

test('sync isolates dir failures and still writes healthy dirs', async () => {
  const cfg = { identities: { good: { claude_config_dir: '/home/a/.claude' }, bad: { claude_config_dir: '/home/a/.claude-broken' } }, models: rules }
  const settings = fakeSettings({ throwFor: '/home/a/.claude-broken' })
  const fs = memfs()
  const result = await sync({ config: cfg, catalog: fixture, settings, fs })
  assert.deepEqual(result.dirs.map((d) => d.ok), [true, false])
  assert.match(result.dirs[1]?.error ?? '', /cannot read/)
  assert.equal(result.added.length > 0, true)            // only the healthy dir's adds
  assert.equal(settings.merges, 1)
  assert.equal(fs.files.has('/home/a/.claude/agents/glm.md'), true)
  assert.equal(fs.files.has('/home/a/.claude-broken/agents/glm.md'), false)
})

test('sync with zero identities throws', async () => {
  const cfg = { identities: {}, models: rules }
  await assert.rejects(sync({ config: cfg, catalog: fixture, settings: fakeSettings(), fs: memfs() }), /no identities in config/)
})

test('sync never clobbers hand-written agent files', async () => {
  const settings = fakeSettings()
  const fs = memfs()
  fs.files.set('/home/a/.claude/agents/glm.md', 'my hand-written agent\n')
  const result = await sync({ config, catalog: fixture, settings, fs })
  assert.deepEqual(result.protected, ['/home/a/.claude/agents/glm.md'])
  assert.equal(fs.files.get('/home/a/.claude/agents/glm.md'), 'my hand-written agent\n')
  assert.equal(fs.files.has('/home/a/.claude-other/agents/glm.md'), true)
})

test('sync rewrites stale generated agent files', async () => {
  const settings = fakeSettings()
  const fs = memfs()
  fs.files.set('/home/a/.claude/agents/glm.md', '---\nname: glm\n# generated by barrito\n---\nold body\n')
  await sync({ config, catalog: fixture, settings, fs })
  assert.match(fs.files.get('/home/a/.claude/agents/glm.md')!, /zai\/glm-5\.3\[1m\]/)
})

test('render strips a claude-code/ prefix from config agent models', () => {
  const cfg = { models: { agents: { glm: 'claude-code/zai/glm-5.3[1m]' } } }
  const { agents } = render([], cfg)
  const body = agents['glm.md'] ?? ''
  assert.match(body, /^model: claude-code\/zai\/glm-5\.3\[1m\]$/m)
  assert.equal((body.match(/^model: claude-code\//gm) ?? []).length, 1)
})

test('render skips agents whose model is missing from the catalog', () => {
  const agents = render([], { models: { agents: { astra: 'nope/gone' } } }, { catalog: fixture }).agents
  assert.deepEqual(agents, {})
})

test('check lists chain, agent, and pin ids missing from the catalog', () => {
  const cfg = {
    identities: { work: { fallback: ['zai/glm-5.3', 'nope/gone'] } },
    models: { agents: { glm: 'zai/glm-5.3[1m]', astra: 'claude-code/also/gone[1m]' }, pin: ['meta/muse-spark-1.3-contributor'] },
  }
  assert.deepEqual(check(cfg, fixture), ['nope/gone', 'claude-code/also/gone[1m]'])
  assert.deepEqual(check(config, fixture), [])
})

test('select and render stay consistent with catalog.bare and catalog.price', () => {
  const selected = select(fixture, rules)
  const { modelPicker } = render(selected, config)
  modelPicker.options.forEach((o) => {
    assert.ok(catalog.price(fixture, o.model), o.model)
    assert.equal(catalog.bare(o.model).startsWith('claude-code/'), false)
  })
})

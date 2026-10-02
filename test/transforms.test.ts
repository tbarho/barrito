import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from '../src/router/transforms.ts'
import type { TransformExec, TransformState } from '../src/router/transforms.ts'

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'barrito-transforms-'))
const rtkDir = fileURLToPath(new URL('./fixtures/rtk', import.meta.url))
const fx = (name: string, kind: 'raw' | 'filtered') =>
  fs.readFileSync(path.join(rtkDir, `${name}-${kind}.txt`), 'utf8')
const template = (level: string) =>
  fs.readFileSync(fileURLToPath(new URL(`../templates/caveman/${level}.md`, import.meta.url)), 'utf8').replace(/\s+$/, '')

const off = (): TransformState => ({ rtk: false, caveman: 'off' })
const on = (): TransformState => ({ rtk: true, caveman: 'off' })

const make = (o: {
  defaults?: (id: string) => TransformState
  statePath?: string
  exec?: TransformExec
  rtkPath?: string | null
  now?: () => number
} = {}) => create({
  defaults: o.defaults ?? on,
  statePath: o.statePath ?? dir(),
  exec: o.exec ?? (() => null), // a null exec plays rtk: available, never compresses
  rtkPath: o.rtkPath,
  now: o.now,
})

// fake rtk CLI: rewrite maps raw command (argv[1]) → printed rtk command, pipe maps `filter\0content` → output
const fake = (rewrites: Record<string, string | null>, pipes: Record<string, string | null>, calls: string[] = []): TransformExec =>
  (args, input) => {
    calls.push(args.join(' '))
    if (args[0] === 'rewrite') return rewrites[args[1] ?? ''] ?? null
    if (args[0] === 'pipe') return pipes[`${args[2]}\u0000${input}`] ?? null
    return null
  }

// anthropic Messages body: one Bash tool_use (t1) and its tool_result
const bash = (command: string, content: unknown, system?: unknown): Record<string, unknown> => ({
  model: 'claude-sonnet-5',
  system,
  messages: [
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ],
})

const resultText = (body: Record<string, unknown>): string => {
  const messages = body.messages as { role: string; content: { type: string; content: unknown }[] }[]
  const tool = messages.filter((m) => m.role === 'user')[1]!
  return tool.content[0]!.content as string
}

const RW = { 'git diff HEAD~3': 'rtk git diff HEAD~3' }
const diffPipes = (filtered: string) => ({ [`git-diff\u0000${fx('gitdiff', 'raw')}`]: filtered })

test('rewrite → pipe filter mapping; unmapped commands skip rtk entirely', () => {
  const noise = 'x\n'.repeat(1000)
  const cases: [string, string | null, string | null][] = [
    ['git diff HEAD~3', 'rtk git diff HEAD~3', 'git-diff'],
    ['git log --oneline -30', 'rtk git log --oneline -30', 'git-log'],
    ['git status', 'rtk git status', 'git-status'],
    ['grep -rn barrito src', 'rtk grep -rn barrito src', 'grep'],
    ['find src -type f', 'rtk find src -type f', 'find'],
    ['cargo test', 'rtk cargo test', 'cargo-test'],
    ['pytest -q', 'rtk pytest -q', 'pytest'],
    ['go test ./...', 'rtk go test ./...', 'go-test'],
    ['tsc --noEmit', 'rtk tsc --noEmit', 'tsc'],
    ['ruff check .', 'rtk ruff check .', 'ruff-check'],
    ['mypy src', 'rtk mypy src', 'mypy'],
    ['ls -la src', 'rtk ls -la src', null], // rtk has no ls pipe filter
    ['cat foo.txt', 'rtk read foo.txt', null], // read has no pipe filter
    ['echo hi', null, null], // rtk rewrite itself has no equivalent
  ]
  const calls: string[] = []
  for (const [command, rewritten, filter] of cases) {
    const pipes = filter === null ? {} : { [`${filter}\u0000${noise}`]: 'y' }
    const t = make({ exec: fake({ [command]: rewritten }, pipes, calls) })
    const { applied } = t.anthropic('personal', bash(command, noise))
    assert.equal(applied.rtk, filter === null ? 0 : 1, command)
  }
  const piped = calls.filter((c) => c.startsWith('pipe'))
  assert.deepEqual(piped, cases.filter(([, , f]) => f !== null).map(([, , f]) => `pipe --filter ${f}`))
})

test('captured rtk fixtures: tool_result replaced, saved bytes counted', () => {
  const pairs: [string, string, string, string][] = [
    ['git diff HEAD~3', 'rtk git diff HEAD~3', 'git-diff', 'gitdiff'],
    ['git log -30', 'rtk git log -30', 'git-log', 'gitlog'],
    ['grep -rn barrito src/router src/cli', 'rtk grep -rn barrito src/router src/cli', 'grep', 'grep'],
    ['find src test scripts bin packaging -type f', 'rtk find src test scripts bin packaging -type f', 'find', 'find'],
  ]
  for (const [command, rewritten, filter, name] of pairs) {
    const raw = fx(name, 'raw')
    const filtered = fx(name, 'filtered')
    const t = make({ exec: fake({ [command]: rewritten }, { [`${filter}\u0000${raw}`]: filtered }) })
    const { body, applied } = t.anthropic('personal', bash(command, raw))
    assert.equal(applied.rtk, 1, name)
    assert.equal(applied.saved, raw.length - filtered.length, name)
    assert.equal(resultText(body), filtered, name)
  }
})

test('tool_results under 1500 bytes are left alone, rtk never invoked', () => {
  const calls: string[] = []
  const short = fx('gitstatus', 'raw') // 112 bytes
  const t = make({ exec: fake({ 'git status': 'rtk git status' }, {}, calls) })
  const { body, applied } = t.anthropic('personal', bash('git status', short))
  assert.equal(applied.rtk, 0)
  assert.equal(applied.saved, 0)
  assert.equal(resultText(body), short)
  assert.equal(calls.length, 0)
})

test('rtk failure, empty output, or no savings → raw content kept', () => {
  const raw = fx('gitdiff', 'raw')
  const tries: (string | null)[] = [null, '', raw, `${raw} even bigger now`]
  for (const out of tries) {
    const t = make({ exec: fake(RW, { [`git-diff\u0000${raw}`]: out }) })
    const { body, applied } = t.anthropic('personal', bash('git diff HEAD~3', raw))
    assert.equal(applied.rtk, 0)
    assert.equal(resultText(body), raw)
  }
})

test('determinism: same request twice → byte-identical body, rtk runs once (cache)', () => {
  const raw = fx('gitdiff', 'raw')
  const calls: string[] = []
  const t = make({ exec: fake(RW, diffPipes(fx('gitdiff', 'filtered')), calls) })
  const pristine = bash('git diff HEAD~3', raw)
  const first = t.anthropic('personal', bash('git diff HEAD~3', raw))
  const second = t.anthropic('personal', bash('git diff HEAD~3', raw))
  assert.equal(JSON.stringify(first.body), JSON.stringify(second.body))
  assert.deepEqual(first.applied, second.applied)
  assert.equal(calls.filter((c) => c.startsWith('rewrite')).length, 1)
  assert.equal(calls.filter((c) => c.startsWith('pipe')).length, 1)
  assert.deepEqual(pristine, bash('git diff HEAD~3', raw)) // caller's body never mutated
})

test('already rtk-filtered output is not compressed again', () => {
  const calls: string[] = []
  const filtered = fx('grep', 'filtered') // carries rtk markers ("133 matches in 23F:", "[file] …")
  const t = make({ exec: fake({ 'grep -rn barrito src': 'rtk grep -rn barrito src' }, {}, calls) })
  const { body, applied } = t.anthropic('personal', bash('grep -rn barrito src', filtered))
  assert.equal(applied.rtk, 0)
  assert.equal(resultText(body), filtered)
  assert.equal(calls.length, 0)
})

test('only tool_result text and system ever change', () => {
  const raw = fx('gitdiff', 'raw')
  const t = make({ exec: fake(RW, diffPipes(fx('gitdiff', 'filtered'))), defaults: () => ({ rtk: true, caveman: 'ultra' }) })
  const { body } = t.anthropic('personal', bash('git diff HEAD~3', raw, 'keep me'))
  const input = bash('git diff HEAD~3', raw, 'keep me')
  const messages = body.messages as unknown[]
  const original = input.messages as unknown[]
  assert.equal(body.model, input.model)
  assert.deepEqual(messages[0], original[0])
  assert.deepEqual(messages[1], original[1]) // tool_use untouched
  assert.deepEqual(messages[3], original[3])
  assert.equal(body.system, 'keep me\n\n' + template('ultra'))
})

test('caveman: string system, array system with cache_control, absent system', () => {
  const mk = (level: TransformState['caveman']) =>
    make({ defaults: () => ({ rtk: false, caveman: level }) })
  const string = mk('full').anthropic('x', bash('ls', 'out', 'be helpful'))
  assert.equal(string.body.system, 'be helpful\n\n' + template('full'))
  const absent = mk('full').anthropic('x', bash('ls', 'out', undefined))
  assert.equal(absent.body.system, template('full'))

  const blocks = [{ type: 'text', text: 'cached head', cache_control: { type: 'ephemeral' } }]
  const array = mk('lite').anthropic('x', { ...bash('ls', 'out', blocks) })
  const sys = array.body.system as Record<string, unknown>[]
  assert.equal(sys.length, 2)
  assert.deepEqual(sys[0], { type: 'text', text: 'cached head', cache_control: { type: 'ephemeral' } })
  assert.deepEqual(sys[1], { type: 'text', text: template('lite') }) // appended after, no cache_control added
  assert.equal(array.applied.caveman, 'lite')

  const untouched = mk('off').anthropic('x', bash('ls', 'out', 'be helpful'))
  assert.equal(untouched.body.system, 'be helpful')
  assert.ok(new Set(['lite', 'full', 'ultra'].map((l) => template(l))).size === 3)
})

test('openai shape: tool messages paired via tool_call_id, caveman lands on system/developer', () => {
  const raw = fx('gitdiff', 'raw')
  const filtered = fx('gitdiff', 'filtered')
  const oa = (messages: unknown[]): Record<string, unknown> => ({ model: 'gpt-5', messages })

  const chat = (system?: unknown, args = '{"command":"git diff HEAD~3"}'): unknown[] => [
    ...(system === undefined ? [] : [system]),
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: 'calling bash', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: args } }] },
    { role: 'tool', tool_call_id: 'c1', content: raw },
  ]

  const t = make({ defaults: () => ({ rtk: true, caveman: 'full' }), exec: fake(RW, diffPipes(filtered)) })
  const first = t.openai('personal', oa(chat({ role: 'system', content: 'be helpful' })))
  const msgs = first.body.messages as Record<string, unknown>[]
  assert.equal((msgs[3] as { content: string }).content, filtered)
  assert.equal((msgs[0] as { content: string }).content, 'be helpful\n\n' + template('full'))
  assert.equal(first.applied.rtk, 1)
  assert.equal(first.applied.saved, raw.length - filtered.length)

  const developer = t.openai('personal', oa(chat({ role: 'developer', content: 'sysprompt' })))
  assert.equal(((developer.body.messages as Record<string, unknown>[])[0] as { content: string }).content, 'sysprompt\n\n' + template('full'))

  const none = t.openai('personal', oa(chat()))
  const prepended = none.body.messages as Record<string, unknown>[]
  assert.deepEqual(prepended[0], { role: 'system', content: template('full') })

  const bad = t.openai('personal', oa(chat({ role: 'system', content: 'be helpful' }, '{not json')))
  assert.equal(((bad.body.messages as Record<string, unknown>[])[3] as { content: string }).content, raw)
  assert.equal(bad.applied.rtk, 0)
})

test('toggles: set overrides defaults, persists to transforms.json, null clears', () => {
  const statePath = dir()
  const t = make({ statePath, defaults: off })
  assert.deepEqual(t.state('work'), { rtk: false, caveman: 'off' })
  assert.deepEqual(t.set('work', { rtk: true, caveman: 'lite' }), { rtk: true, caveman: 'lite' })
  assert.deepEqual(t.state('work'), { rtk: true, caveman: 'lite' })
  assert.deepEqual(t.state('personal'), { rtk: false, caveman: 'off' }) // other ids keep defaults
  const persisted = JSON.parse(fs.readFileSync(path.join(statePath, 'transforms.json'), 'utf8'))
  assert.deepEqual(persisted.overrides.work, { rtk: true, caveman: 'lite' })

  const reloaded = make({ statePath, defaults: off })
  assert.deepEqual(reloaded.state('work'), { rtk: true, caveman: 'lite' })
  assert.deepEqual(reloaded.set('work', { caveman: 'ultra' }), { rtk: true, caveman: 'ultra' }) // partial patch merges
  assert.deepEqual(reloaded.set('work', null), { rtk: false, caveman: 'off' }) // cleared → defaults again
  assert.equal(JSON.parse(fs.readFileSync(path.join(statePath, 'transforms.json'), 'utf8')).overrides.work, undefined)
  assert.throws(() => reloaded.set('work', { caveman: 'mega' as TransformState['caveman'] }))
  assert.throws(() => reloaded.set('work', { rtk: 'yes' as unknown as boolean }))
})

test('stats: saved bytes and compressed counts per identity per local day', () => {
  const raw = fx('gitdiff', 'raw')
  const grepRaw = fx('grep', 'raw')
  let t = new Date(2026, 9, 1, 12).getTime()
  const tr = make({
    now: () => t,
    exec: fake(
      { 'git diff HEAD~3': 'rtk git diff HEAD~3', 'grep -rn barrito src': 'rtk grep -rn barrito src' },
      { [`git-diff\u0000${raw}`]: fx('gitdiff', 'filtered'), [`grep\u0000${grepRaw}`]: fx('grep', 'filtered') },
    ),
  })
  tr.anthropic('personal', bash('git diff HEAD~3', raw))
  tr.openai('work', {
    model: 'gpt-5',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"grep -rn barrito src"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: grepRaw },
    ],
  })
  const saved = raw.length - fx('gitdiff', 'filtered').length
  const grepSaved = grepRaw.length - fx('grep', 'filtered').length
  assert.deepEqual(tr.stats(), { personal: { saved, compressed: 1 }, work: { saved: grepSaved, compressed: 1 } })

  t = new Date(2026, 9, 2, 0, 30).getTime() // local midnight rollover
  tr.anthropic('personal', bash('git diff HEAD~3', raw))
  assert.deepEqual(tr.stats(), { personal: { saved, compressed: 1 } })
})

test('stats persist with the state file', () => {
  const statePath = dir()
  const raw = fx('gitdiff', 'raw')
  const saved = raw.length - fx('gitdiff', 'filtered').length
  make({ statePath, exec: fake(RW, diffPipes(fx('gitdiff', 'filtered'))), now: () => 1000 })
    .anthropic('personal', bash('git diff HEAD~3', raw))
  const again = make({ statePath, now: () => 1000 })
  assert.deepEqual(again.stats(), { personal: { saved, compressed: 1 } })
})

test('available(): injected exec counts, rtkPath null forces rtk off, path is honored', () => {
  assert.equal(make().available(), true)
  assert.equal(make({ rtkPath: null }).available(), false)
  assert.equal(make({ rtkPath: '/opt/rtk' }).available(), true)
  const raw = fx('gitdiff', 'raw')
  const off = make({ rtkPath: null, exec: fake(RW, diffPipes(fx('gitdiff', 'filtered'))) })
  const { body, applied } = off.anthropic('personal', bash('git diff HEAD~3', raw))
  assert.equal(applied.rtk, 0)
  assert.equal(resultText(body), raw)
})

test('both off: body passes through untouched, same object', () => {
  const t = make({ defaults: off, exec: fake(RW, diffPipes(fx('gitdiff', 'filtered'))) })
  const input = bash('git diff HEAD~3', fx('gitdiff', 'raw'), 'be helpful')
  const { body, applied } = t.anthropic('personal', input)
  assert.equal(body, input)
  assert.deepEqual(applied, { rtk: 0, caveman: 'off', saved: 0 })
})

test('real rtk binary, when installed (skipped otherwise)', (t) => {
  const probe = create({ defaults: on, statePath: dir() }) // no exec → resolves rtk from PATH
  if (!probe.available()) return t.skip('rtk not installed')
  const raw = fx('gitdiff', 'raw')
  const { body, applied } = probe.anthropic('personal', bash('git diff HEAD~3', raw))
  assert.equal(applied.rtk, 1)
  assert.ok(applied.saved > 0)
  assert.ok(resultText(body).length < raw.length)
  const again = probe.anthropic('personal', bash('git diff HEAD~3', raw))
  assert.equal(JSON.stringify(again.body), JSON.stringify(body)) // real rtk output is deterministic too
})

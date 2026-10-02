import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { read, merge, remove, lastWarnings } from '../src/settings.ts'

const dir = (): string => mkdtempSync(path.join(os.tmpdir(), 'barrito-settings-'))
const file = (d: string): string => path.join(d, 'settings.json')
const onDisk = (d: string): string => readFileSync(file(d), 'utf8')

test('read: missing file → {}', () => {
  assert.deepEqual(read(dir()), {})
})

test('read: existing file → object', () => {
  const d = dir()
  writeFileSync(file(d), '{ "statusLine": { "type": "command", "command": "tsline" } }\n')
  assert.deepEqual(read(d), { statusLine: { type: 'command', command: 'tsline' } })
})

test('read: keeps known shapes, passes unknown keys through', () => {
  const d = dir()
  writeFileSync(file(d), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141' },
    statusLine: { type: 'command', command: 'barrito statusline', padding: 1 },
    modelPicker: { options: [{ model: 'claude-code/zai/glm-5.3', label: 'GLM', description: 'cheap' }] },
    permissions: { allow: ['Bash(git:*)'] },
  }))
  assert.deepEqual(read(d), {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141' },
    statusLine: { type: 'command', command: 'barrito statusline', padding: 1 },
    modelPicker: { options: [{ model: 'claude-code/zai/glm-5.3', label: 'GLM', description: 'cheap' }] },
    permissions: { allow: ['Bash(git:*)'] },
  })
})

test('read: drops unrecognizable env/statusLine/modelPicker shapes and bad rows', () => {
  const d = dir()
  writeFileSync(file(d), JSON.stringify({
    env: { OK: 'y', BAD: 1 },
    statusLine: { type: 'command' },
    modelPicker: {
      options: [
        { model: 'claude-code/zai/glm-5.3', label: 'GLM', description: 'cheap' },
        { model: 'nope' },
        'junk',
      ],
    },
  }))
  assert.deepEqual(read(d), {
    env: { OK: 'y' },
    modelPicker: { options: [{ model: 'claude-code/zai/glm-5.3', label: 'GLM', description: 'cheap' }] },
  })
})

test('read: corrupt JSON throws with path', () => {
  const d = dir()
  writeFileSync(file(d), '{ nope')
  assert.throws(() => read(d), new RegExp(path.join(d, 'settings.json').replaceAll('/', '\\/')))
})

test('merge: deep merge objects, arrays replaced wholesale, atomic, 2-space + newline', () => {
  const d = dir()
  writeFileSync(file(d), JSON.stringify({ a: { b: 1 }, list: [1, 2], keep: true }, null, 2) + '\n')
  const merged = merge(d, { a: { c: 2 }, list: [3] })
  assert.deepEqual(merged, { a: { b: 1, c: 2 }, list: [3], keep: true })
  assert.equal(onDisk(d), JSON.stringify({ a: { b: 1, c: 2 }, list: [3], keep: true }, null, 2) + '\n')
  assert.equal(existsSync(`${file(d)}.tmp`), false)
})

test('merge: into a fresh dir creates it', () => {
  const d = path.join(dir(), 'nested', 'claude')
  const merged = merge(d, { statusLine: { type: 'command', command: 'barrito statusline' } })
  assert.deepEqual(merged, { statusLine: { type: 'command', command: 'barrito statusline' } })
  assert.equal(onDisk(d), JSON.stringify(merged, null, 2) + '\n')
})

test('remove: dotted paths, prunes emptied parents, returns result', () => {
  const d = dir()
  merge(d, {
    statusLine: { type: 'command', command: 'barrito statusline' },
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141', FOO: 'y' },
  })
  const left = remove(d, ['statusLine', 'env.ANTHROPIC_BASE_URL'])
  assert.deepEqual(left, { env: { FOO: 'y' } })
  assert.deepEqual(read(d), { env: { FOO: 'y' } })

  const gone = remove(d, 'env.FOO')
  assert.deepEqual(gone, {})
  assert.equal(onDisk(d), JSON.stringify({}, null, 2) + '\n')
})

test('remove: missing keys are a no-op; missing file → {} and no write', () => {
  const d = dir()
  merge(d, { env: { FOO: 'y' } })
  const left = remove(d, 'nope.here')
  assert.deepEqual(left, { env: { FOO: 'y' } })

  const empty = dir()
  assert.deepEqual(remove(empty, 'env.FOO'), {})
  assert.equal(existsSync(file(empty)), false)
})

const badFiles = (d: string): string[] => readdirSync(d).filter((f) => f.startsWith('settings.json.bad-'))

test('merge: corrupt settings.json is backed up, fresh start, warning recorded', () => {
  const d = dir()
  writeFileSync(file(d), '{ nope')
  const merged = merge(d, { statusLine: { type: 'command', command: 'barrito statusline' } })
  assert.deepEqual(merged, { statusLine: { type: 'command', command: 'barrito statusline' } })
  assert.equal(onDisk(d), JSON.stringify(merged, null, 2) + '\n')
  assert.equal(badFiles(d).length, 1)
  assert.equal(readFileSync(path.join(d, badFiles(d)[0] ?? ''), 'utf8'), '{ nope')
  assert.equal(lastWarnings.length, 1)
  assert.match(lastWarnings[0] ?? '', /unreadable.*moved to.*settings\.json\.bad-/)
})

test('remove: corrupt settings.json (valid JSON, wrong shape) is backed up, continues from {}', () => {
  const d = dir()
  writeFileSync(file(d), '[1,2]')
  const left = remove(d, 'env.FOO')
  assert.deepEqual(left, {})
  assert.equal(onDisk(d), JSON.stringify({}, null, 2) + '\n')
  assert.equal(badFiles(d).length, 1)
  assert.equal(lastWarnings.length, 1)
})

test('lastWarnings clears on every call; healthy files leave it empty', () => {
  const d = dir()
  merge(d, { a: { b: 1 } })
  assert.equal(lastWarnings.length, 0)
  remove(d, 'a.b')
  assert.equal(lastWarnings.length, 0)
})

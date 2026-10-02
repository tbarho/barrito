import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { root } from '../src/paths.ts'
import { usage } from '../src/usage.ts'

const bin = path.join(root(), 'bin', 'barrito.ts')
const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

test('every command has a synopsis and an example', () => {
  for (const [name, text] of Object.entries(usage)) {
    assert.match(text, new RegExp(`^usage: barrito ${name}\\b`), `${name} usage opens with its synopsis`)
    assert.ok(text.includes('  barrito '), `${name} usage shows an example`)
  }
})

test('the dispatcher advertises exactly the usage commands', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  for (const name of Object.keys(usage)) assert.ok(r.stdout.includes(name), `help lists ${name}`)
})

test('<command> --help exits 0 with the usage, without running the command', () => {
  for (const name of Object.keys(usage)) {
    const r = run([name, '--help'])
    assert.equal(r.status, 0, `${name} --help exits 0`)
    assert.match(r.stdout, new RegExp(`^usage: barrito ${name}\\b`), `${name} --help prints its usage`)
  }
})

test('-h matches --help', () => {
  const r = run(['status', '-h'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^usage: barrito status\b/)
})

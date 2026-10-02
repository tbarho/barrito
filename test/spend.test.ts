import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { create } from '../src/router/spend.ts'
import type { Price } from '../src/types.ts'

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'barrito-spend-'))

const table: Record<string, Price> = {
  'zai/glm-5.3': { input: 3e-6, output: 15e-6, input_cache_read: 0.3e-6 },
  'deepseek/deepseek-v4.1-flash': { input: 0.5e-6, output: 2e-6, input_cache_read: 0.05e-6 },
}
const prices = (id: string): Price | null => table[id] ?? null

test('cost math: input + output + cache read + cache creation at 1.25× input', () => {
  const spend = create({ prices, statePath: dir(), now: () => 0 })
  spend.record('personal', 'zai/glm-5.3', {
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 200,
  })
  const usd = 1000 * 3e-6 + 100 * 15e-6 + 500 * 0.3e-6 + 200 * 3e-6 * 1.25
  assert.equal(spend.today().personal, usd)
})

test('unpriced (direct) models cost nothing', () => {
  const spend = create({ prices, statePath: dir(), now: () => 0 })
  assert.equal(spend.record('personal', 'claude-sonnet-5', { input_tokens: 999, output_tokens: 999 }), 0)
  assert.deepEqual(spend.today(), {})
})

test('sums per identity and accumulates', () => {
  const spend = create({ prices, statePath: dir(), now: () => 0 })
  spend.record('personal', 'zai/glm-5.3', { input_tokens: 1000 })
  spend.record('personal', 'zai/glm-5.3', { input_tokens: 1000 })
  spend.record('work', 'deepseek/deepseek-v4.1-flash', { output_tokens: 1000 })
  assert.deepEqual(spend.today(), { personal: 0.006, work: 0.002 })
})

test('today() resets at local midnight', () => {
  let t = new Date(2026, 9, 1, 23, 59, 30).getTime()
  const spend = create({ prices, statePath: dir(), now: () => t })
  spend.record('personal', 'zai/glm-5.3', { input_tokens: 1000 })
  assert.equal(spend.today().personal, 0.003)
  t = new Date(2026, 9, 2, 0, 0, 30).getTime()
  spend.record('personal', 'zai/glm-5.3', { input_tokens: 2000 })
  assert.deepEqual(spend.today(), { personal: 0.006 })
})

test('spend persists across create()', () => {
  const statePath = dir()
  const first = create({ prices, statePath, now: () => 1000 })
  first.record('personal', 'zai/glm-5.3', { input_tokens: 1000, output_tokens: 100 })
  const second = create({ prices, statePath, now: () => 2000 })
  assert.deepEqual(second.today(), { personal: 0.0045 })
})

test('corrupt spend.json is set aside and starts fresh', () => {
  const statePath = dir()
  fs.writeFileSync(path.join(statePath, 'spend.json'), 'not json {{{')
  const spend = create({ prices, statePath, now: () => 1000 })
  assert.deepEqual(spend.today(), {})
  assert.ok(fs.readdirSync(statePath).some((f) => f.startsWith('spend.json.bad-')))
  spend.record('personal', 'zai/glm-5.3', { input_tokens: 1000 })
  assert.equal(spend.today().personal, 0.003)
})

test('missing usage fields default to zero', () => {
  const spend = create({ prices, statePath: dir(), now: () => 0 })
  spend.record('personal', 'zai/glm-5.3', { output_tokens: 10 })
  assert.equal(spend.today().personal, Math.round(10 * 15e-6 * 1e6) / 1e6)
})

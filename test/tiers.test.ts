import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { create } from '../src/router/tiers.ts'
import type { TiersConfig } from '../src/types.ts'

const config: TiersConfig = {
  identities: {
    personal: { fallback: ['zai/glm-5.3', 'deepseek/deepseek-v4.1-flash'] },
    work: { fallback: ['openai/gpt-6-astra'] },
    bare: { fallback: ['zai/glm-5.3'] },
    none: { fallback: [] },
  },
  models: { labels: {} },
}

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'barrito-tiers-'))

const setup = ({ cfg = config, start = 0 }: { cfg?: TiersConfig; start?: number } = {}) => {
  const notes: { title: string; message: string }[] = []
  let t = start
  const tiers = create({
    config: cfg,
    statePath: dir(),
    notify: (title, message) => notes.push({ title, message }),
    now: () => t,
  })
  const tick = (ms: number) => { t += ms }
  const at = (ms: number) => { t = ms }
  return { tiers, notes, tick, at }
}

test('quota 429 retries first chain entry and notifies once', () => {
  const { tiers, notes } = setup()
  const r = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: {
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '3600',
    },
  })
  assert.deepEqual(r, { retry: { to: 'gateway', model: 'zai/glm-5.3', reason: 'quota' } })
  assert.equal(notes.length, 1)
  assert.equal(notes[0]?.title, 'barrito')
  assert.match(notes[0]?.message ?? '', /^personal — Max spent\. Now GLM 5\.3 on API credits until \d\d:\d\d\.$/)
  const snap = tiers.snapshot().personal
  assert.equal(snap?.tier, 'fallback')
  assert.equal(snap?.reason, 'quota')
  assert.equal(snap?.resetAt, 3600 * 1000)
})

test('after quota, route sends to the current chain entry', () => {
  const { tiers } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '60' },
  })
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), {
    to: 'gateway', model: 'zai/glm-5.3', reason: 'quota',
  })
})

test('reset passed → route probes direct', () => {
  const { tiers, at } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '60' },
  })
  at(59_999)
  assert.equal(tiers.route('personal', 'claude-sonnet-5').to, 'gateway')
  at(60_000)
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
})

test('direct 2xx returns to max, records utilization, notifies "Max is back"', () => {
  const { tiers, notes, at } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '60' },
  })
  at(60_000)
  tiers.route('personal', 'claude-sonnet-5')
  const r = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 200,
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-5h-reset': '100000',
    },
  })
  assert.deepEqual(r, { retry: null })
  const snap = tiers.snapshot().personal
  assert.equal(snap?.tier, 'max')
  assert.equal(snap?.util5h, 0.42)
  assert.equal(snap?.util7d, 0.1)
  assert.equal(snap?.resetAt, 100000 * 1000)
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
  assert.equal(notes.length, 2)
  assert.equal(notes[1]?.message, 'personal — Max is back.')
})

test('2xx with limited status does not transition (it answered)', () => {
  const { tiers, notes, at } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '60' },
  })
  at(60_000)
  const r = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 200,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '30' },
  })
  assert.deepEqual(r, { retry: null })
  const snap = tiers.snapshot().personal
  assert.equal(snap?.tier, 'fallback')
  assert.equal(snap?.reason, 'quota')
  assert.equal(snap?.resetAt, 60_000 + 30_000)
  assert.equal(notes.length, 1)
})

test('representative claim picks 7d vs 5h reset', () => {
  const { tiers } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: {
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '111',
      'anthropic-ratelimit-unified-7d-reset': '999',
      'anthropic-ratelimit-unified-reset': '555',
    },
  })
  assert.equal(tiers.snapshot().personal?.resetAt, 999 * 1000)
})

test('no claim: limited window reset wins, 7d before 5h', () => {
  const a = setup()
  a.tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: {
      'anthropic-ratelimit-unified-5h-status': 'limited',
      'anthropic-ratelimit-unified-5h-reset': '111',
      'anthropic-ratelimit-unified-7d-status': 'limited',
      'anthropic-ratelimit-unified-7d-reset': '999',
      'anthropic-ratelimit-unified-reset': '555',
    },
  })
  assert.equal(a.tiers.snapshot().personal?.resetAt, 999 * 1000)

  const b = setup()
  b.tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: {
      'anthropic-ratelimit-unified-5h-status': 'limited',
      'anthropic-ratelimit-unified-5h-reset': '111',
      'anthropic-ratelimit-unified-reset': '555',
    },
  })
  assert.equal(b.tiers.snapshot().personal?.resetAt, 111 * 1000)
})

test('claim naming a window with no reset header falls through', () => {
  const { tiers } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: {
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'anthropic-ratelimit-unified-5h-status': 'limited',
      'anthropic-ratelimit-unified-5h-reset': '111',
    },
  })
  assert.equal(tiers.snapshot().personal?.resetAt, 111 * 1000)
})

test('header-less 429 is a blip: one free direct retry, no state change, no notify', () => {
  const { tiers, notes } = setup()
  const r = tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} })
  assert.deepEqual(r, { retry: { to: 'direct', delay: 0 } })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
  assert.equal(notes.length, 0)
})

test('header-less 429 with retry-after ≤ 5s honors it; over 5s retries immediately', () => {
  const a = setup()
  const short = a.tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429, headers: { 'retry-after': '2' },
  })
  assert.deepEqual(short, { retry: { to: 'direct', delay: 2000 } })

  const b = setup()
  const long = b.tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429, headers: { 'retry-after': '30' },
  })
  assert.deepEqual(long, { retry: { to: 'direct', delay: 0 } })
})

test('two header-less 429s enter throttle: ≤ 5 min reset, one notification', () => {
  const { tiers, notes } = setup()
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} })
  const r = tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} })
  assert.deepEqual(r, { retry: { to: 'gateway', model: 'zai/glm-5.3', reason: 'throttle' } })
  const snap = tiers.snapshot().personal
  assert.equal(snap?.tier, 'fallback')
  assert.equal(snap?.reason, 'throttle')
  assert.equal(snap?.model, 'zai/glm-5.3')
  assert.equal(snap?.resetAt, 60_000) // no retry-after → 60s floor
  assert.ok((snap?.resetAt ?? 0) <= 5 * 60_000)
  assert.equal(notes.length, 1)
  assert.equal(notes[0]?.message, 'personal — Anthropic throttling. GLM 5.3 on API credits for a few minutes.')
})

test('throttle reset honors retry-after, floored at 60s, capped at 5 min', () => {
  const cases: [string, number][] = [['3', 60_000], ['120', 120_000], ['3600', 300_000]]
  for (const [retryAfter, expected] of cases) {
    const { tiers } = setup()
    tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} })
    tiers.observe('personal', {
      to: 'direct', model: 'claude-sonnet-5', status: 429, headers: { 'retry-after': retryAfter },
    })
    assert.equal(tiers.snapshot().personal?.resetAt, expected, `retry-after ${retryAfter}`)
  }
})

test('throttle probe: route goes direct after the reset; success returns to max', () => {
  const { tiers, notes, at } = setup()
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} })
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} })
  at(59_999)
  assert.equal(tiers.route('personal', 'claude-sonnet-5').to, 'gateway')
  at(60_000)
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
  const r = tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 200, headers: {} })
  assert.deepEqual(r, { retry: null })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
  assert.equal(notes.length, 2)
  assert.equal(notes[1]?.message, 'personal — Max is back.')
})

test('header-confirmed 429 stays quota with the header window reset', () => {
  const a = setup()
  a.tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '30' },
  })
  const snapA = a.tiers.snapshot().personal
  assert.equal(snapA?.reason, 'quota')
  assert.equal(snapA?.resetAt, 30_000) // unified-status rejected but no reset header → retry-after

  const b = setup()
  b.tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': '12345' },
  })
  assert.equal(b.tiers.snapshot().personal?.reason, 'quota')
  assert.equal(b.tiers.snapshot().personal?.resetAt, 12345 * 1000)
})

test('429 with allowed status is a blip: retry direct once, no transition, no notify', () => {
  const { tiers, notes } = setup()
  const r = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'allowed', 'retry-after': '2' },
  })
  assert.deepEqual(r, { retry: { to: 'direct', delay: 2000 } })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
  assert.equal(notes.length, 0)
})

test('blip retry with retry-after over 5s goes immediately (no long stall)', () => {
  const { tiers } = setup()
  const r = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-status': 'allowed', 'retry-after': '7' },
  })
  assert.deepEqual(r, { retry: { to: 'direct', delay: 0 } })
})

test('a 429-allowed blip does not consume the free direct retry a later 5xx earns', () => {
  const { tiers, notes } = setup()
  const blip = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'allowed' },
  })
  assert.deepEqual(blip, { retry: { to: 'direct', delay: 0 } })
  const outage = tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 503, headers: {} })
  assert.deepEqual(outage, { retry: { to: 'direct', delay: 0 } })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
  assert.equal(notes.length, 0)
})

test('an outage free retry does not consume the blip direct retry a later 429 earns', () => {
  const { tiers } = setup()
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  const blip = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'allowed' },
  })
  assert.deepEqual(blip, { retry: { to: 'direct', delay: 0 } })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
})

test('second consecutive 429 (even allowed) enters throttle so the turn never fails', () => {
  const { tiers, notes } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'allowed', 'retry-after': '2' },
  })
  const r = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'allowed', 'retry-after': '3' },
  })
  assert.deepEqual(r, { retry: { to: 'gateway', model: 'zai/glm-5.3', reason: 'throttle' } })
  const snap = tiers.snapshot().personal
  assert.equal(snap?.tier, 'fallback')
  assert.equal(snap?.reason, 'throttle')
  assert.equal(snap?.resetAt, 60_000) // retry-after 3s floors at 60s
  assert.equal(notes.length, 1)
})

test('blip retry that succeeds keeps max, silently', () => {
  const { tiers, notes } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-status': 'allowed' },
  })
  assert.deepEqual(tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 200, headers: {} }), { retry: null })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
  assert.equal(notes.length, 0)
})

test('single direct failure retries direct once, no state change, no notify', () => {
  const { tiers, notes } = setup()
  const r = tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 503, headers: {} })
  assert.deepEqual(r, { retry: { to: 'direct', delay: 0 } })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
  assert.equal(notes.length, 0)
})

test('two consecutive direct failures enter outage and notify once', () => {
  const { tiers, notes, tick } = setup()
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  const r = tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  assert.deepEqual(r, { retry: { to: 'gateway', model: 'zai/glm-5.3', reason: 'outage' } })
  const snap = tiers.snapshot().personal
  assert.equal(snap?.tier, 'fallback')
  assert.equal(snap?.reason, 'outage')
  assert.equal(snap?.model, 'zai/glm-5.3')
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), {
    to: 'gateway', model: 'zai/glm-5.3', reason: 'outage',
  })
  assert.equal(notes.length, 1)
  assert.match(notes[0]?.message ?? '', /^personal — Anthropic unreachable\. Now GLM 5\.3 on API credits\.$/)
  tick(30_000)
  assert.equal(tiers.route('personal', 'claude-sonnet-5').to, 'gateway')
})

test('a direct success (even limited) between failures resets the window', () => {
  const { tiers, notes } = setup()
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 503, headers: {} })
  const r = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 200,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited' },
  })
  assert.deepEqual(r, { retry: null })
  assert.deepEqual(tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 503, headers: {} }), { retry: { to: 'direct', delay: 0 } })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
  assert.equal(notes.length, 0)
})

test('half-open after 60s: probe direct, success returns to max', () => {
  const { tiers, notes, tick } = setup()
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  tick(59_999)
  assert.equal(tiers.route('personal', 'claude-sonnet-5').to, 'gateway')
  tick(1)
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
  assert.deepEqual(tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 200, headers: {} }), { retry: null })
  assert.equal(tiers.snapshot().personal?.tier, 'max')
  assert.equal(notes.length, 2)
})

test('failed probe backs off ×2 capped at 15m', () => {
  const { tiers, at } = setup()
  at(1000)
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  let halfOpen = 1000 + 60_000
  const gaps = [120_000, 240_000, 480_000, 900_000, 900_000]
  for (const gap of gaps) {
    at(halfOpen)
    assert.equal(tiers.route('personal', 'claude-sonnet-5').to, 'direct')
    tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
    halfOpen = halfOpen + gap
    at(halfOpen - 1)
    assert.equal(tiers.route('personal', 'claude-sonnet-5').to, 'gateway')
  }
  at(halfOpen)
  assert.equal(tiers.route('personal', 'claude-sonnet-5').to, 'direct')
})

test('chain walk: failed hop → next entry, exhaustion → null, then fresh walk', () => {
  const { tiers } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '3600' },
  })
  const a = tiers.observe('personal', { to: 'gateway', model: 'zai/glm-5.3', status: 429, headers: {} })
  assert.deepEqual(a, { retry: { to: 'gateway', model: 'deepseek/deepseek-v4.1-flash', reason: 'quota' } })
  assert.equal(tiers.snapshot().personal?.model, 'deepseek/deepseek-v4.1-flash')
  const b = tiers.observe('personal', { to: 'gateway', model: 'deepseek/deepseek-v4.1-flash', status: 529, headers: {} })
  assert.deepEqual(b, { retry: null })
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), {
    to: 'gateway', model: 'zai/glm-5.3', reason: 'quota',
  })
})

test('half-open probe failure resumes the chain where it left off', () => {
  const { tiers, at } = setup()
  at(1000)
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  tiers.observe('personal', { to: 'gateway', model: 'zai/glm-5.3', status: 500, headers: {} })
  at(1000 + 60_000)
  assert.equal(tiers.route('personal', 'claude-sonnet-5').to, 'direct')
  const r = tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} })
  assert.deepEqual(r, { retry: { to: 'gateway', model: 'deepseek/deepseek-v4.1-flash', reason: 'outage' } })
})

test('chain membership ignores [1m] suffixes; returned models stay raw', () => {
  const cfg = {
    identities: { personal: { fallback: ['zai/glm-5.3[1m]', 'deepseek/deepseek-v4.1-flash'] } },
    models: { labels: {} },
  }
  const { tiers, notes } = setup({ cfg })
  const r = tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '3600' },
  })
  assert.deepEqual(r, { retry: { to: 'gateway', model: 'zai/glm-5.3[1m]', reason: 'quota' } })
  assert.match(notes[0]?.message ?? '', /Now GLM 5\.3 on API credits/)
  // the hop reports the model without the suffix — still entry 0
  const a = tiers.observe('personal', { to: 'gateway', model: 'zai/glm-5.3', status: 429, headers: {} })
  assert.deepEqual(a, { retry: { to: 'gateway', model: 'deepseek/deepseek-v4.1-flash', reason: 'quota' } })
  assert.equal(tiers.snapshot().personal?.model, 'deepseek/deepseek-v4.1-flash')
})

test('stale persisted model (chain changed) falls back to the head on route', () => {
  const statePath = dir()
  const cfgA = { identities: { personal: { fallback: ['zai/glm-5.3', 'deepseek/deepseek-v4.1-flash'] } }, models: {} }
  const a = create({ config: cfgA, statePath, notify: () => {}, now: () => 0 })
  a.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '3600' },
  })
  a.observe('personal', { to: 'gateway', model: 'zai/glm-5.3', status: 500, headers: {} })
  const cfgB = { identities: { personal: { fallback: ['openai/gpt-6-astra'] } }, models: {} }
  const b = create({ config: cfgB, statePath, notify: () => {}, now: () => 1 })
  assert.deepEqual(b.route('personal', 'claude-sonnet-5'), {
    to: 'gateway', model: 'openai/gpt-6-astra', reason: 'quota',
  })
})

test('empty chain: a header-less 429 blips then surfaces; outage surfaces after its free retry', () => {
  const { tiers, notes } = setup()
  assert.deepEqual(tiers.observe('none', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} }), { retry: { to: 'direct', delay: 0 } })
  assert.deepEqual(tiers.observe('none', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} }), { retry: null })
  assert.equal(tiers.snapshot().none?.tier, 'max')
  assert.deepEqual(tiers.observe('none', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} }), { retry: { to: 'direct', delay: 0 } })
  assert.deepEqual(tiers.observe('none', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} }), { retry: null })
  assert.equal(tiers.snapshot().none?.tier, 'max')
  assert.equal(notes.length, 0)
})

test('successful gateway hop needs no retry', () => {
  const { tiers } = setup()
  assert.deepEqual(tiers.observe('personal', { to: 'gateway', model: 'zai/glm-5.3', status: 200, headers: {} }), { retry: null })
})

test('gateway hop failure outside a fallback tier surfaces (no silent credits)', () => {
  const { tiers } = setup()
  assert.deepEqual(tiers.observe('personal', { to: 'gateway', model: 'zai/glm-5.3', status: 429, headers: {} }), { retry: null })
})

test('pin max: a header-less 429 blips once then surfaces; outage gets one free direct retry', () => {
  const { tiers, notes } = setup()
  tiers.pin('personal', 'max')
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
  assert.deepEqual(tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} }), { retry: { to: 'direct', delay: 0 } })
  assert.deepEqual(tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 429, headers: {} }), { retry: null })
  assert.deepEqual(tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} }), { retry: { to: 'direct', delay: 0 } })
  assert.deepEqual(tiers.observe('personal', { to: 'direct', model: 'claude-sonnet-5', status: 529, headers: {} }), { retry: null })
  const snap = tiers.snapshot().personal
  assert.equal(snap?.tier, 'pinned')
  assert.equal(snap?.reason, 'pinned')
  assert.equal(snap?.model, null)
  assert.equal(snap?.pin, 'max')
  assert.equal(notes.length, 0)
})

test('pin to a model routes gateway to that model; unpin restores', () => {
  const { tiers } = setup()
  tiers.pin('personal', 'openai/gpt-6-astra')
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), {
    to: 'gateway', model: 'openai/gpt-6-astra', reason: 'pinned',
  })
  const snap = tiers.snapshot().personal
  assert.equal(snap?.tier, 'pinned')
  assert.equal(snap?.model, 'openai/gpt-6-astra')
  assert.equal(snap?.pin, 'openai/gpt-6-astra')
  tiers.pin('personal', null)
  assert.deepEqual(tiers.route('personal', 'claude-sonnet-5'), { to: 'direct' })
  assert.equal(tiers.snapshot().personal?.pin, null)
})

test('pinned model failure surfaces to the caller', () => {
  const { tiers } = setup()
  tiers.pin('personal', 'zai/glm-5.3')
  assert.deepEqual(
    tiers.observe('personal', { to: 'gateway', model: 'zai/glm-5.3', status: 429, headers: {} }),
    { retry: null },
  )
})

test('pin validates its value', () => {
  const { tiers } = setup()
  assert.throws(() => tiers.pin('personal', 'glm'), /barrito pin/)
  assert.throws(() => tiers.pin('personal', ''), /barrito pin/)
  // @ts-expect-error pin validates its value at runtime
  assert.throws(() => tiers.pin('personal', 42), /barrito pin/)
  tiers.pin('personal', 'max')
  tiers.pin('personal', null)
  tiers.pin('personal', 'zai/glm-5.3')
  assert.equal(tiers.snapshot().personal?.pin, 'zai/glm-5.3')
})

test('state persists across create()', () => {
  const statePath = dir()
  const notes: number[] = []
  const first = create({ config, statePath, notify: () => notes.push(1), now: () => 0 })
  first.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '3600' },
  })
  first.pin('work', 'max')

  const second = create({ config, statePath, notify: () => notes.push(1), now: () => 1000 })
  assert.deepEqual(second.route('personal', 'claude-sonnet-5'), {
    to: 'gateway', model: 'zai/glm-5.3', reason: 'quota',
  })
  assert.equal(second.snapshot().personal?.resetAt, 3600 * 1000)
  assert.deepEqual(second.route('work', 'claude-sonnet-5'), { to: 'direct' })
})

test('load drops garbage entries and unknown fields', () => {
  const statePath = dir()
  fs.writeFileSync(path.join(statePath, 'tiers.json'), JSON.stringify({
    junk: 'garbage',
    ok: { tier: 'fallback', reason: 'quota', model: 'zai/glm-5.3', resetAt: 123, bogus: true },
  }))
  const tiers = create({ config, statePath, notify: () => {}, now: () => 0 })
  const snap = tiers.snapshot()
  const ok: Record<string, unknown> = { ...snap.ok } // bogus is not a known field
  assert.equal(snap.junk, undefined)
  assert.equal(ok.tier, 'fallback')
  assert.equal(ok.reason, 'quota')
  assert.equal(ok.resetAt, 123)
  assert.equal(ok.bogus, undefined)
})

test('no duplicate notifications and since only marks entering quota', () => {
  const { tiers, notes, at } = setup()
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '60' },
  })
  assert.equal(tiers.snapshot().personal?.since, 0)
  at(60_000)
  tiers.route('personal', 'claude-sonnet-5')
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited', 'retry-after': '60' },
  })
  assert.equal(notes.length, 1)
  const snap = tiers.snapshot().personal
  assert.equal(snap?.since, 0)
  assert.equal(snap?.resetAt, 120_000)
})

test('label comes from config.models.labels when set', () => {
  const cfg = {
    identities: { personal: { fallback: ['zai/glm-5.3'] } },
    models: { labels: { 'zai/glm-5.3': 'GLM 5.3 cheap' } },
  }
  const notes: string[] = []
  const tiers = create({ config: cfg, statePath: dir(), notify: (t, m) => notes.push(m), now: () => 0 })
  tiers.observe('personal', {
    to: 'direct', model: 'claude-sonnet-5', status: 429,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'limited' },
  })
  assert.match(notes[0] ?? '', /^personal — Max spent\. Now GLM 5\.3 cheap on API credits/)
})

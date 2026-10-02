import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { create } from '../src/log.ts'
import { default as logs, tail, follow } from '../src/cli/logs.ts'
import type { CommandCtx, Config } from '../src/types.ts'

const keys = ['BARRITO_HOME', 'BARRITO_LOG']
let prev: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-log-'))
  process.env.BARRITO_HOME = tmp
  process.env.BARRITO_LOG = path.join(tmp, 'logs', 'barrito.log')
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

const cfg = (): Config => ({
  port: 4141,
  default: 'personal',
  identities: {},
  models: { include: [], exclude: [], require: [], max_input_price: null, pin: [], labels: {}, suffix: {}, agents: {} },
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
    exit: (c: number) => { out.codes.push(c) },
  }
}

const catchErr = async (fn: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')) }
  try {
    await fn()
  } finally {
    console.error = orig
  }
  return lines
}

test('log appends one line per call', () => {
  const file = path.join(tmp, 'out.log')
  const log = create({ file })
  log('hello')
  log('world')
  assert.equal(readFileSync(file, 'utf8'), 'hello\nworld\n')
})

test('log rotates by size and keeps N files', () => {
  const file = path.join(tmp, 'out.log')
  const log = create({ file, maxBytes: 10, keep: 3 })
  for (const c of ['a', 'b', 'c', 'd', 'e']) log(c.repeat(10))
  assert.equal(readFileSync(file, 'utf8'), 'eeeeeeeeee\n')
  assert.equal(readFileSync(`${file}.1`, 'utf8'), 'dddddddddd\n')
  assert.equal(readFileSync(`${file}.2`, 'utf8'), 'cccccccccc\n')
  assert.equal(readFileSync(`${file}.3`, 'utf8'), 'bbbbbbbbbb\n')
  assert.equal(existsSync(`${file}.4`), false)
})

test('log writes a single huge line without looping', () => {
  const file = path.join(tmp, 'out.log')
  const log = create({ file, maxBytes: 10 })
  log('x'.repeat(100))
  assert.equal(readFileSync(file, 'utf8'), `${'x'.repeat(100)}\n`)
})

test('log defaults to paths.logs and creates the dir', () => {
  const log = create({})
  log('hi')
  assert.equal(readFileSync(process.env.BARRITO_LOG ?? '', 'utf8'), 'hi\n')
})

test('logs tails the last 50 lines', async () => {
  const file = process.env.BARRITO_LOG as string
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n') + '\n')
  const c = ctx()
  await logs([], c)
  assert.equal(c.printed.length, 50)
  assert.equal(c.printed[0], 'line11')
  assert.equal(c.printed.at(-1), 'line60')
  assert.deepEqual(c.codes, [])
})

test('logs -n N tails fewer lines', async () => {
  const file = process.env.BARRITO_LOG as string
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n') + '\n')
  const c = ctx()
  await logs(['-n', '5'], c)
  assert.deepEqual(c.printed, ['line56', 'line57', 'line58', 'line59', 'line60'])
})

test('logs with no log file errors and exits 1', async () => {
  const c = ctx()
  const errs = await catchErr(() => logs([], c))
  assert.match(errs.join('\n'), /no logs yet/)
  assert.deepEqual(c.codes, [1])
})

test('tail returns null for a missing file', () => {
  assert.equal(tail(path.join(tmp, 'nope.log'), 5), null)
})

test('follow prints appended bytes and survives rotation', async () => {
  const file = path.join(tmp, 'f.log')
  writeFileSync(file, 'seed\n')
  let cb: () => void = () => {}
  const printed: string[] = []
  const stop = follow(file, {
    print: (s) => { printed.push(s) },
    watch: (dir, fn) => { cb = fn; return { close: () => {} } },
    interval: 10000,
  })
  appendFileSync(file, 'new line\n')
  cb()
  assert.deepEqual(printed, ['new line\n'])

  writeFileSync(file, 'small\n') // rotated: shrank under our offset
  cb()
  appendFileSync(file, 'after rotate\n')
  cb()
  assert.deepEqual(printed, ['new line\n', 'small\n', 'after rotate\n'])

  stop()
})

test('logs -f tails then follows, SIGINT exits clean', async () => {
  const file = process.env.BARRITO_LOG as string
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'first\n')
  let cb: () => void = () => {}
  const sig: Record<string, () => void> = {}
  const c = ctx()
  const chunks: string[] = []
  const running = logs(['-f'], c, {
    watch: (dir, fn) => { cb = fn; return { close: () => {} } },
    on: (s, fn) => { sig[s] = fn },
    interval: 10000,
    write: (s) => { chunks.push(s) },
  })
  assert.deepEqual(c.printed, ['first'])
  appendFileSync(file, 'live\n')
  cb()
  assert.deepEqual(chunks, ['live\n'])
  sig.SIGINT?.()
  assert.deepEqual(c.codes, [0])
  await Promise.race([running, new Promise((done) => setTimeout(done, 10)).then(() => 'still running (expected)')])
})

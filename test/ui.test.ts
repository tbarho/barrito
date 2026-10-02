import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripVTControlCharacters as strip } from 'node:util'
import { create, loc, rowsOf, tilde, version } from '../src/ui.ts'
import { home } from '../src/paths.ts'

const UTF = { LANG: 'en_US.UTF-8' }

const term = (columns = 80) => {
  const raw: string[] = []
  return { raw, out: { write: (s: string) => { raw.push(s); return true }, isTTY: true, columns } }
}

test('humanizers: loc, version, tilde', () => {
  assert.equal(loc(412), '412 loc')
  assert.equal(loc(412_300), '412k loc')
  assert.equal(loc(935_728), '936k loc')
  assert.equal(loc(999_700), '1M loc')
  assert.equal(loc(1_470_552), '1.5M loc')
  assert.equal(version('2.1.287 (Claude Code)'), '2.1.287')
  assert.equal(version('codex-cli 0.61.0'), '0.61.0')
  assert.equal(version('weird'), 'weird')
  assert.equal(tilde(`${home()}/Code/x`), '~/Code/x')
  assert.equal(tilde('/opt/x'), '/opt/x')
})

test('rowsOf mirrors clack hard word wrap', () => {
  assert.equal(rowsOf('│', 80), 1)
  assert.equal(rowsOf('x'.repeat(80), 80), 1)
  assert.equal(rowsOf('aaaa bbbb', 6), 2)
  assert.equal(rowsOf('aaa bb', 6), 1)
  assert.equal(rowsOf('aa ' + 'x'.repeat(13), 6), 3)
  assert.equal(rowsOf('\u001b[2maaaa\u001b[22m bbbb', 6), 2, 'ANSI never counts')
})

test('sections pack rows tight; one spacer between blocks; aligned keys; list boxes', () => {
  const lines: string[] = []
  const ui = create({ print: (s) => lines.push(s), env: { ...UTF, NO_COLOR: undefined }, out: { write: () => true } })
  ui.intro('t')
  ui.section('A', ['one', 'two'])
  ui.rows([['match', 'm'], ['gateway', 'g']])
  ui.section('B')
  ui.list([{ label: 'acme/api', detail: '412k loc', on: true }, { label: 'personal/side-project', detail: '96k loc', on: false }])
  ui.outro('done')
  assert.deepEqual(lines.map(strip), [
    't', '',
    '◇  A', '│  one', '│  two', '│  match    m', '│  gateway  g',
    '│',
    '◇  B', '│  ◼ acme/api               412k loc', '│  ◻ personal/side-project  96k loc',
    '│',
    '└  done',
  ])
})

test('erase removes exactly the clack submit frame, TTY only', () => {
  const t = term(20)
  create({ print: () => {}, env: UTF, out: t.out }).erase('a question that wraps here', 'Yes')
  assert.deepEqual(t.raw, ['\u001b[4A\r\u001b[J'])
  const piped = term()
  create({ print: () => {}, env: UTF, out: { ...piped.out, isTTY: false } }).erase('q', 'Yes')
  assert.deepEqual(piped.raw, [])
})

test('TTY step: ◆ while running, rewritten in place to ◇, held rows flush after', () => {
  const t = term(30)
  const lines: string[] = []
  const ui = create({ print: (s) => lines.push(s), env: UTF, out: t.out })
  ui.section('Plan')
  const done = ui.step('a fairly long step description that overflows')
  ui.warn('note during the step')
  assert.deepEqual(lines.map(strip), ['◇  Plan', '│'], 'rows wait while the step line is live')
  assert.equal(strip(t.raw[0] ?? ''), '◆  a fairly long step descri…')
  done()
  assert.equal(t.raw[1], '\r\u001b[2K')
  assert.deepEqual(lines.slice(2).map(strip), ['◇  a fairly long step description that overflows', '│  ! note during the step'])
})

test('TTY rows wrap inside the spine with a hanging indent; piped rows never wrap', () => {
  const t = term(24)
  const lines: string[] = []
  create({ print: (s) => lines.push(s), env: UTF, out: t.out }).warn('one two three four five six')
  assert.deepEqual(lines.map(strip), ['│  ! one two three four', '│    five six'])
  const piped: string[] = []
  create({ print: (s) => piped.push(s), env: UTF, out: { write: () => true } }).warn('one two three four five six')
  assert.deepEqual(piped.map(strip), ['│  ! one two three four five six'])
})

test('ASCII fallback on a non-UTF-8 locale', () => {
  const lines: string[] = []
  const ui = create({ print: (s) => lines.push(s), env: { LANG: 'C' }, out: { write: () => true } })
  ui.section('A', [`${ui.mark('ok')} fine`])
  ui.outro('end')
  assert.deepEqual(lines.map(strip), ['o  A', '|  ok fine', '|', '+  end'])
})

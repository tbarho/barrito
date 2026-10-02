import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notify } from '../src/router/notify.ts'

// real spawn semantics: probe answers synchronously (no throw on ENOENT); fire
// records the detached call and returns — an ENOENT would arrive async, never as a throw
const notifier = (onPath: Record<string, boolean> = {}, throwing: Record<string, Error> = {}) => {
  const calls: [string, string[]][] = []
  const probes: string[] = []
  return {
    calls,
    probes,
    probe: (bin: string): boolean => { probes.push(bin); return onPath[bin] !== false },
    exec: (bin: string, args: string[]): boolean => {
      calls.push([bin, args])
      const err = throwing[bin]
      if (err) throw err
      return true
    },
  }
}

const sink = (): { lines: string[]; out: (l: string) => void } => {
  const lines: string[] = []
  return { lines, out: (l: string) => { lines.push(l) } }
}

test('macOS: terminal-notifier fires when it is on PATH', () => {
  const r = notifier()
  notify('barrito', 'personal — Max is back.', { probe: r.probe, exec: r.exec, platform: 'darwin', env: {} })
  const [bin, args] = r.calls[0] ?? []
  assert.equal(bin, 'terminal-notifier')
  assert.deepEqual(args?.slice(0, 4), ['-title', 'barrito', '-message', 'personal — Max is back.'])
  assert.ok(args?.[args.indexOf('-contentImage') + 1]?.endsWith('templates/icon.png'))
  assert.equal(args?.[args.indexOf('-group') + 1], 'barrito') // no group → plain barrito
  assert.deepEqual(r.probes, ['terminal-notifier'])
})

test('macOS: terminal-notifier groups repeats per identity', () => {
  const r = notifier()
  notify('barrito', 'work — Max spent.', { probe: r.probe, exec: r.exec, platform: 'darwin', env: {}, group: 'work' })
  const args = r.calls[0]?.[1] ?? []
  assert.equal(args[args.indexOf('-group') + 1], 'barrito-work')
})

test('macOS: terminal-notifier missing (ENOENT, no throw) falls back to osascript', () => {
  const r = notifier({ 'terminal-notifier': false })
  notify('barrito', 'hello', { probe: r.probe, exec: r.exec, platform: 'darwin', env: {} })
  assert.deepEqual(r.calls, [['osascript', ['-e', 'display notification "hello" with title "barrito"']]])
})

test('osascript escapes quotes, backslashes, newlines and carriage returns', () => {
  const r = notifier({ 'terminal-notifier': false })
  notify('barrito', 'a "q"\nline\r end\\ slash', { probe: r.probe, exec: r.exec, platform: 'darwin', env: {} })
  const script = r.calls[0]?.[1]?.[1] ?? ''
  assert.ok(script.includes('\\"q\\"'))
  assert.ok(script.includes('\\nline'))
  assert.ok(script.includes('\\r end'))
  assert.ok(script.includes('end\\\\ slash'))
  assert.ok(script.startsWith('display notification "a \\"q\\"'))
})

test('a throwing exec never breaks the caller', () => {
  const r = notifier({ 'terminal-notifier': false }, { osascript: new Error('boom') })
  notify('barrito', 'm', { probe: r.probe, exec: r.exec, platform: 'darwin', env: {} })
  assert.deepEqual(r.calls, [['osascript', ['-e', 'display notification "m" with title "barrito"']]])
})

test('GitHub Actions writes a warning annotation to stdout', () => {
  const { lines, out } = sink()
  const r = notifier()
  notify('barrito', 'ci — Max spent. Now GLM 5.3 on API credits until 14:05.', {
    probe: r.probe,
    exec: r.exec,
    env: { GITHUB_ACTIONS: 'true' },
    out,
  })
  assert.deepEqual(lines, ['::warning title=barrito::ci — Max spent. Now GLM 5.3 on API credits until 14:05.'])
  assert.deepEqual(r.calls, []) // no desktop notifier in CI
})

test('GitHub Actions writes a notice when Max is back', () => {
  const { lines, out } = sink()
  notify('barrito', 'ci — Max is back.', { env: { GITHUB_ACTIONS: 'true' }, out })
  assert.deepEqual(lines, ['::notice title=barrito::ci — Max is back.'])
})

test('GitHub Actions escapes the data part: % → %25, CR → %0D, LF → %0A', () => {
  const { lines, out } = sink()
  notify('barrito', 'multi\nline\r100% spent', { env: { GITHUB_ACTIONS: 'true' }, out })
  assert.deepEqual(lines, ['::warning title=barrito::multi%0Aline%0D100%25 spent'])
})

test('GitHub Actions escapes property values: : → %3A, , → %2C', () => {
  const { lines, out } = sink()
  notify('bar:rito,extra', 'm', { env: { GITHUB_ACTIONS: 'true' }, out })
  assert.deepEqual(lines, ['::warning title=bar%3Arito%2Cextra::m'])
})

test('linux with a display fires notify-send with the burrito icon', () => {
  const r = notifier()
  notify('barrito', 'personal — Max spent.', { probe: r.probe, exec: r.exec, env: { DISPLAY: ':0' }, platform: 'linux' })
  const [bin, args] = r.calls[0] ?? []
  assert.equal(bin, 'notify-send')
  assert.equal(args?.[args.indexOf('-a') + 1], 'barrito')
  assert.ok(args?.[args.indexOf('-i') + 1]?.endsWith('templates/icon.png'))
  assert.equal(args?.at(-2), 'barrito')
  assert.equal(args?.at(-1), 'personal — Max spent.')
})

test('linux with a wayland display fires notify-send too', () => {
  const r = notifier()
  notify('barrito', 'm', { probe: r.probe, exec: r.exec, env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' })
  const args = r.calls[0]?.[1] ?? []
  assert.equal(args.at(-1), 'm')
  assert.ok(args[args.indexOf('-i') + 1]?.endsWith('templates/icon.png'))
})

test('linux display but no notify-send on PATH falls back to stderr', () => {
  const r = notifier({ 'notify-send': false })
  const { lines: errs, out: err } = sink()
  notify('barrito', 'personal — Max spent.', { probe: r.probe, exec: r.exec, env: { DISPLAY: ':0' }, platform: 'linux', err })
  assert.deepEqual(r.calls, []) // probed, found absent, never fired
  assert.deepEqual(r.probes, ['notify-send'])
  assert.deepEqual(errs, ['barrito: personal — Max spent.'])
})

test('headless linux writes a stderr line without probing', () => {
  const { lines: errs, out: err } = sink()
  const r = notifier()
  notify('barrito', 'work — Max is back.', { probe: r.probe, exec: r.exec, env: {}, platform: 'linux', err })
  assert.deepEqual(errs, ['barrito: work — Max is back.'])
  assert.deepEqual(r.probes, [])
  assert.deepEqual(r.calls, [])
})

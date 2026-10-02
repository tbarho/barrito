import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ExecFileSyncOptions } from 'node:child_process'
import keychain from '../src/cli/keychain.ts'
import { own } from '../src/cli/keychain.ts'
import type { CommandCtx, Config, Exec, Identity, ModelRules } from '../src/types.ts'

const keys = ['BARRITO_HOME', 'BARRITO_STATE', 'BARRITO_PLATFORM']
let prev: Record<string, string | undefined>

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  process.env.BARRITO_HOME = '/tmp/barrito-keychain-own-home' // only paths.ts reads it; the Keychain is never touched
  process.env.BARRITO_PLATFORM = 'darwin'
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

type Call = { bin: string; args: string[]; opts: ExecFileSyncOptions }

// the security calls own makes: one value read per foreign item (the one prompt),
// then the barrito-owned copy written with -T and the value twice on stdin
const recorder = (items: Record<string, { value: string }>) => {
  const calls: Call[] = []
  const read: string[] = []
  const exec: Exec = (bin, args, opts = {}) => {
    calls.push({ bin, args, opts })
    if (bin !== '/usr/bin/security') throw new Error(`unexpected: ${bin}`)
    const name = args[args.indexOf('-s') + 1] ?? ''
    if (args[0] === 'find-generic-password') {
      const item = items[name]
      if (!item) throw Object.assign(new Error('not found'), { status: 44 })
      read.push(item.value)
      return `${item.value}\n`
    }
    if (args[0] === 'add-generic-password') {
      const input = String(opts.input ?? '')
      if (!read.some((v) => input === `${v}\n${v}\n`)) throw new Error('copy input is not a previously read value, twice on stdin')
      return ''
    }
    throw new Error(`unexpected security args: ${args.join(' ')}`)
  }
  return { calls, exec }
}

const idn = (over: Partial<Identity> = {}): Identity => ({
  id: '',
  claude_config_dir: '',
  share_from: null,
  fallback: [],
  match: { remotes: [], paths: [] },
  keychain: {},
  ...over,
})

const rules = (over: Partial<ModelRules> = {}): ModelRules => ({
  include: [],
  exclude: [],
  require: [],
  max_input_price: null,
  pin: [],
  labels: {},
  suffix: {},
  agents: {},
  ...over,
})

const config = (): Config => ({
  port: 4141,
  default: 'personal',
  identities: {
    work: idn({ id: 'work', keychain: { gateway: 'Vercel AI Gateway Work', cursor: 'Cursor Work' } }),
    personal: idn({ id: 'personal', keychain: { gateway: 'Vercel AI Gateway', cursor: 'Cursor' } }),
  },
  models: rules(),
  graft: { roots: [], repos: [] },
  harness: {},
})

const mkCtx = (printed: string[], codes: number[], cfg: Config = config()): CommandCtx => ({
  config: cfg,
  print: (s: string) => { printed.push(s) },
  exit: (code: number) => { codes.push(code) },
})

test('own: reads each foreign item once, writes the barrito-owned copy with -T and the value on stdin', () => {
  const { calls, exec } = recorder({
    'Vercel AI Gateway Work': { value: 'gw-work-key' },
    'Cursor Work': { value: 'cur-work' },
    'Vercel AI Gateway': { value: 'gw-personal-key' },
    Cursor: { value: 'cur-personal' },
  })
  const cfg = config()
  const { lines, changed } = own(cfg.identities, { exec })
  assert.equal(changed, true)
  assert.deepEqual(lines, [
    '✓ copied "Vercel AI Gateway Work" → "barrito: gateway work" (original untouched)',
    '✓ copied "Cursor Work" → "barrito: cursor work" (original untouched)',
    '✓ copied "Vercel AI Gateway" → "barrito: gateway personal" (original untouched)',
    '✓ copied "Cursor" → "barrito: cursor personal" (original untouched)',
  ])
  const reads = calls.filter((c) => c.args[0] === 'find-generic-password')
  assert.equal(reads.length, 4, 'exactly one value read per foreign item — one prompt each')
  const saves = calls.filter((c) => c.args[0] === 'add-generic-password')
  assert.equal(saves.length, 4)
  assert.deepEqual(saves[0]?.args, ['add-generic-password', '-U', '-s', 'barrito: gateway work', '-a', 'barrito', '-T', '/usr/bin/security', '-w'])
  assert.equal(saves[0]?.opts.input, 'gw-work-key\ngw-work-key\n')
  assert.equal(saves.some((s) => s.args.includes('gw-work-key')), false, 'value never rides argv')
  // the config's slots now point at the owned copies
  assert.equal(cfg.identities.work?.keychain.gateway, 'barrito: gateway work')
  assert.equal(cfg.identities.work?.keychain.cursor, 'barrito: cursor work')
  assert.equal(cfg.identities.personal?.keychain.gateway, 'barrito: gateway personal')
  assert.equal(cfg.identities.personal?.keychain.cursor, 'barrito: cursor personal')
  // originals never deleted or modified
  assert.equal(calls.some((c) => c.args[0] === 'delete-generic-password'), false)
  assert.equal(calls.some((c) => c.args[0] === 'add-generic-password' && !c.args.includes('-T')), false)
})

test('own: a foreign ref shared by two identities is read once, copied per identity', () => {
  const { calls, exec } = recorder({ 'Vercel AI Gateway': { value: 'shared-key' } })
  const cfg = config()
  cfg.identities.work = idn({ id: 'work', keychain: { gateway: 'Vercel AI Gateway' } })
  cfg.identities.personal = idn({ id: 'personal', keychain: { gateway: 'Vercel AI Gateway' } })
  const { lines } = own(cfg.identities, { exec })
  assert.equal(calls.filter((c) => c.args[0] === 'find-generic-password').length, 1)
  assert.equal(calls.filter((c) => c.args[0] === 'add-generic-password').length, 2)
  assert.deepEqual(lines.filter((l) => l.startsWith('✓ copied')), [
    '✓ copied "Vercel AI Gateway" → "barrito: gateway work" (original untouched)',
    '✓ copied "Vercel AI Gateway" → "barrito: gateway personal" (original untouched)',
  ])
  assert.equal(cfg.identities.work?.keychain.gateway, 'barrito: gateway work')
  assert.equal(cfg.identities.personal.keychain.gateway, 'barrito: gateway personal')
})

test('own: env:/file: refs are skipped (never probed); a missing item is reported without a copy', () => {
  const { calls, exec } = recorder({ Cursor: { value: 'cur-personal' } })
  const cfg = config()
  cfg.identities.work = idn({ id: 'work', keychain: { gateway: 'env:WORK_GATEWAY_KEY', cursor: 'file:/tmp/never-read' } })
  const { lines, changed } = own(cfg.identities, { exec })
  assert.equal(changed, true)
  assert.deepEqual(lines, [
    '! skipped "Vercel AI Gateway" (not in Keychain)',
    '✓ copied "Cursor" → "barrito: cursor personal" (original untouched)',
  ])
  assert.equal(calls.some((c) => c.args.includes('env:WORK_GATEWAY_KEY')), false)
  assert.equal(calls.some((c) => String(c.args.join(' ')).includes('file:')), false)
})

test('own: a canceled read (ACL denial) skips the item, never prints the value', () => {
  const denied: Exec = (bin, args) => {
    if (args[0] === 'find-generic-password') throw new Error('security: SecKeychainItemCopyAttributesAndData: User canceled the operation.')
    throw new Error(`unexpected security args: ${args.join(' ')}`)
  }
  const { lines, changed } = own({ personal: idn({ id: 'personal', keychain: { gateway: 'Vercel AI Gateway' } }) }, { exec: denied })
  assert.equal(changed, false)
  assert.deepEqual(lines, ['! skipped "Vercel AI Gateway" (read failed: security: SecKeychainItemCopyAttributesAndData: User canceled the operation.)'])
  assert.ok(!lines.some((l) => l.includes('gw-personal-key')))
})

test('own: already barrito-owned items are skipped with zero security calls; re-run changes nothing', () => {
  const { calls, exec } = recorder({})
  const cfg = config()
  cfg.identities.work = idn({ id: 'work', keychain: { gateway: 'barrito: gateway work', cursor: 'barrito: cursor work' } })
  cfg.identities.personal = idn({ id: 'personal', keychain: { gateway: 'barrito: gateway personal', cursor: 'barrito: cursor personal' } })
  const { lines, changed } = own(cfg.identities, { exec })
  assert.equal(changed, false)
  assert.deepEqual(lines, [
    '✓ "barrito: gateway work" already barrito-owned',
    '✓ "barrito: cursor work" already barrito-owned',
    '✓ "barrito: gateway personal" already barrito-owned',
    '✓ "barrito: cursor personal" already barrito-owned',
  ])
  assert.equal(calls.length, 0)
})

test('own: no keyring refs → nothing-to-do line, no exec calls', () => {
  const { calls, exec } = recorder({})
  const { lines, changed } = own({ work: idn({ id: 'work', keychain: { gateway: 'env:G', cursor: 'file:/tmp/k' } }) }, { exec })
  assert.equal(changed, false)
  assert.deepEqual(lines, ['no keychain items referenced by the config — nothing to own'])
  assert.equal(calls.length, 0)
})

test('own: linux is a no-op message, no security calls', () => {
  const { calls, exec } = recorder({})
  const { lines, changed } = own(config().identities, { exec, platform: 'linux' })
  assert.equal(changed, false)
  assert.deepEqual(lines, ['no Keychain on linux — nothing to own'])
  assert.equal(calls.length, 0)
})

test('command: prints the intro + one line per item, rewrites the config through save, never a value', async () => {
  const { exec } = recorder({
    'Vercel AI Gateway Work': { value: 'gw-work-key' },
    'Cursor Work': { value: 'cur-work' },
    'Vercel AI Gateway': { value: 'gw-personal-key' },
    Cursor: { value: 'cur-personal' },
  })
  const printed: string[] = []
  const codes: number[] = []
  const cfg = config()
  const saved: Config[] = []
  await keychain(['own'], mkCtx(printed, codes, cfg), { exec, save: (c) => saved.push(c) })
  assert.match(printed[0] ?? '', /macOS will ask once per key/)
  assert.equal(printed.filter((l) => l.startsWith('✓ copied ')).length, 4)
  assert.ok(!printed.some((l) => l.includes('gw-work-key') || l.includes('gw-personal-key')))
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.identities.work?.keychain.gateway, 'barrito: gateway work')
  assert.deepEqual(codes, [])
})

test('command: trust alias runs own and prints a note (no deprecation hand-wringing)', async () => {
  const { exec } = recorder({
    'Vercel AI Gateway Work': { value: 'gw-work-key' },
    'Cursor Work': { value: 'cur-work' },
    'Vercel AI Gateway': { value: 'gw-personal-key' },
    Cursor: { value: 'cur-personal' },
  })
  const printed: string[] = []
  const codes: number[] = []
  const cfg = config()
  await keychain(['trust'], mkCtx(printed, codes, cfg), { exec, save: () => {} })
  assert.match(printed[0] ?? '', /trust runs own/)
  assert.equal(printed.filter((l) => l.startsWith('✓ copied ')).length, 4)
  assert.equal(cfg.identities.work?.keychain.gateway, 'barrito: gateway work')
})

test('command: anything but `own`/`trust` → usage + exit 2', async () => {
  const printed: string[] = []
  const codes: number[] = []
  await keychain(['nonsense'], mkCtx(printed, codes), { exec: () => '' })
  assert.deepEqual(printed, ['usage: barrito keychain own'])
  assert.deepEqual(codes, [2])
})

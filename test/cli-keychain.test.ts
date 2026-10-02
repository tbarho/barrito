import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ExecFileSyncOptions } from 'node:child_process'
import keychain from '../src/cli/keychain.ts'
import { trust } from '../src/cli/keychain.ts'
import type { CommandCtx, Config, Exec, Identity, ModelRules } from '../src/types.ts'

const keys = ['BARRITO_HOME', 'BARRITO_STATE', 'BARRITO_PLATFORM']
let prev: Record<string, string | undefined>

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  process.env.BARRITO_HOME = '/tmp/barrito-keychain-trust-home' // only paths.ts reads it; the Keychain is never touched
  process.env.BARRITO_PLATFORM = 'darwin'
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

type Call = { bin: string; args: string[]; opts: ExecFileSyncOptions }

const attrs = (acct: string): string =>
  `attributes: {\n    "acct"<blob>="${acct}"\n    "svce"<blob>="x"\n}`

// the security calls trust makes, in order: attributes read, value read, trusted re-save
const recorder = (items: Record<string, { acct: string; value: string }>) => {
  const calls: Call[] = []
  const exec: Exec = (bin, args, opts = {}) => {
    calls.push({ bin, args, opts })
    if (bin !== '/usr/bin/security') throw new Error(`unexpected: ${bin}`)
    const name = args[args.indexOf('-s') + 1] ?? ''
    if (args[0] === 'find-generic-password' && !args.includes('-w')) {
      const item = items[name]
      if (!item) throw Object.assign(new Error('not found'), { status: 44 })
      return attrs(item.acct)
    }
    if (args[0] === 'find-generic-password') {
      const item = items[name]
      if (!item) throw Object.assign(new Error('not found'), { status: 44 })
      return `${item.value}\n`
    }
    if (args[0] === 'add-generic-password') {
      const input = String(opts.input ?? '')
      if (input !== `${items[name]?.value}\n${items[name]?.value}\n`) throw new Error('re-save input is not the read value, twice on stdin')
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

const mkCtx = (printed: string[], codes: number[]): CommandCtx => ({
  config: config(),
  print: (s: string) => { printed.push(s) },
  exit: (code: number) => { codes.push(code) },
})

test('trust: re-saves each configured keyring ref with its existing account, -T /usr/bin/security, value on stdin', () => {
  const { calls, exec } = recorder({
    'Vercel AI Gateway Work': { acct: 'vercel-cli', value: 'gw-work-key' },
    'Cursor Work': { acct: 'cursor', value: 'cur-work' },
    'Vercel AI Gateway': { acct: 'vercel-cli', value: 'gw-personal-key' },
    Cursor: { acct: 'barrito', value: 'cur-personal' },
  })
  const lines = trust(config().identities, { exec })
  assert.deepEqual(lines, [
    '✓ trusted "Vercel AI Gateway Work"',
    '✓ trusted "Cursor Work"',
    '✓ trusted "Vercel AI Gateway"',
    '✓ trusted "Cursor"',
  ])
  const saves = calls.filter((c) => c.args[0] === 'add-generic-password')
  assert.equal(saves.length, 4)
  const first = saves[0]
  assert.deepEqual(first?.args, ['add-generic-password', '-U', '-s', 'Vercel AI Gateway Work', '-a', 'vercel-cli', '-T', '/usr/bin/security', '-w'])
  assert.equal(first?.opts.input, 'gw-work-key\ngw-work-key\n')
  assert.equal(first?.args.includes('gw-work-key'), false, 'value never rides argv')
  // the account survives: the item's own acct, not the barrito default
  assert.equal(saves[1]?.args[5], 'cursor')
  assert.equal(saves[3]?.args[5], 'barrito')
})

test('trust: env:/file: refs are skipped (never probed), a missing item is reported', () => {
  const { calls, exec } = recorder({ Cursor: { acct: 'barrito', value: 'cur-personal' } })
  const cfg = config()
  cfg.identities.work = idn({ id: 'work', keychain: { gateway: 'env:WORK_GATEWAY_KEY', cursor: 'file:/tmp/never-read' } })
  const lines = trust(cfg.identities, { exec })
  assert.deepEqual(lines, ['! skipped "Vercel AI Gateway" (not in Keychain)', '✓ trusted "Cursor"'])
  assert.equal(calls.some((c) => c.args.includes('env:WORK_GATEWAY_KEY')), false)
  assert.equal(calls.some((c) => String(c.args.join(' ')).includes('file:')), false)
})

test('trust: a canceled read (ACL prompt) skips the item, never prints the value', () => {
  const denied: Exec = (bin, args) => {
    if (args[0] === 'find-generic-password' && !args.includes('-w')) return attrs('vercel-cli')
    throw new Error('security: SecKeychainItemCopyAttributesAndData: User canceled the operation.')
  }
  const lines = trust({ personal: { keychain: { gateway: 'Vercel AI Gateway' } } }, { exec: denied })
  assert.deepEqual(lines, ['! skipped "Vercel AI Gateway" (read failed: security: SecKeychainItemCopyAttributesAndData: User canceled the operation.)'])
  assert.ok(!lines.some((l) => l.includes('gw-personal-key')))
})

test('trust: no keyring refs → nothing-to-do line, no exec calls', () => {
  const { calls, exec } = recorder({})
  const lines = trust({ work: { keychain: { gateway: 'env:G', cursor: 'file:/tmp/k' } } }, { exec })
  assert.deepEqual(lines, ['no keychain items referenced by the config — nothing to trust'])
  assert.equal(calls.length, 0)
})

test('trust: linux is a no-op message, no security calls', () => {
  const { calls, exec } = recorder({})
  const lines = trust(config().identities, { exec, platform: 'linux' })
  assert.deepEqual(lines, ['no Keychain on linux — nothing to trust'])
  assert.equal(calls.length, 0)
})

test('command: prints the intro + one line per item, never a value', async () => {
  const { exec } = recorder({
    'Vercel AI Gateway Work': { acct: 'vercel-cli', value: 'gw-work-key' },
    'Cursor Work': { acct: 'cursor', value: 'cur-work' },
    'Vercel AI Gateway': { acct: 'vercel-cli', value: 'gw-personal-key' },
    Cursor: { acct: 'barrito', value: 'cur-personal' },
  })
  const printed: string[] = []
  const codes: number[] = []
  const ctx = mkCtx(printed, codes)
  await keychain(['trust'], ctx, { exec })
  assert.match(printed[0] ?? '', /Always Allow/)
  assert.equal(printed.filter((l) => l.startsWith('✓ trusted ')).length, 4)
  assert.ok(!printed.some((l) => l.includes('gw-work-key') || l.includes('gw-personal-key')))
  assert.deepEqual(codes, [])
})

test('command: anything but `trust` → usage + exit 2', async () => {
  const printed: string[] = []
  const codes: number[] = []
  await keychain(['nonsense'], mkCtx(printed, codes), { exec: () => '' })
  assert.deepEqual(printed, ['usage: barrito keychain trust'])
  assert.deepEqual(codes, [2])
})

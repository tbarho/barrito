import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import * as kc from '../src/keychain/index.ts'
import { create, restore } from '../src/backup.ts'
import { paths } from '../src/paths.ts'
import command from '../src/cli/keychain.ts'
import { diagnose } from '../src/cli/doctor.ts'
import uninstall from '../src/cli/uninstall.ts'
import { fakeSecurity, parseSecurityI } from './fixtures/security.ts'
import type { CommandCtx, Config, Exec } from '../src/types.ts'

const KEYS = ['BARRITO_HOME', 'BARRITO_CONFIG', 'BARRITO_STATE', 'BARRITO_SHIMS', 'BARRITO_PLATFORM']
let prev: Record<string, string | undefined>
let home: string

beforeEach(() => {
  prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  home = fs.mkdtempSync(path.join(tmpdir(), 'barrito-kcb-'))
  process.env.BARRITO_HOME = home
  process.env.BARRITO_CONFIG = path.join(home, '.config', 'barrito', 'config.toml')
  process.env.BARRITO_STATE = path.join(home, 'state')
  process.env.BARRITO_SHIMS = path.join(home, 'shims')
  process.env.BARRITO_PLATFORM = 'darwin'
})

afterEach(() => {
  KEYS.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
  fs.rmSync(home, { recursive: true, force: true })
})

const SVC = 'barrito: gateway work'
const TS = '2026-10-02T14:05'
const bak = (ts: string, svc = SVC): string => `barrito backup: ${svc} ${ts}`
const handle = () => create({ ts: TS, dir: path.join(home, 'backup') })
const now = () => new Date('2026-10-02T15:00:00Z')

// the security calls that matter: value reads (-w) and writes (-i → service)
const story = (calls: { args: string[]; input?: string }[]): string[] => calls.flatMap((c) => {
  if (c.args[0] === '-i') return [`set ${parseSecurityI(c.input ?? '').service}`]
  if (c.args[0] === 'find-generic-password' && c.args.includes('-w')) return [`get ${c.args[2]}`]
  if (c.args[0] === 'delete-generic-password') return [`del ${c.args[2]}`]
  return []
})

test('overwrite: get old → set backup → set new; the manifest holds names only', () => {
  const { calls, store, exec } = fakeSecurity({ [SVC]: 'old-secret' })
  const backup = handle()
  kc.set(SVC, 'new-secret', { exec, backup })

  const s = story(calls)
  assert.equal(s[0], `get ${SVC}`)
  assert.ok(s.indexOf(`set ${bak(TS)}`) > 0)
  assert.ok(s.indexOf(`set ${bak(TS)}`) < s.indexOf(`set ${SVC}`))
  assert.equal(store[bak(TS)], 'old-secret')
  assert.equal(store[SVC], 'new-secret')
  assert.equal(parseSecurityI(calls.find((c) => c.args[0] === '-i')?.input ?? '').account, 'barrito')

  const json = fs.readFileSync(backup.write(), 'utf8')
  assert.deepEqual(JSON.parse(json).keychain, [{ kind: 'keychain', service: SVC, account: 'barrito', backup: bak(TS) }])
  assert.equal(json.includes('old-secret'), false)
  assert.equal(json.includes('new-secret'), false)
})

test('new item or unchanged value: nothing to overwrite → no backup, no prune', () => {
  const fresh = fakeSecurity()
  const backup = handle()
  kc.set(SVC, 'v', { exec: fresh.exec, backup })
  assert.deepEqual(Object.keys(fresh.store), [SVC])
  assert.equal(fresh.calls.some((c) => c.args[0] === 'dump-keychain'), false)
  assert.deepEqual(backup.manifest.keychain, [])

  const same = fakeSecurity({ [SVC]: 'v' })
  kc.set(SVC, 'v', { exec: same.exec, backup })
  assert.deepEqual(Object.keys(same.store), [SVC])
  assert.deepEqual(backup.manifest.keychain, [])
})

test('a second overwrite in the same run keeps the first backup (the pre-barrito value)', () => {
  const { store, exec } = fakeSecurity({ [SVC]: 'original' })
  const backup = handle()
  kc.set(SVC, 'one', { exec, backup })
  kc.set(SVC, 'two', { exec, backup })
  assert.equal(store[bak(TS)], 'original')
  assert.equal(backup.manifest.keychain.length, 1)
})

test('without a handle the backup still lands in the keychain, named by the clock', () => {
  const { store, exec } = fakeSecurity({ [SVC]: 'old' })
  kc.set(SVC, 'new', { exec, now })
  assert.equal(store[bak('2026-10-02T15:00:00')], 'old')
})

test('an unreadable current value refuses the overwrite — nothing written', () => {
  const calls: string[][] = []
  const exec: Exec = (_bin, args) => {
    calls.push(args)
    throw Object.assign(new Error('User canceled the operation.'), { status: 128 })
  }
  assert.throws(() => kc.set(SVC, 'new', { exec }), /refusing to overwrite "barrito: gateway work" — its current value couldn't be read/)
  assert.equal(calls.some((a) => a[0] === '-i'), false)
})

test('retention: newest 3 backups per service survive, other services untouched', () => {
  const other = bak('2026-01-01T00:00:00', 'barrito: cursor work')
  const { store, exec } = fakeSecurity({
    [SVC]: 'current',
    [bak('2026-09-01T00:00:00')]: 'a',
    [bak('2026-09-02T00:00:00')]: 'b',
    [bak('2026-09-03T00:00:00')]: 'c',
    [bak('2026-09-04T00:00:00')]: 'd',
    [other]: 'x',
  })
  kc.set(SVC, 'next', { exec, now })
  assert.deepEqual(kc.backups({ exec }).filter((b) => b.service === SVC).map((b) => b.ts), ['2026-10-02T15:00:00', '2026-09-04T00:00:00', '2026-09-03T00:00:00'])
  assert.equal(store[bak('2026-10-02T15:00:00')], 'current')
  assert.equal(store[other], 'x')
})

test('backup.restore: writes the old value back (verified), deletes the backup, skips a missing one', () => {
  const { calls, store, exec } = fakeSecurity({ [SVC]: 'old', 'barrito: cursor work': 'c-old' })
  const backup = handle()
  kc.set(SVC, 'junk', { exec, backup })
  kc.set('barrito: cursor work', 'c-junk', { exec, backup })
  delete store[bak(TS, 'barrito: cursor work')]
  const manifest = backup.write()

  const lines: string[] = []
  calls.length = 0
  restore(manifest, { keyring: { exec, now }, report: (l) => lines.push(l) })
  assert.equal(store[SVC], 'old')
  assert.equal(store[bak(TS)], undefined)
  assert.ok(story(calls).includes(`get ${SVC}`), 'the restore write is read back')
  assert.deepEqual(lines, [
    `✓ restored keychain "${SVC}"`,
    `! skipped keychain "barrito: cursor work" (backup "${bak(TS, 'barrito: cursor work')}" is missing)`,
  ])
  assert.equal(store['barrito: cursor work'], 'c-junk')
  assert.equal(lines.join('\n').includes('old'), false)
})

test('manual restore: newest by default, --from picks a timestamp, unknown ts → null', () => {
  const { store, exec } = fakeSecurity({
    [SVC]: 'junk',
    [bak('2026-09-01T00:00:00')]: 'older',
    [bak('2026-09-02T00:00:00')]: 'newer',
  })
  assert.equal(kc.restore(SVC, { exec, now })?.ts, '2026-09-02T00:00:00')
  assert.equal(store[SVC], 'newer')
  assert.equal(store[bak('2026-09-02T00:00:00')], undefined)
  assert.equal(store[bak('2026-10-02T15:00:00')], 'junk', 'the replaced value was backed up first')

  assert.equal(kc.restore(SVC, { exec, now, from: '2026-09-01T00:00:00' })?.ts, '2026-09-01T00:00:00')
  assert.equal(store[SVC], 'older')
  assert.equal(kc.restore(SVC, { exec, from: '1999-01-01' }), null)
})

const ctx = (printed: string[], codes: number[], config: Partial<Config> = {}): CommandCtx =>
  ({ config: { identities: {}, ...config } as Config, print: (s: string) => printed.push(s), exit: (c: number) => { codes.push(c); return undefined as never } })

test('cli: keychain backups lists names + timestamps, never values; restore by --from', async () => {
  const { store, exec } = fakeSecurity({ [SVC]: 'live-secret', [bak('2026-09-01T00:00:00')]: 'backup-secret' })
  const printed: string[] = []
  const codes: number[] = []
  await command(['backups'], ctx(printed, codes), { exec })
  const out = printed.join('\n')
  assert.match(out, /"barrito: gateway work"/)
  assert.match(out, /2026-09-01T00:00:00/)
  assert.equal(out.includes('secret'), false)

  await command(['restore', SVC, '--from', '2026-09-01T00:00:00'], ctx(printed, codes), { exec })
  assert.equal(store[SVC], 'backup-secret')
  assert.match(printed.join('\n'), /restored keychain "barrito: gateway work" from 2026-09-01T00:00:00/)
  assert.equal(printed.join('\n').includes('backup-secret'), false)

  await command(['restore', SVC, '--from', 'nope'], ctx(printed, codes), { exec })
  assert.deepEqual(codes, [1])
  await command(['restore'], ctx(printed, codes), { exec })
  assert.deepEqual(codes, [1, 2])
})

// fake secret-tool: lookup/store/clear on `service`, search prints attributes AND secrets
const fakeSecretTool = (seed: Record<string, string> = {}) => {
  const store: Record<string, { value: string; tagged: boolean }> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, { value: v, tagged: k.startsWith('barrito backup: ') }]))
  const calls: string[][] = []
  const miss = () => Object.assign(new Error('no match'), { status: 1 })
  const exec: Exec = (bin, args, opts = {}) => {
    calls.push(args)
    if (bin !== 'secret-tool') throw new Error(`unexpected ${bin}`)
    const svc = args[args.indexOf('service') + 1] ?? ''
    if (args[0] === 'lookup') {
      if (!store[svc]) throw miss()
      return store[svc].value
    }
    if (args[0] === 'store') {
      store[svc] = { value: String(opts.input ?? '').trim(), tagged: args.includes('barrito-backup') }
      return ''
    }
    if (args[0] === 'clear') {
      if (!store[svc]) throw miss()
      delete store[svc]
      return ''
    }
    if (args[0] === 'search') {
      return Object.entries(store).filter(([, v]) => v.tagged).map(([k, v]) => `[/x]\nlabel = ${k}\nsecret = ${v.value}\nattribute.service = ${k}\nattribute.barrito-backup = 1\n`).join('')
    }
    throw new Error(`unexpected secret-tool ${args.join(' ')}`)
  }
  return { store, calls, exec }
}

test('linux: same semantics — tagged backup item, retention, restore, list never leaks', () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const { store, calls, exec } = fakeSecretTool({
    [SVC]: 'old',
    [bak('2026-09-01T00:00:00')]: 'a',
    [bak('2026-09-02T00:00:00')]: 'b',
    [bak('2026-09-03T00:00:00')]: 'c',
  })
  const backup = handle()
  kc.set(SVC, 'new', { exec, backup })
  const stores = calls.filter((a) => a[0] === 'store')
  assert.deepEqual(stores[0], ['store', `--label=${bak(TS)}`, 'service', bak(TS), 'barrito-backup', '1'])
  assert.deepEqual(stores[1], ['store', `--label=barrito: ${SVC}`, 'service', SVC])
  assert.deepEqual(calls[0], ['lookup', 'service', SVC])
  assert.equal(store[bak(TS)]?.value, 'old')
  assert.equal(store[bak('2026-09-01T00:00:00')], undefined, 'pruned to 3')
  assert.deepEqual(backup.manifest.keychain, [{ kind: 'keychain', service: SVC, account: 'barrito', backup: bak(TS) }])

  const listed = kc.backups({ exec })
  assert.equal(JSON.stringify(listed).includes('old'), false)
  assert.equal(kc.restore(SVC, { exec, now })?.ts, TS)
  assert.equal(store[SVC]?.value, 'old')
  assert.equal(store[bak(TS)], undefined)
})

test('file: overwrite leaves a 0600 sibling backup, retention prunes, restore puts it back', () => {
  const dir = path.join(home, 'secrets')
  fs.mkdirSync(dir, { mode: 0o700 })
  const file = path.join(dir, 'gateway')
  const ref = `file:${file}`
  fs.writeFileSync(file, 'old-secret', { mode: 0o600 })
  const backup = handle()
  kc.set(ref, 'new-secret', { backup })

  const sib = `${file}.barrito-bak-${TS}`
  assert.equal(fs.readFileSync(sib, 'utf8'), 'old-secret')
  assert.equal(fs.statSync(sib).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(file, 'utf8'), 'new-secret')
  const json = fs.readFileSync(backup.write(), 'utf8')
  assert.deepEqual(JSON.parse(json).keychain, [{ kind: 'keychain', service: ref, account: 'barrito', backup: `${ref}.barrito-bak-${TS}` }])
  assert.equal(json.includes('secret"'), false)
  assert.equal(json.includes('old-secret') || json.includes('new-secret'), false)

  ;['2026-09-01T00:00:00', '2026-09-02T00:00:00', '2026-09-03T00:00:00'].forEach((ts) => fs.writeFileSync(`${file}.barrito-bak-${ts}`, ts, { mode: 0o600 }))
  kc.set(ref, 'newer', { now })
  assert.deepEqual(kc.backups({ files: [ref] }).map((b) => b.ts), ['2026-10-02T15:00:00', TS, '2026-09-03T00:00:00'])

  assert.equal(kc.restore(ref, { from: TS, now })?.ts, TS)
  assert.equal(fs.readFileSync(file, 'utf8'), 'old-secret')
  assert.equal(fs.existsSync(sib), false)
})

test('doctor: warns past retention and on a manifest backup that is gone', async () => {
  const { calls, exec: sec } = fakeSecurity({
    [SVC]: 'v',
    [bak('2026-09-01T00:00:00')]: 'a',
    [bak('2026-09-02T00:00:00')]: 'b',
    [bak('2026-09-03T00:00:00')]: 'c',
    [bak('2026-09-04T00:00:00')]: 'd',
  })
  const backup = create({ ts: TS })
  backup.secret({ kind: 'keychain', service: 'barrito: cursor work', account: 'barrito', backup: bak(TS, 'barrito: cursor work') })
  backup.write()
  const exec: Exec = (bin, args, opts) => {
    if (bin === '/usr/bin/security') return sec(bin, args, opts)
    throw new Error('not loaded')
  }
  const results = await diagnose(null, { exec, fetch: async () => { throw new Error('down') }, pathEnv: '', keychain: { get: () => null } })
  const warns = results.filter((r) => r.level === 'warn').map((r) => r.text).join('\n')
  assert.match(warns, /4 backups of "barrito: gateway work" exceed retention \(3\)/)
  assert.match(warns, /references missing backup "barrito backup: barrito: cursor work 2026-10-02T14:05" — uninstall --restore will skip/)
  assert.equal(calls.some((c) => c.args.includes('-w')), false, 'doctor never reads a secret for this')
})

test('uninstall --restore: overwritten keychain item comes back and is not deleted as an owned copy', async () => {
  const { store, exec: sec } = fakeSecurity({ [SVC]: 'pre-barrito', 'barrito: gateway personal': 'p' })
  const backup = create({ ts: TS })
  kc.set(SVC, 'junk', { exec: sec, backup })
  backup.write()
  const exec: Exec = (bin, args, opts) => bin === '/usr/bin/security' ? sec(bin, args, opts) : ''
  const identities = {
    work: { claude_config_dir: path.join(home, 'w'), keychain: { gateway: SVC } },
    personal: { claude_config_dir: path.join(home, 'p'), keychain: { gateway: 'barrito: gateway personal' } },
  }
  const printed: string[] = []
  await uninstall(['--restore', '--yes'], { config: { port: 4141, identities } as unknown as Config, print: (s: string) => printed.push(s), exit: () => undefined as never, io: { exec } })
  assert.equal(store[SVC], 'pre-barrito')
  assert.equal(store[bak(TS)], undefined)
  assert.equal(store['barrito: gateway personal'], undefined, 'other owned copies still go')
  assert.match(printed.join('\n'), /restored keychain "barrito: gateway work"/)
  assert.equal(printed.join('\n').includes('pre-barrito'), false)
})

test('uninstall --list-backups prints valid backups only; --from picks one', async () => {
  const dir = paths.backup
  const old = create({ ts: '2026-10-01T1000', dir, now: new Date('2026-10-01T10:00:00Z') })
  fs.writeFileSync(path.join(home, 'o.txt'), 'orig')
  old.save(path.join(home, 'o.txt'))
  old.write()
  create({ ts: '2026-10-02T0900', dir, now: new Date('2026-10-02T09:00:00Z') }).write()
  fs.mkdirSync(path.join(dir, 'pencil-20261002-1323'), { recursive: true })
  const printed: string[] = []
  const ctx = (io = {}) => ({ config: { port: 4141, identities: {} } as unknown as Config, print: (s: string) => printed.push(s), exit: () => undefined as never, io })
  await uninstall(['--list-backups'], ctx())
  const text = printed.join('\n')
  assert.match(text, /2026-10-02T0900 .*nothing to restore/)
  assert.match(text, /2026-10-01T1000 .*1 file\(s\)/)
  assert.ok(text.indexOf('2026-10-02T0900') < text.indexOf('2026-10-01T1000'))
  assert.doesNotMatch(text, /pencil/)

  fs.rmSync(path.join(home, 'o.txt'))
  await uninstall(['--restore', '--yes', '--from', '2026-10-01T1000'], ctx({ exec: () => '' }))
  assert.equal(fs.readFileSync(path.join(home, 'o.txt'), 'utf8'), 'orig')
})

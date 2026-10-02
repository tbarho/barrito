import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as real from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecFileSyncOptions } from 'node:child_process'
import { get, set, kind } from '../src/keychain/index.ts'
import type { SecretFs } from '../src/keychain/index.ts'
import * as linux from '../src/keychain/linux.ts'
import * as macos from '../src/keychain/macos.ts'
import type { Exec } from '../src/types.ts'

type Call = { bin: string; args: string[]; opts: ExecFileSyncOptions }

const recorder = (impl: Exec = () => '') => {
  const calls: Call[] = []
  const exec: Exec = (bin, args, opts = {}) => {
    calls.push({ bin, args, opts })
    return impl(bin, args, opts)
  }
  return { calls, exec }
}

// set env vars for the duration of fn, restoring the previous state after
const withEnv = (patch: Record<string, string | undefined>, fn: () => void): void => {
  const saved = Object.keys(patch).reduce<Record<string, string | undefined>>((memo, k) => {
    memo[k] = process.env[k]
    return memo
  }, {})
  Object.entries(patch).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
  try {
    fn()
  } finally {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    })
  }
}

const notFound = (): never => {
  throw Object.assign(new Error('The specified item could not be found in the keychain.'), { status: 44 })
}

const enoent = (): never => {
  throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' })
}

const dbus = (): never => {
  throw new Error('secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY')
}

const actionable = (name: string): RegExp =>
  new RegExp(`barrito: no keyring available \\(secret-tool/D-Bus\\) — use "env:VAR" or "file:/path" for ${name} in config\\.toml`)

const uid = process.getuid?.() ?? -1

// ── kind ──────────────────────────────────────────────────────────────────────

test('kind: env / file / keyring refs', () => {
  assert.equal(kind('env:AI_GATEWAY_API_KEY'), 'env')
  assert.equal(kind('file:~/secrets/gateway'), 'file')
  assert.equal(kind('Vercel AI Gateway Work'), 'keyring')
})

// ── macOS adapter (unchanged) ─────────────────────────────────────────────────

test('get: argv shape, no shell, trims output', () => {
  const { calls, exec } = recorder(() => 'sekret\n')
  assert.equal(macos.get('Vercel AI Gateway Work', { exec }), 'sekret')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.bin, '/usr/bin/security')
  assert.deepEqual(calls[0]?.args, ['find-generic-password', '-s', 'Vercel AI Gateway Work', '-w'])
  assert.equal(calls[0]?.opts.encoding, 'utf8')
})

test('get: not found → null', () => {
  const { exec } = recorder(notFound)
  assert.equal(macos.get('Missing', { exec }), null)
})

test('get: other keychain errors surface', () => {
  const { exec } = recorder(() => {
    throw Object.assign(new Error('could not be decoded'), { status: 45 })
  })
  assert.throws(() => macos.get('Broken', { exec }), /could not be decoded/)
})

test('get: empty value → null', () => {
  const { exec } = recorder(() => '\n')
  assert.equal(macos.get('Empty', { exec }), null)
})

test('set: secret goes via stdin, never argv; /usr/bin/security is on the trusted-app list', () => {
  const { calls, exec } = recorder()
  macos.set('Vercel AI Gateway Work', 'sekret', { exec })
  assert.deepEqual(calls[0]?.args, ['add-generic-password', '-U', '-s', 'Vercel AI Gateway Work', '-a', 'barrito', '-T', '/usr/bin/security', '-w'])
  assert.equal(calls[0]?.opts.input, 'sekret\nsekret\n')
  assert.equal(calls[0]?.opts.encoding, 'utf8')
  assert.equal(calls[0]?.args.includes('sekret'), false)
})

test('set: account override', () => {
  const { calls, exec } = recorder()
  macos.set('Cursor', 'k', { account: 'ty', exec })
  assert.deepEqual(calls[0]?.args, ['add-generic-password', '-U', '-s', 'Cursor', '-a', 'ty', '-T', '/usr/bin/security', '-w'])
  assert.equal(calls[0]?.opts.input, 'k\nk\n')
})

test('set: value never rides argv — only stdin (trusted-app flags are argv)', () => {
  const { calls, exec } = recorder()
  macos.set('Cursor', 'sekret', { account: 'vercel-cli', exec })
  assert.equal(calls[0]?.args.includes('sekret'), false)
  assert.equal(calls[0]?.opts.input, 'sekret\nsekret\n')
  assert.equal(calls[0]?.args.filter((a) => a === '-T').length, 1) // -T may repeat, value never does
})

// ── macOS account (attributes read for trust re-saves) ────────────────────────

const attrs = (acct: string): string =>
  `keychain: "/Users/x/Library/Keychains/login.keychain-db"\nversion: 512\nclass: "genp"\nattributes: {\n    "acct"<blob>="${acct}"\n    "svce"<blob>="Vercel AI Gateway"\n    "crtr"<uint32>="AAR"\n}`

test('account: reads "acct" from the find-generic-password attributes dump, no -w', () => {
  const { calls, exec } = recorder(() => attrs('vercel-cli'))
  assert.equal(macos.account('Vercel AI Gateway', { exec }), 'vercel-cli')
  assert.equal(calls[0]?.bin, '/usr/bin/security')
  assert.deepEqual(calls[0]?.args, ['find-generic-password', '-s', 'Vercel AI Gateway'])
})

test('account: not found → null, other errors surface', () => {
  const miss = recorder(notFound)
  assert.equal(macos.account('Missing', { exec: miss.exec }), null)
  const broken = recorder(() => {
    throw Object.assign(new Error('could not be decoded'), { status: 45 })
  })
  assert.throws(() => macos.account('Broken', { exec: broken.exec }), /could not be decoded/)
})

// ── env: refs ────────────────────────────────────────────────────────────────

test('env ref: reads injectable env', () => {
  assert.equal(get('env:AI_GATEWAY_API_KEY', { env: { AI_GATEWAY_API_KEY: 'vk_live' } }), 'vk_live')
})

test('env ref: default env is process.env', () => {
  withEnv({ AI_GATEWAY_API_KEY: 'vk_live', BARRITO_PLATFORM: 'linux' }, () => {
    assert.equal(get('env:AI_GATEWAY_API_KEY'), 'vk_live')
  })
})

test('env ref: missing or empty → null', () => {
  assert.equal(get('env:NOPE', { env: {} }), null)
  assert.equal(get('env:EMPTY', { env: { EMPTY: '' } }), null)
  assert.equal(get('env:BLANK', { env: { BLANK: '  \n' } }), null)
})

test('env ref: value trimmed like file refs', () => {
  assert.equal(get('env:TOKEN', { env: { TOKEN: ' vk_live \n' } }), 'vk_live')
})

test('env ref: set is read-only', () => {
  assert.throws(() => set('env:AI_GATEWAY_API_KEY', 'x', { env: {} }), /barrito: env: secrets are read-only/)
})

// ── file: refs ───────────────────────────────────────────────────────────────

const enoentErr = (msg: string) => Object.assign(new Error(msg), { code: 'ENOENT' })

const fakeFs = (over: Partial<SecretFs> = {}): SecretFs => ({
  readFileSync: () => { throw enoentErr('nope') },
  lstatSync: () => { throw enoentErr('nope') },
  statSync: () => { throw enoentErr('nope') },
  readlinkSync: () => '',
  openSync: () => 7,
  writeSync: () => 0,
  fsyncSync: () => {},
  closeSync: () => {},
  renameSync: () => {},
  mkdirSync: () => {},
  ...over,
})

test('file ref: trimmed contents from temp dir', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  try {
    writeFileSync(path.join(dir, 'gateway'), 'vk_live\n')
    assert.equal(get(`file:${path.join(dir, 'gateway')}`), 'vk_live')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file ref: missing file → null, other errors surface', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  try {
    assert.equal(get(`file:${path.join(dir, 'nope')}`), null)
    assert.throws(() => get('file:~/x', {
      fs: fakeFs({ lstatSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) } }),
    }), /EACCES/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file ref: ~ expands via BARRITO_HOME', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  withEnv({ BARRITO_HOME: dir }, () => {
    try {
      writeFileSync(path.join(dir, 'secret'), 'k\n')
      assert.equal(get('file:~/secret'), 'k')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('file ref: reads through a symlink to your own private file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  try {
    writeFileSync(path.join(dir, 'real'), 'vk_live\n')
    real.chmodSync(path.join(dir, 'real'), 0o600)
    real.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'))
    assert.equal(get(`file:${path.join(dir, 'link')}`), 'vk_live')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file ref: refuses a symlink to a group/world-readable file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  try {
    writeFileSync(path.join(dir, 'real'), 'vk\n') // default 0644: world-readable
    real.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'))
    assert.throws(() => get(`file:${path.join(dir, 'link')}`),
      /barrito: refusing to read file:.* — symlink target is not owned by you or is group\/world-accessible/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file ref: refuses a symlink owned by someone else (injected stats)', () => {
  const files = fakeFs({
    lstatSync: () => ({ isSymbolicLink: () => true, mode: 0o120777, uid: uid }),
    readlinkSync: () => '/attacker/target',
    statSync: () => ({ isSymbolicLink: () => false, mode: 0o600, uid: 12345 }),
  })
  assert.throws(() => get('file:~/link', { fs: files }), /barrito: refusing to read file:~\/link/)
})

test('file ref: dangling symlink → null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  try {
    real.symlinkSync(path.join(dir, 'nope'), path.join(dir, 'link'))
    assert.equal(get(`file:${path.join(dir, 'link')}`), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file ref: set writes 0600 atomically via O_EXCL + fsync + rename (injected fs)', () => {
  const calls: { fn: string; args: unknown[] }[] = []
  const files = fakeFs({
    statSync: () => ({ isSymbolicLink: () => false, mode: 0o755, uid: uid }),
    openSync: (file, flags, mode) => { calls.push({ fn: 'open', args: [file, flags, mode] }); return 7 },
    writeSync: (fd, data) => { calls.push({ fn: 'write', args: [fd, data] }); return data.length },
    fsyncSync: (fd) => { calls.push({ fn: 'fsync', args: [fd] }) },
    closeSync: (fd) => { calls.push({ fn: 'close', args: [fd] }) },
    renameSync: (from, to) => { calls.push({ fn: 'rename', args: [from, to] }) },
    mkdirSync: (dir, opts) => { calls.push({ fn: 'mkdir', args: [dir, opts] }) },
  })
  set('file:/tmp/xd/barrito/gateway', 'sekret', { fs: files })
  assert.deepEqual(calls[0]?.args, ['/tmp/xd/barrito', { recursive: true }])
  const opened = calls[1]
  assert.match(String(opened?.args[0]), /^\/tmp\/xd\/barrito\/gateway\.[0-9a-f]{12}\.tmp$/) // random, not predictable
  assert.equal(opened?.args[1], 'wx') // O_CREAT|O_EXCL — a pre-planted path fails
  assert.equal(opened?.args[2], 0o600)
  assert.deepEqual(calls[2]?.args, [7, 'sekret'])
  assert.deepEqual(calls[3]?.args, [7])
  assert.deepEqual(calls[4]?.args, [7])
  assert.deepEqual(calls[5]?.args, [opened?.args[0], '/tmp/xd/barrito/gateway'])
})

test('file ref: set refuses a pre-planted temp path (EEXIST)', () => {
  const files = fakeFs({
    statSync: () => ({ isSymbolicLink: () => false, mode: 0o755, uid: uid }),
    openSync: () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }) },
  })
  assert.throws(() => set('file:/tmp/xd/gateway', 'sekret', { fs: files }),
    /barrito: refusing to write file:\/tmp\/xd\/gateway — temp path already exists \(possible symlink attack\)/)
})

test('file ref: set refuses a symlinked destination, attacker target untouched', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  try {
    writeFileSync(path.join(dir, 'victim'), 'untouched')
    real.symlinkSync(path.join(dir, 'victim'), path.join(dir, 'gateway'))
    assert.throws(() => set(`file:${path.join(dir, 'gateway')}`, 'sekret'),
      /barrito: refusing to write file:.* — destination is a symlink/)
    assert.equal(real.readFileSync(path.join(dir, 'victim'), 'utf8'), 'untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file ref: set refuses a group/world-writable parent dir unless sticky', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  const sub = path.join(dir, 'sub')
  real.mkdirSync(sub)
  try {
    real.chmodSync(sub, 0o777)
    assert.throws(() => set(`file:${path.join(sub, 'gateway')}`, 'k'),
      /barrito: refusing to write file:.* — parent dir is group\/world-writable without the sticky bit/)
    real.chmodSync(sub, 0o1777) // sticky + writable (like /tmp) is fine
    set(`file:${path.join(sub, 'gateway')}`, 'k')
    assert.equal(real.readFileSync(path.join(sub, 'gateway'), 'utf8'), 'k')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file ref: set against a real temp dir lands 0600, tmp names never repeat', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'barrito-keychain-'))
  const opened: string[] = []
  const record = fakeFs({
    lstatSync: () => { throw enoentErr('nope') },
    statSync: (file) => real.statSync(file),
    openSync: (file, flags, mode) => { opened.push(file); return real.openSync(file, flags, mode) },
    writeSync: (fd, data) => real.writeSync(fd, data),
    fsyncSync: (fd) => real.fsyncSync(fd),
    closeSync: (fd) => real.closeSync(fd),
    renameSync: (from, to) => real.renameSync(from, to),
    mkdirSync: (d, opts) => real.mkdirSync(d, opts),
  })
  try {
    set(`file:${path.join(dir, 'nested', 'gateway')}`, 'sekret', { fs: record })
    set(`file:${path.join(dir, 'nested', 'gateway')}`, 'sekret2', { fs: record })
    assert.equal(opened.length, 2)
    assert.notEqual(opened[0], opened[1])
    assert.equal(real.readFileSync(path.join(dir, 'nested', 'gateway'), 'utf8'), 'sekret2')
    assert.equal(statSync(path.join(dir, 'nested', 'gateway')).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── linux adapter ─────────────────────────────────────────────────────────────

test('linux get: argv shape via secret-tool lookup', () => {
  const { calls, exec } = recorder(() => 'sekret\n')
  assert.equal(linux.get('Vercel AI Gateway Work', { exec }), 'sekret')
  assert.equal(calls[0]?.bin, 'secret-tool')
  assert.deepEqual(calls[0]?.args, ['lookup', 'service', 'Vercel AI Gateway Work'])
  assert.equal(calls[0]?.opts.encoding, 'utf8')
})

test('linux get: exit 1 (not found) → null', () => {
  const { exec } = recorder(() => {
    throw Object.assign(new Error('secret-tool: ...'), { status: 1 })
  })
  assert.equal(linux.get('Missing', { exec }), null)
})

test('linux get: empty output → null', () => {
  const { exec } = recorder(() => '\n')
  assert.equal(linux.get('Empty', { exec }), null)
})

test('linux get: ENOENT → actionable error naming the service', () => {
  const { exec } = recorder(enoent)
  assert.throws(() => linux.get('Vercel AI Gateway Work', { exec }), actionable('Vercel AI Gateway Work'))
})

test('linux get: no D-Bus session → actionable error', () => {
  const { exec } = recorder(dbus)
  assert.throws(() => linux.get('Cursor', { exec }), actionable('Cursor'))
})

test('linux get: other errors surface', () => {
  const { exec } = recorder(() => {
    throw Object.assign(new Error('secret-tool crashed'), { status: 2 })
  })
  assert.throws(() => linux.get('X', { exec }), /crashed/)
})

test('linux set: secret on stdin, never argv; label carries the name', () => {
  const { calls, exec } = recorder()
  linux.set('Vercel AI Gateway Work', 'sekret', { exec })
  assert.equal(calls[0]?.bin, 'secret-tool')
  assert.deepEqual(calls[0]?.args, ['store', '--label=barrito: Vercel AI Gateway Work', 'service', 'Vercel AI Gateway Work'])
  assert.equal(calls[0]?.opts.input, 'sekret\n')
  assert.equal(calls[0]?.args.includes('sekret'), false)
})

test('linux set: no keyring → actionable error', () => {
  const { exec } = recorder(enoent)
  assert.throws(() => linux.set('Cursor', 'k', { exec }), actionable('Cursor'))
})

test('linux available: true on clean lookup and on plain miss, false without keyring', () => {
  assert.equal(linux.available({ exec: () => '' }), true)
  assert.equal(linux.available({
    exec: () => {
      throw Object.assign(new Error('not found'), { status: 1 })
    },
  }), true)
  assert.equal(linux.available({ exec: recorder(enoent).exec }), false)
  assert.equal(linux.available({ exec: recorder(dbus).exec }), false)
})

// ── platform dispatch ────────────────────────────────────────────────────────

test('dispatch: BARRITO_PLATFORM picks the adapter', () => {
  const { calls, exec } = recorder(() => 'v')
  withEnv({ BARRITO_PLATFORM: 'linux' }, () => {
    assert.equal(get('X', { exec }), 'v')
    assert.equal(calls[0]?.bin, 'secret-tool')
  })
  withEnv({ BARRITO_PLATFORM: 'darwin' }, () => {
    assert.equal(get('X', { exec }), 'v')
    assert.equal(calls[1]?.bin, '/usr/bin/security')
  })
})

test('dispatch: process.platform honored without override', () => {
  const { calls, exec } = recorder(() => 'v')
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    assert.equal(get('X', { exec }), 'v')
    assert.equal(calls[0]?.bin, 'secret-tool')
  } finally {
    if (desc) Object.defineProperty(process, 'platform', desc)
  }
})

test('unsupported platform → clear error', () => {
  withEnv({ BARRITO_PLATFORM: undefined }, () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      assert.throws(() => get('X', { exec: () => '' }), /unsupported platform "win32" — macOS and Linux only/)
    } finally {
      if (desc) Object.defineProperty(process, 'platform', desc)
    }
  })
  withEnv({ BARRITO_PLATFORM: 'haiku' }, () => {
    assert.throws(() => get('X', { exec: () => '' }), /BARRITO_PLATFORM must be "darwin" or "linux"/)
  })
})

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { install, uninstall, status, restart, label, legacy, removeLegacy } from '../src/service/index.ts'
import type { InstallOpts } from '../src/service/index.ts'
import * as launchd from '../src/service/launchd.ts'
import type { Exec } from '../src/types.ts'

type Call = { bin: string; args: string[] }

const keys = ['BARRITO_HOME', 'BARRITO_LOG', 'BARRITO_PLATFORM']
let prev: Record<string, string | undefined>
let tmp: string
let dir: string
let calls: Call[] = []

beforeEach(() => {
  prev = Object.fromEntries(keys.map((k) => [k, process.env[k]] as const))
  tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-service-'))
  process.env.BARRITO_HOME = tmp
  process.env.BARRITO_LOG = path.join(tmp, 'logs', 'barrito.log')
  delete process.env.BARRITO_PLATFORM
  dir = path.join(tmp, 'LaunchAgents')
  calls = []
})

afterEach(() => {
  keys.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
})

const exec: Exec = (bin, args) => {
  calls.push({ bin, args })
  return ''
}
const uid = process.getuid!()
const opts = (e: Exec): InstallOpts => ({ bin: '/usr/local/bin/barrito', port: 4141, dir, exec: e, node: '/opt/node/bin/node', pathEnv: '/usr/bin:/bin', sleep: async () => {} })

const plistFile = (): string => path.join(dir, 'dev.barrito.router.plist')

test('install renders plist snapshot, bootout then bootstrap, in order', async () => {
  const xml = await install(opts(exec))
  assert.deepEqual(calls.map((c) => c.args[0]), ['bootout', 'bootstrap'])
  assert.deepEqual(calls[0], { bin: '/bin/launchctl', args: ['bootout', `gui/${uid}/dev.barrito.router`] })
  assert.deepEqual(calls[1]?.args, ['bootstrap', `gui/${uid}`, plistFile()])
  assert.equal(existsSync(plistFile()), true)
  assert.equal(existsSync(`${plistFile()}.tmp`), false)
  assert.equal(xml, readFileSync(plistFile(), 'utf8'))
  assert.equal(xml, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.barrito.router</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node/bin/node</string>
    <string>/usr/local/bin/barrito</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${process.env.BARRITO_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${process.env.BARRITO_LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BARRITO_PORT</key>
    <string>4141</string>
    <key>PATH</key>
    <string>/opt/node/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`)
})

test('bootout failure is ignored (not yet loaded)', async () => {
  calls = []
  const exec: Exec = (bin, args) => {
    calls.push({ bin, args })
    if (args[0] === 'bootout') throw new Error('No such process')
    return ''
  }
  await install(opts(exec))
  assert.deepEqual(calls.map((c) => c.args[0]), ['bootout', 'bootstrap'])
})

test('uninstall: bootout and remove plist', () => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(plistFile(), 'x')
  uninstall({ exec, dir })
  assert.deepEqual(calls[0]?.args, ['bootout', `gui/${uid}/dev.barrito.router`])
  assert.equal(existsSync(plistFile()), false)
})

test('render throws without bin or node', async () => {
  assert.throws(() => launchd.render({ port: 4141, logs: 'x' }), /install needs the node binary and the barrito bin path/)
  assert.throws(() => launchd.render({ bin: '/b', node: null, port: 4141, logs: 'x' }), /install needs the node binary/)
  await assert.rejects(() => install({ ...opts(exec), bin: undefined }), /install needs the node binary/)
  assert.equal(calls.length, 0) // fails before any launchctl call
})

test('status parses pid and state', () => {
  const exec: Exec = () => `dev.barrito.router = {
  active = true
  program = /usr/local/bin/barrito
  pid = 7085
  last exit status = 0
  state = running
`
  assert.deepEqual(status({ exec }), { running: true, pid: 7085 })
})

test('status: not loaded → running false, no throw', () => {
  const exec: Exec = () => {
    throw new Error('Could not find service')
  }
  assert.deepEqual(status({ exec }), { running: false, pid: null })
})

test('status: non-running state', () => {
  const exec: Exec = () => '  pid = 1\n  state = waiting\n'
  assert.deepEqual(status({ exec }), { running: false, pid: 1 })
})

test('restart: kickstart -k', () => {
  restart({ exec })
  assert.deepEqual(calls[0], { bin: '/bin/launchctl', args: ['kickstart', '-k', `gui/${uid}/dev.barrito.router`] })
})

test('removeLegacy: bootout legacy label and delete its plist', () => {
  mkdirSync(dir, { recursive: true })
  const legacyPlist = path.join(dir, `${legacy}.plist`)
  writeFileSync(legacyPlist, 'x')
  removeLegacy({ exec, dir })
  assert.deepEqual(calls[0]?.args, ['bootout', `gui/${uid}/com.tybarho.claude-router`])
  assert.equal(existsSync(legacyPlist), false)
})

test('label / legacy exports', () => {
  assert.equal(label, 'dev.barrito.router')
  assert.equal(legacy, 'com.tybarho.claude-router')
})

// ── linux / systemd dispatch ──────────────────────────────────────────────────

const unitFile = (): string => path.join(dir, 'barrito.service')

// systemctl succeeds, loginctl answers with the given Linger state
const linuxExec = (linger = 'yes'): Exec => (bin, args) => {
  calls.push({ bin, args })
  return bin === 'loginctl' ? `Linger=${linger}\n` : ''
}

test('dispatch: darwin routes to launchd', async () => {
  process.env.BARRITO_PLATFORM = 'darwin'
  await install(opts(exec))
  assert.deepEqual(calls[0], { bin: '/bin/launchctl', args: ['bootout', `gui/${uid}/dev.barrito.router`] })
})

test('linux: install writes the unit, daemon-reload, enable --now, checks linger', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const text = await install({ ...opts(linuxExec()), user: 'ty' })
  assert.deepEqual(calls.map((c) => ({ bin: c.bin, args: c.args })), [
    { bin: 'systemctl', args: ['--user', 'daemon-reload'] },
    { bin: 'systemctl', args: ['--user', 'enable', '--now', 'barrito'] },
    { bin: 'loginctl', args: ['show-user', 'ty', '--property=Linger'] },
  ])
  assert.equal(text, readFileSync(unitFile(), 'utf8'))
  assert.equal(existsSync(`${unitFile()}.tmp`), false)
  assert.equal(text, `[Unit]
Description=barrito router

[Service]
ExecStart="/opt/node/bin/node" "/usr/local/bin/barrito" serve
Restart=always
Environment="BARRITO_PORT=4141" "PATH=/opt/node/bin:/usr/bin:/bin"
StandardOutput=append:${process.env.BARRITO_LOG}
StandardError=append:${process.env.BARRITO_LOG}

[Install]
WantedBy=default.target
`)
})

test('linux: paths with spaces are quoted per systemd rules', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const text = await install({
    ...opts(linuxExec()),
    node: '/opt/node dir/bin/node',
    bin: '/usr/local bin/barrito',
    pathEnv: '/usr/local bin:/usr/bin',
    user: 'ty',
  })
  assert.equal(text.includes('ExecStart="/opt/node dir/bin/node" "/usr/local bin/barrito" serve'), true)
  assert.equal(text.includes('Environment="BARRITO_PORT=4141" "PATH=/opt/node dir/bin:/usr/local bin:/usr/bin"'), true)
})

test('linux: log path with whitespace refuses rather than writing a broken unit', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  process.env.BARRITO_LOG = path.join(tmp, 'logs with space', 'barrito.log')
  await assert.rejects(() => install(opts(linuxExec())), /log path must not contain whitespace or quotes/)
  assert.deepEqual(calls, []) // nothing written, nothing invoked
  assert.equal(existsSync(unitFile()), false)
})

test('linux: missing port throws — never "undefined" in the unit', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  await assert.rejects(() => install({ ...opts(linuxExec()), port: undefined }), /install needs a port for the systemd unit/)
  assert.equal(existsSync(unitFile()), false)
  const text = await install({ ...opts(linuxExec()), user: 'ty' })
  assert.equal(text.includes('undefined'), false)
})

test('linux: no user bus → actionable --detach error, nothing else runs', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const failing: Exec = (bin, args) => {
    calls.push({ bin, args })
    throw new Error('systemctl[1]: Failed to connect to bus: No medium found')
  }
  await assert.rejects(
    () => install({ ...opts(failing), user: 'ty' }),
    /barrito: no systemd user session — run `barrito serve --detach` instead/,
  )
  assert.deepEqual(calls, [{ bin: 'systemctl', args: ['--user', 'daemon-reload'] }])
})

test('linux: linger off prints the enable-linger note; on prints nothing', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const errors: string[] = []
  const real = console.error
  console.error = (s: string) => { errors.push(s) }
  try {
    await install({ ...opts(linuxExec('no')), user: 'ty' })
    await install({ ...opts(linuxExec('yes')), user: 'ty' })
  } finally {
    console.error = real
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /loginctl enable-linger ty` to keep barrito running after logout/)
})

test('linux: status parses systemctl show', () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const running: Exec = () => 'ActiveState=active\nMainPID=4242\n'
  assert.deepEqual(status({ exec: running }), { running: true, pid: 4242 })
  const inactive: Exec = () => 'ActiveState=inactive\nMainPID=0\n'
  assert.deepEqual(status({ exec: inactive }), { running: false, pid: null })
})

test('linux: restart via systemctl --user restart', () => {
  process.env.BARRITO_PLATFORM = 'linux'
  restart({ exec })
  assert.deepEqual(calls[0], { bin: 'systemctl', args: ['--user', 'restart', 'barrito'] })
})

test('linux: uninstall disables --now, removes the unit, reloads', () => {
  process.env.BARRITO_PLATFORM = 'linux'
  mkdirSync(dir, { recursive: true })
  writeFileSync(unitFile(), 'x')
  uninstall({ exec, dir })
  assert.deepEqual(calls.map((c) => c.args), [
    ['--user', 'disable', '--now', 'barrito'],
    ['--user', 'daemon-reload'],
  ])
  assert.equal(existsSync(unitFile()), false)
})

test('linux: uninstall tolerates an unloaded unit but not a missing bus', () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const failing: Exec = (_bin, args) => {
    if (args.includes('disable')) throw new Error('Failed to connect to bus: no user session')
    calls.push({ bin: _bin, args })
    return ''
  }
  assert.throws(() => uninstall({ exec: failing, dir }), /no systemd user session/)
  assert.deepEqual(calls, []) // daemon-reload never runs
  const unloaded: Exec = (bin, args) => {
    calls.push({ bin, args })
    if (args.includes('disable')) throw new Error('Unit barrito.service not loaded.')
    return ''
  }
  calls = []
  uninstall({ exec: unloaded, dir })
  assert.deepEqual(calls.map((c) => c.args), [['--user', 'disable', '--now', 'barrito'], ['--user', 'daemon-reload']])
})

test('linux: removeLegacy is a no-op', () => {
  process.env.BARRITO_PLATFORM = 'linux'
  removeLegacy({ exec, dir })
  assert.deepEqual(calls, [])
})

test('unsupported platform throws, not falls through to launchd', async () => {
  process.env.BARRITO_PLATFORM = 'win32'
  await assert.rejects(() => install(opts(exec)), /BARRITO_PLATFORM must be "darwin" or "linux"/)
})

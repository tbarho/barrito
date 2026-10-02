import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { root, home, paths } from '../paths.ts'
import type { Exec, ServiceStatus } from '../types.ts'
import type { InstallOpts } from './index.ts'

export const unit = 'barrito'

const units = (dir: string | undefined): string => dir || path.join(home(), '.config', 'systemd', 'user')
export const file = (dir: string | undefined): string => path.join(units(dir), `${unit}.service`)

const write = (file: string, data: string): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, data)
  renameSync(`${file}.tmp`, file)
}

export const run = (exec: Exec | undefined, args: string[]): string => {
  if (exec) return exec('systemctl', ['--user', ...args], { encoding: 'utf8' })
  return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8' })
}

const loginctl = (exec: Exec | undefined, args: string[]): string => {
  if (exec) return exec('loginctl', args, { encoding: 'utf8' })
  return execFileSync('loginctl', args, { encoding: 'utf8' })
}

// containers and CI have no user session bus — point at --detach instead
const noBus = (err: unknown): void => {
  if (/Failed to connect to bus/.test(String(err))) {
    throw new Error('barrito: no systemd user session — run `barrito serve --detach` instead')
  }
}

const must = (exec: Exec | undefined, args: string[]): string => {
  try {
    return run(exec, args)
  } catch (err) {
    noBus(err)
    throw err
  }
}

// systemd double-quotes: spaces inside are fine, " and \ cannot be written safely
const quoted = (v: string): string => {
  if (/["\\\n]/.test(v)) throw new Error(`barrito: systemd cannot quote a value containing ", \\ or a newline: ${v}`)
  return `"${v}"`
}

export const render = ({ node = process.execPath, bin, port, logs, pathEnv = process.env.PATH || '' }: {
  node?: string | null
  bin?: string
  port?: number
  logs?: string
  pathEnv?: string
}): string => {
  if (!node || !bin) throw new Error('service: install needs the node binary and the barrito bin path (node + bin)')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1) throw new Error('service: install needs a port for the systemd unit')
  const out = logs || ''
  // systemd cannot quote an append: path — refuse rather than write a broken unit
  if (/[\s"\\]/.test(out)) throw new Error(`barrito: log path must not contain whitespace or quotes (systemd cannot quote StandardOutput paths) — move it: ${out}`)
  const envPath = `${path.dirname(node)}:${pathEnv}`
  if (/["\\\n]/.test(envPath)) throw new Error(`barrito: PATH value cannot contain ", \\ or a newline: ${envPath}`)
  return readFileSync(path.join(root(), 'templates', 'barrito.service'), 'utf8')
    .replaceAll('__NODE__', quoted(node))
    .replaceAll('__BIN__', quoted(bin))
    .replaceAll('__PORT__', String(port))
    .replaceAll('__LOGS__', out)
    .replaceAll('__PATH__', envPath)
}

export const parse = (out: string): ServiceStatus => {
  const prop = (key: string): string | null => {
    const line = out.split('\n').find((l) => l.startsWith(`${key}=`))
    return line === undefined ? null : line.slice(key.length + 1)
  }
  return { running: prop('ActiveState') === 'active', pid: Number(prop('MainPID')) || null }
}

// linger keeps the user manager alive after logout; without it the router dies with the session
const note = (exec: Exec | undefined, user: string | undefined): void => {
  if (!user) return
  try {
    if (/^Linger=yes\b/m.test(loginctl(exec, ['show-user', user, '--property=Linger']))) return
  } catch {
    return
  }
  console.error(`run \`loginctl enable-linger ${user}\` to keep barrito running after logout`)
}

export const install = async ({ bin, port, exec, dir, node, pathEnv, user = process.env.USER }: InstallOpts = {}): Promise<string> => {
  const text = render({ node, bin, port, logs: paths.logs, pathEnv })
  write(file(dir), text)
  must(exec, ['daemon-reload'])
  must(exec, ['enable', '--now', unit])
  note(exec, user)
  return text
}

export const uninstall = ({ exec, dir }: { exec?: Exec; dir?: string } = {}): void => {
  try {
    run(exec, ['disable', '--now', unit])
  } catch (err) {
    noBus(err) // a unit that isn't loaded is fine; a missing bus is not
  }
  rmSync(file(dir), { force: true })
  must(exec, ['daemon-reload'])
}

export const status = ({ exec }: { exec?: Exec } = {}): ServiceStatus => {
  try {
    return parse(run(exec, ['show', unit, '--property=ActiveState,MainPID']))
  } catch {
    return { running: false, pid: null }
  }
}

export const restart = ({ exec }: { exec?: Exec } = {}): void => {
  must(exec, ['restart', unit])
}

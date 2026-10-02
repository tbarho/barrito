import { execFileSync } from 'node:child_process'
import type { ExecFileSyncOptions, ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import type { Exec } from '../types.ts'

const BIN = 'secret-tool'
const BACKUP = 'barrito backup: '

const run = (exec: Exec | undefined, args: string[], opts: ExecFileSyncOptions = {}): string => {
  const merged = { encoding: 'utf8', ...opts } as ExecFileSyncOptionsWithStringEncoding
  if (exec) return exec(BIN, args, merged)
  return execFileSync(BIN, args, merged)
}

// secret-tool exits 1 on "not found" — every other failure is a real error
const missed = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false
  return (err as { status?: unknown }).status === 1
}

// binary missing, or no D-Bus session / no secrets service behind it
const noKeyring = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === 'ENOENT') return true
  const msg = typeof e.message === 'string' ? e.message : ''
  return /Cannot autolaunch D-Bus|org\.freedesktop\.secrets/.test(msg)
}

const actionable = (service: string): Error =>
  new Error(`barrito: no keyring available (secret-tool/D-Bus) — use "env:VAR" or "file:/path" for ${service} in config.toml`)

export const get = (service: string, { exec }: { exec?: Exec } = {}): string | null => {
  let out: string
  try {
    out = run(exec, ['lookup', 'service', service])
  } catch (err) {
    if (noKeyring(err)) throw actionable(service)
    if (missed(err)) return null
    throw err
  }
  const value = String(out).trim()
  return value || null
}

// the secret goes via stdin, never argv — same rule as the macOS adapter
// backup items carry a barrito-backup attribute so list() can search for them
export const set = (service: string, value: string, { exec }: { exec?: Exec } = {}): void => {
  const backup = service.startsWith(BACKUP)
  const args = ['store', `--label=${backup ? service : `barrito: ${service}`}`, 'service', service, ...(backup ? ['barrito-backup', '1'] : [])]
  try {
    run(exec, args, { input: `${value}\n` })
  } catch (err) {
    if (noKeyring(err)) throw actionable(service)
    throw err
  }
}

// true when secret-tool exists and a D-Bus session answers — a plain lookup miss
// (exit 1) still proves both, since the call reached the secrets service
export const available = ({ exec }: { exec?: Exec } = {}): boolean => {
  try {
    run(exec, ['lookup', 'service', 'barrito-available-check'])
    return true
  } catch (err) {
    if (noKeyring(err)) return false
    return true
  }
}

export const del = (service: string, { exec }: { exec?: Exec } = {}): boolean => {
  try {
    run(exec, ['clear', 'service', service])
  } catch (err) {
    if (noKeyring(err)) throw actionable(service)
    if (missed(err)) return false
    throw err
  }
  return true
}

// backup item names only — search prints secrets too, but only attribute lines are kept
export const list = ({ exec }: { exec?: Exec } = {}): string[] => {
  let out: string
  try {
    out = run(exec, ['search', '--all', 'barrito-backup', '1'])
  } catch (err) {
    if (noKeyring(err)) throw actionable('backup items')
    if (missed(err)) return []
    throw err
  }
  return [...String(out).matchAll(/^attribute\.service = (.*)$/gm)].map((m) => m[1] ?? '')
}

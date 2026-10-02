import { execFileSync } from 'node:child_process'
import type { ExecFileSyncOptions, ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import type { Exec } from '../types.ts'

const security = (exec: Exec | undefined, args: string[], opts: ExecFileSyncOptions = {}): string => {
  const merged = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts } as ExecFileSyncOptionsWithStringEncoding
  if (exec) return exec('/usr/bin/security', args, merged)
  return execFileSync('/usr/bin/security', args, merged)
}

// `security` exits 44 ("could not be found in the keychain") on a miss
const notFound = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: unknown; message?: unknown }
  return e.status === 44 || /could not be found/i.test(typeof e.message === 'string' ? e.message : '')
}

export const get = (service: string, { exec }: { exec?: Exec } = {}): string | null => {
  let out: string
  try {
    out = security(exec, ['find-generic-password', '-s', service, '-w'])
  } catch (err) {
    if (notFound(err)) return null
    throw err
  }
  const value = String(out).trim()
  return value || null
}

// security's interactive-mode quoting: backslash and double quote are escaped
export const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// NEVER `add-generic-password -w` with no value: when a terminal is attached, `security`
// ignores stdin and prompts on /dev/tty, storing whatever the user types (a real incident:
// people type their login password there). The command goes to `security -i` on stdin, so
// the secret is in neither argv nor a prompt, then the value is read back and compared.
// -T puts the stable `security` binary on the item's trusted-app list: barrito always
// reads through /usr/bin/security, so trusting it survives node upgrades and reinstalls
export const set = (service: string, value: string, { account = 'barrito', exec }: { account?: string; exec?: Exec } = {}): void => {
  if (!value || /[\r\n]/.test(value)) throw new Error(`barrito: refusing to store an empty or multi-line secret in "${service}"`)
  const cmd = `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -T /usr/bin/security -w ${quote(value)}\n`
  security(exec, ['-i'], { input: cmd })
  const back = get(service, { exec })
  if (back !== value) throw new Error(`barrito: keychain write to "${service}" did not verify — nothing else was changed`)
}

// existence without reading the secret: no -w, so only the item's attributes are
// touched — an item another tool made can be probed without an access prompt
export const has = (service: string, { exec }: { exec?: Exec } = {}): boolean => {
  try {
    security(exec, ['find-generic-password', '-s', service])
  } catch (err) {
    if (notFound(err)) return false
    throw err
  }
  return true
}

// delete one of barrito's own items — items we created carry -T /usr/bin/security, so
// this never prompts; returns false when the item is already gone
export const del = (service: string, { exec }: { exec?: Exec } = {}): boolean => {
  try {
    security(exec, ['delete-generic-password', '-s', service])
  } catch (err) {
    if (notFound(err)) return false
    throw err
  }
  return true
}

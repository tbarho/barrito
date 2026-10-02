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

// with no value after -w, `security` prompts "password" + "retype password" on stdin
// (verified against the real CLI) — the secret goes via stdin, never argv
// -T puts the stable `security` binary on the item's trusted-app list: barrito always
// reads through /usr/bin/security, so trusting it survives node upgrades and reinstalls
// (without -T, only the creating binary's path is trusted — "Always Allow" rots)
export const set = (service: string, value: string, { account = 'barrito', exec }: { account?: string; exec?: Exec } = {}): void => {
  security(exec, ['add-generic-password', '-U', '-s', service, '-a', account, '-T', '/usr/bin/security', '-w'], { input: `${value}\n${value}\n` })
}

// the item's account name, from the attributes dump — a trust re-save preserves it
// (`find-generic-password -s <name>` prints `    "acct"<blob>="…"`, no secret)
export const account = (service: string, { exec }: { exec?: Exec } = {}): string | null => {
  let out: string
  try {
    out = security(exec, ['find-generic-password', '-s', service])
  } catch (err) {
    if (notFound(err)) return null
    throw err
  }
  const hit = /"acct"<blob>="([^"]*)"/.exec(out)
  return hit?.[1] || null
}

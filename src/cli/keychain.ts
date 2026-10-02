import { execFileSync } from 'node:child_process'
import { platform } from '../paths.ts'
import * as keychain from '../keychain/index.ts'
import { account as accountOf } from '../keychain/macos.ts'
import { keyringRefs } from '../detect.ts'
import type { CommandCtx, Exec } from '../types.ts'

export interface TrustOpts {
  exec?: Exec
  platform?: 'darwin' | 'linux'
}

const realExec: Exec = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

const why = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0] ?? 'error'
}

// re-save one item with /usr/bin/security on its trusted-app list — the value is read
// once (one prompt, expected) and goes back on stdin; it is never printed
const one = (name: string, exec: Exec): string[] => {
  const acct = accountOf(name, { exec })
  if (acct == null) return [`! skipped "${name}" (not in Keychain)`]
  let value: string | null
  try {
    value = keychain.get(name, { exec })
  } catch (err) {
    return [`! skipped "${name}" (read failed: ${why(err)})`]
  }
  if (value == null) return [`! skipped "${name}" (not in Keychain)`]
  try {
    keychain.set(name, value, { account: acct, exec })
  } catch (err) {
    return [`! skipped "${name}" (write failed: ${why(err)})`]
  }
  return [`✓ trusted "${name}"`]
}

// every keyring-kind secret the config references (gateway/cursor of all identities),
// re-saved so /usr/bin/security is on each item's trusted-app list — kills the repeated
// macOS prompts items made by other tools (or by older node paths) cause
export const trust = (
  identities: Record<string, { keychain?: Record<string, string | undefined> }>,
  { exec = realExec, platform: pf = platform() }: TrustOpts = {},
): string[] => {
  if (pf === 'linux') return ['no Keychain on linux — nothing to trust']
  const refs = [...new Set(keyringRefs(identities))]
  if (!refs.length) return ['no keychain items referenced by the config — nothing to trust']
  return refs.flatMap((name) => one(name, exec))
}

export default async (argv: string[], ctx: CommandCtx, opts: TrustOpts = {}): Promise<void> => {
  if (argv[0] !== 'trust') {
    ctx.print('usage: barrito keychain trust')
    return ctx.exit(2)
  }
  ctx.print('re-saving each item with /usr/bin/security trusted — one prompt per item is expected: click "Always Allow"')
  trust(ctx.config.identities, opts).forEach(ctx.print)
  return
}

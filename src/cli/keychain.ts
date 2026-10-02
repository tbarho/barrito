import { execFileSync } from 'node:child_process'
import { platform } from '../paths.ts'
import * as keychain from '../keychain/index.ts'
import * as cfg from '../config.ts'
import type { CommandCtx, Config, Exec, Identity } from '../types.ts'

export interface OwnOpts {
  exec?: Exec
  platform?: 'darwin' | 'linux'
  save?: (config: Config) => void
}

export interface Owned {
  lines: string[]
  changed: boolean
}

const realExec: Exec = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

const why = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0] ?? 'error'
}

// copy every foreign keyring ref the config holds into a barrito-owned item
// ("barrito: <slot> <identity>", account "barrito", -T /usr/bin/security) and rewrite
// the config's slots — one read per item, originals never modified or deleted
export const own = (
  identities: Record<string, Identity>,
  { exec = realExec, platform: pf = platform() }: OwnOpts = {},
): Owned => {
  if (pf === 'linux') return { lines: ['no Keychain on linux — nothing to own'], changed: false }
  const out: string[] = []
  const readOnce = new Map<string, string | null>()
  let changed = false
  for (const [id, identity] of Object.entries(identities)) {
    for (const [slot, ref] of Object.entries(identity.keychain ?? {})) {
      if (typeof ref !== 'string' || !ref || keychain.kind(ref) !== 'keyring') continue
      if (keychain.owned(ref)) {
        out.push(`✓ "${ref}" already barrito-owned`)
        continue
      }
      if (!readOnce.has(ref)) {
        try {
          readOnce.set(ref, keychain.get(ref, { exec })) // the one prompt per foreign item
        } catch (err) {
          readOnce.set(ref, null)
          out.push(`! skipped "${ref}" (read failed: ${why(err)})`)
          continue
        }
      }
      const value = readOnce.get(ref) ?? null
      if (value == null) {
        out.push(`! skipped "${ref}" (not in Keychain)`)
        continue
      }
      const to = keychain.ownName(slot, id)
      try {
        keychain.set(to, value, { exec }) // value on stdin, never argv
      } catch (err) {
        out.push(`! skipped "${ref}" (write failed: ${why(err)})`)
        continue
      }
      identity.keychain[slot] = to
      changed = true
      out.push(`✓ copied "${ref}" → "${to}" (original untouched)`)
    }
  }
  if (!out.length) return { lines: ['no keychain items referenced by the config — nothing to own'], changed: false }
  return { lines: out, changed }
}

export default async (argv: string[], ctx: CommandCtx, opts: OwnOpts = {}): Promise<void> => {
  if (argv[0] !== 'own' && argv[0] !== 'trust') {
    ctx.print('usage: barrito keychain own')
    return ctx.exit(2)
  }
  if (argv[0] === 'trust') ctx.print('trust runs own now — keys are copied into barrito-owned items instead of re-trusting foreign ones')
  ctx.print('copying each foreign key into a barrito-owned item — macOS will ask once per key; click Allow')
  const { lines, changed } = own(ctx.config.identities, opts)
  lines.forEach(ctx.print)
  if (changed) (opts.save ?? ((config: Config) => cfg.save(config)))(ctx.config)
}

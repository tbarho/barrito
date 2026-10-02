import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { platform } from '../paths.ts'
import * as keychain from '../keychain/index.ts'
import * as cfg from '../config.ts'
import { create } from '../ui.ts'
import type { CommandCtx, Config, Exec, Identity } from '../types.ts'

export interface OwnOpts {
  exec?: Exec
  fs?: keychain.SecretFs
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

const USAGE = 'usage: barrito keychain own | backups | restore <service> [--from <ts>]'

const fileRefs = (identities: Record<string, Identity>): string[] =>
  Object.values(identities).flatMap((i) => Object.values(i.keychain ?? {})).filter((r): r is string => typeof r === 'string' && keychain.kind(r) === 'file')

// names + timestamps only — a backup's value is never read here
const backups = (ctx: CommandCtx, { exec = realExec, fs }: OwnOpts): void => {
  const ui = create({ print: ctx.print })
  ui.section('Keychain backups')
  const items = keychain.backups({ exec, fs, files: fileRefs(ctx.config.identities) })
  if (!items.length) return ui.outro('no barrito backup items')
  items.forEach((b) => ui.row(`"${b.service}"  ${ui.c.dim(b.ts)}  ${ui.c.dim(b.backup)}`))
  ui.outro(`${items.length} backup item${items.length === 1 ? '' : 's'} ${ui.g.dot} barrito keychain restore <service> [--from <ts>]`)
}

const restore = (argv: string[], ctx: CommandCtx, { exec = realExec, fs }: OwnOpts): void => {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { from: { type: 'string' } } })
  const service = positionals[0]
  if (!service) {
    ctx.print(USAGE)
    return ctx.exit(2)
  }
  const ui = create({ print: ctx.print })
  ui.section('Keychain restore')
  const done = keychain.restore(service, { exec, fs, from: values.from })
  if (!done) {
    ui.warn(`no backup of "${service}"${values.from ? ` taken at ${values.from}` : ''} — barrito keychain backups`)
    ui.outro(ui.c.red('nothing restored'))
    return ctx.exit(1)
  }
  ui.item(ui.mark('ok'), `restored keychain "${service}" from ${done.ts}`)
  ui.outro('the value it replaced was backed up first')
}

export default async (argv: string[], ctx: CommandCtx, opts: OwnOpts = {}): Promise<void> => {
  if (argv[0] === 'backups') return backups(ctx, opts)
  if (argv[0] === 'restore') return restore(argv.slice(1), ctx, opts)
  if (argv[0] !== 'own' && argv[0] !== 'trust') {
    ctx.print(USAGE)
    return ctx.exit(2)
  }
  const ui = create({ print: ctx.print })
  ui.section('Keychain')
  if (argv[0] === 'trust') ui.note('trust runs own now — keys are copied into barrito-owned items instead of re-trusting foreign ones')
  ui.warn('copying each foreign key into a barrito-owned item — macOS will ask once per key; click Allow')
  const { lines, changed } = own(ctx.config.identities, opts)
  lines.forEach((line) => {
    if (line.startsWith('✓ ')) return ui.item(ui.mark('ok'), line.slice(2))
    if (line.startsWith('! ')) return ui.warn(line.slice(2))
    ui.row(line)
  })
  const copied = lines.filter((l) => l.startsWith('✓ copied')).length
  ui.outro(changed ? `${copied} key${copied === 1 ? '' : 's'} now barrito-owned ${ui.g.dot} config updated` : 'nothing changed')
  if (changed) (opts.save ?? ((config: Config) => cfg.save(config)))(ctx.config)
}

import { parseArgs } from 'node:util'
import pc from 'picocolors'
import { paths } from '../paths.ts'
import * as catalog from '../catalog.ts'
import { read as readSettings } from '../settings.ts'
import { base, postJson } from './status.ts'
import type { CatalogModel, CommandCtx, Identity } from '../types.ts'

// a short name (glm-5.3) against the cached catalog: exact bare-id suffix match
// on "/<value>" (case-insensitive, [1m] ignored); the identity's fallback chain
// wins, then picker rows; one hit → its full id, several → the candidates, none → null
const resolveShort = (value: string, models: CatalogModel[], identity: Identity): { id: string } | { ambiguous: string[] } | null => {
  const want = `/${value.toLowerCase()}`
  const lower = (id: string): string => catalog.bare(id).toLowerCase()
  const ids = [...new Set(models.filter((m) => lower(m.id).endsWith(want)).map((m) => m.id))]
  if (!ids.length) return null
  const inSet = (set: Set<string>): string[] => ids.filter((id) => set.has(lower(id)))
  const chain = new Set((identity.fallback ?? []).map(lower))
  const picker = identity.claude_config_dir
    ? new Set((readSettings(identity.claude_config_dir)?.modelPicker?.options ?? []).map((o) => catalog.bare(o.model)))
    : new Set<string>()
  const preferred = inSet(chain).length ? inSet(chain) : inSet(picker).length ? inSet(picker) : ids
  return preferred.length === 1 ? { id: preferred[0] ?? '' } : { ambiguous: preferred }
}

const send = async (ctx: CommandCtx, id: string, value: string): Promise<void> => {
  const res = await postJson(`${base(ctx.config)}/pin`, { identity: id, value })
  if (!res) {
    console.error('router not running — barrito doctor')
    return ctx.exit(1)
  }
  if (res.status !== 200) {
    console.error(`barrito: router rejected the pin (${res.status})`)
    return ctx.exit(1)
  }
  ctx.print(`pinned ${id} → ${value}`)
}

export default async (argv: string[], ctx: CommandCtx): Promise<void> => {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true })
  const [id, raw] = positionals
  if (!id || !raw) {
    console.error('usage: barrito pin <identity> <max|model>')
    return ctx.exit(2)
  }
  const identity = ctx.config?.identities?.[id]
  if (!identity) {
    console.error(`barrito: unknown identity "${id}" — have: ${Object.keys(ctx.config?.identities ?? {}).join(', ')}`)
    return ctx.exit(2)
  }

  const value = catalog.bare(raw)
  if (raw !== 'max' && !value.includes('/')) {
    const models = catalog.cached({ statePath: paths.state, stale: true })
    const resolved = models ? resolveShort(value, models, identity) : null
    if (!resolved) {
      console.error(`barrito: unknown model "${value}" — try barrito models search ${value}`)
      return ctx.exit(2)
    }
    if ('ambiguous' in resolved) {
      console.error(`barrito: "${value}" is ambiguous: ${resolved.ambiguous.join(', ')} — use the full id`)
      return ctx.exit(2)
    }
    return send(ctx, id, resolved.id)
  }
  if (raw !== 'max') {
    const models = catalog.cached({ statePath: paths.state })
    const known = models?.some((m) => m.id === value)
    if (models && !known) console.error(`${pc.yellow('!')} "${value}" is not in the cached gateway catalog — pinning anyway`)
  }
  return send(ctx, id, raw === 'max' ? 'max' : value)
}

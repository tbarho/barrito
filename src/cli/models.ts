import { parseArgs } from 'node:util'
import pc from 'picocolors'
import { save } from '../config.ts'
import { paths } from '../paths.ts'
import { get } from '../keychain/index.ts'
import * as catalog from '../catalog.ts'
import { per1m, sync } from '../models.ts'
import type { CatalogModel, CommandCtx, CommandFn, Config, Removed, SyncDir, SyncResult } from '../types.ts'

const loadCatalog = async (config: Config, { write = true }: { write?: boolean } = {}): Promise<{ models: CatalogModel[]; warnings: string[] }> => {
  const fresh = catalog.cached({ statePath: paths.state })
  if (fresh) return { models: fresh, warnings: [] }
  const identity = Object.values(config.identities ?? {})[0]
  const slot = identity?.keychain?.gateway
  const key = slot ? get(slot) : null
  try {
    return { models: await catalog.refresh({ key: key ?? undefined, statePath: paths.state, write }), warnings: [] }
  } catch (err) {
    const stale = catalog.last({ statePath: paths.state })
    if (!stale) throw err
    const date = new Date(stale.fetchedAt).toISOString().slice(0, 10)
    return { models: stale.data, warnings: [`! catalog refresh failed (${err instanceof Error ? err.message : String(err)}) — using cache from ${date}`] }
  }
}

const dirs = (config: Config): string[] => [...new Set(Object.values(config.identities ?? {})
  .map((identity) => identity.claude_config_dir).filter((d): d is string => !!d))]

const show = async (ctx: CommandCtx): Promise<void> => {
  const all = dirs(ctx.config)
  if (!all.length) return ctx.print('no identities in config')
  const { read } = await import('../settings.ts')
  all.forEach((dir) => {
    ctx.print(pc.bold(dir))
    const options = read(dir)?.modelPicker?.options ?? []
    if (!options.length) return ctx.print(`  no picker yet — run ${pc.bold('barrito models sync')}`)
    options.forEach((o) => ctx.print(`  ${o.label}\n    ${pc.dim(o.model)}\n    ${pc.dim(o.description ?? '')}`))
  })
}

const bucket = (b: SyncDir, models: CatalogModel[], ctx: CommandCtx): void => {
  b.added.forEach((id) => {
    const p = catalog.price(models, id)
    const money = p ? `${per1m(p.input)} / ${per1m(p.output)}   ` : ''
    ctx.print(`  ${pc.green('+')} ${id.padEnd(32)} ${money}${pc.green('new')}`)
  })
  b.removed.forEach(({ id, reason }: Removed) => ctx.print(reason === 'retired'
    ? `  ${pc.red('-')} ${id.padEnd(32)} ${pc.red('retired from gateway')}`
    : `  ${pc.red('-')} ${id.padEnd(32)} ${pc.red(`no longer matches your rules (barrito models add ${id} to keep)`)}`))
  b.updated.forEach((id) => ctx.print(`  ${pc.yellow('~')} ${id.padEnd(32)} ${pc.yellow('updated')}`))
  ctx.print(`  = ${b.unchanged.length} unchanged`)
}

const diff = (result: SyncResult, models: CatalogModel[], ctx: CommandCtx): void => {
  const healthy = result.dirs.filter((d) => d.ok)
  if (!healthy.length) return
  const [first] = healthy
  if (!first) return
  const sig = (b: SyncDir): string => JSON.stringify([b.added, b.removed, b.unchanged, b.updated])
  if (healthy.length === 1 || healthy.every((d) => sig(d) === sig(first))) return bucket(first, models, ctx)
  healthy.forEach((d) => {
    ctx.print(pc.bold(d.dir))
    bucket(d, models, ctx)
  })
}

const syncCmd = async (args: string[], ctx: CommandCtx): Promise<void> => {
  const { values } = parseArgs({
    args,
    options: {
      'dry-run': { type: 'boolean' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  })
  const { models, warnings } = await loadCatalog(ctx.config, { write: !values['dry-run'] })
  warnings.forEach((w) => ctx.print(pc.yellow(w)))
  const result = await sync({ config: ctx.config, catalog: models, dryRun: values['dry-run'], all: values.all })
  if (values.json) return ctx.print(JSON.stringify(result, null, 2))

  diff(result, models, ctx)
  result.dirs.filter((d) => !d.ok).forEach((d) => ctx.print(`${pc.red('✗')} ${d.dir}  ${d.error}`))
  result.skipped.forEach((p) => ctx.print(`${pc.yellow('!')} pinned ${p.id} skipped: ${p.why}`))
  result.protected.forEach((p) => ctx.print(`${pc.yellow('!')} kept hand-written ${p}`))
  result.missing.forEach((id) => ctx.print(`${pc.red('✗')} ${id}  not in gateway catalog`))
  ctx.print(`  → ${result.dirs.filter((d) => d.ok).map((d) => d.dir).join(', ')}`)
  if (values['dry-run']) ctx.print(pc.dim('(dry run — run `barrito models sync` to write)'))
  if (result.dirs.some((d) => !d.ok)) ctx.exit(1)
}

const search = async (args: string[], ctx: CommandCtx): Promise<void> => {
  const [q = ''] = args
  const { models, warnings } = await loadCatalog(ctx.config)
  warnings.forEach((w) => ctx.print(pc.yellow(w)))
  const hit = (m: CatalogModel): boolean => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(q.toLowerCase())
  const rows = models.filter(hit)
  if (!rows.length) return ctx.print(`no matches for "${q}"`)
  rows.forEach((m) => {
    const p = catalog.price(models, m.id)
    const money = p ? `${per1m(p.input)}/${per1m(p.output)} per 1M` : ''
    ctx.print(`${m.id.padEnd(40)} ${money.padEnd(24)} ${m.name ?? ''}`)
  })
}

const add = async (args: string[], ctx: CommandCtx): Promise<void> => {
  const [raw] = args
  if (!raw) return ctx.exit(2)
  const id = catalog.bare(raw)
  let models: CatalogModel[] | null = null
  try {
    ({ models } = await loadCatalog(ctx.config))
  } catch {
    models = null
  }
  const entry = models?.find((m) => m.id === id)
  if (entry) {
    const missing = (ctx.config.models?.require ?? []).filter((tag) => !(entry.tags ?? []).includes(tag))
    if (entry.type !== 'language' || missing.length) {
      ctx.print(`barrito models add: ${id} ${entry.type !== 'language' ? 'is not a language model' : `is missing ${missing.join(', ')}`}`)
      return ctx.exit(1)
    }
  }
  ctx.config.models.exclude = (ctx.config.models.exclude ?? []).filter((p) => catalog.bare(p) !== id)
  ctx.config.models.pin = [...new Set([...(ctx.config.models.pin ?? []), id])]
  save(ctx.config)
  ctx.print(`pinned ${id} — run ${pc.bold('barrito models sync')} to add it to the picker`)
}

const rm = async (args: string[], ctx: CommandCtx): Promise<void> => {
  const [raw] = args
  if (!raw) return ctx.exit(2)
  const id = catalog.bare(raw)
  ctx.config.models.pin = (ctx.config.models.pin ?? []).filter((p) => catalog.bare(p) !== id)
  ctx.config.models.exclude = [...new Set([...(ctx.config.models.exclude ?? []), id])]
  save(ctx.config)
  ctx.print(`unpinned and excluded ${id} — run ${pc.bold('barrito models sync')} to apply`)
}

export default (async (argv: string[], ctx: CommandCtx): Promise<void> => {
  const [sub, ...rest] = argv
  if (!sub) return show(ctx)
  if (sub === 'sync') return syncCmd(rest, ctx)
  if (sub === 'search') return search(rest, ctx)
  if (sub === 'add') return add(rest, ctx)
  if (sub === 'rm') return rm(rest, ctx)
  ctx.print(`barrito models: unknown subcommand "${sub}"`)
  ctx.exit(2)
}) satisfies CommandFn

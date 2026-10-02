import fs from 'node:fs'
import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { save } from '../config.ts'
import { expand, paths } from '../paths.ts'
import { build, run, runGit, scan, summaries, wire } from '../graft.ts'
import type { SummaryEnv } from '../graft.ts'
import { create, loc, prompts, tilde } from '../ui.ts'
import type { Ui } from '../ui.ts'
import type { Command, Config, Ctx, GraftRepo, MissingError, ScanEntry } from '../types.ts'

const HELP = `usage: barrito graft [add|rm|build] [path] [--summaries] [--json]

  barrito graft            scan graft.roots, pick repos (ranked by tracked LOC)
  barrito graft add <path> [--summaries]   wire + build one repo
  barrito graft rm <path>  drop a repo
  barrito graft build [path]               build graphs (all configured if no path)
  barrito graft --json     list configured repos as JSON`

const TRACKED =
  'graft init writes tracked files (.claude/, .mcp.json, AGENTS.md) — committing them stays your call per repo.'

type GraftCtx = Ctx & { config: Config }

const isRepo = (path: string): boolean => fs.existsSync(resolve(path, '.git'))

const entry = (config: Config, path: string): GraftRepo | undefined =>
  config.graft.repos.find((r) => r.path === path)

const isMissing = (err: unknown): err is MissingError =>
  err instanceof Error && (err as Partial<MissingError>).missing === true

const envFor = (path: string, { config }: { config: Config }): SummaryEnv | null => {
  try {
    return summaries(path, { config })
  } catch {
    return null
  }
}

const install = async (ui: Ui): Promise<boolean> => {
  const message = 'graft is missing. Install @nanonets/graft globally now?'
  const yes = await prompts(ui, 'aborted').confirm(message)
  ui.answered('install @nanonets/graft?', yes ? 'Yes' : 'No')
  if (!yes) return false
  run(['npm', 'install', '-g', '@nanonets/graft'])
  return true
}

const buildStep = (path: string, env: SummaryEnv | null, ui: Ui): void => {
  const { started } = build(path, { detached: true, env })
  if (started) return ui.item(ui.mark('ok'), `graph build started in the background: ${tilde(path)}`)
  ui.note(`graph build already running or recent: ${tilde(path)}`)
}

const wireAndBuild = async (path: string, { config, ui }: { config: Config; ui: Ui }): Promise<void> => {
  const env = envFor(path, { config })
  try {
    wire(path, { env })
  } catch (err) {
    if (!isMissing(err)) throw err
    if (!(await install(ui))) {
      ui.warn(`skipped ${tilde(path)} — graft not installed`)
      return
    }
    wire(path, { env })
  }
  buildStep(path, env, ui)
}

const saveRepos = (config: Config, repos: GraftRepo[]): void => {
  config.graft.repos = repos
  save(config)
}

const MESSAGE = 'Graft which repos?  (ranked by size)'

const pick = async ({ config, print }: GraftCtx): Promise<void> => {
  const ui = create({ print })
  ui.intro('barrito graft')
  const repos = scan({ roots: config.graft.roots, git: runGit, fs, state: paths.state })
  if (!repos.length) {
    ui.outro(`no git repos found under ${config.graft.roots.map(tilde).join(', ') || 'graft.roots'}`)
    return
  }
  const rel = (repo: string): string =>
    config.graft.roots.map((r) => relative(r, repo)).find((r) => r && !r.startsWith('..')) ?? tilde(repo)
  const size = (r: ScanEntry): string => `${r.partial ? '~' : ''}${loc(r.loc)}`
  const selected = await prompts(ui, 'aborted').multiselect(MESSAGE, {
    options: repos.map((r: ScanEntry) => ({ value: r.path, label: `${rel(r.path)}  ${size(r)}`, hint: r.remote })),
    initialValues: config.graft.repos.map((r) => r.path),
    required: false,
  })
  const picked = new Set(selected)
  const shown = repos.filter((r, i) => i < 15 || picked.has(r.path))
  ui.section(MESSAGE)
  ui.list(shown.map((r) => ({ label: rel(r.path), detail: size(r), on: picked.has(r.path) })))
  if (repos.length > shown.length) ui.note(`${repos.length - shown.length} more, smaller`)
  const prev = new Map(config.graft.repos.map((r): [string, GraftRepo] => [r.path, r]))
  saveRepos(config, selected.map((path) => prev.get(path) ?? { path, summaries: false }))
  const fresh = selected.filter((path) => !prev.has(path))
  if (fresh.length) {
    ui.section('Wiring')
    ui.warn(TRACKED)
  }
  for (const path of fresh) await wireAndBuild(path, { config, ui })
  ui.outro(`${selected.length} repo${selected.length === 1 ? '' : 's'} in graft.repos`)
}

const add = async (rest: string[], { config, print, exit }: GraftCtx): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { summaries: { type: 'boolean' } },
    allowPositionals: true,
  })
  const path = resolve(expand(positionals[0] ?? '.'))
  if (!isRepo(path)) {
    print(`barrito: not a git repo: ${path}`)
    return exit(1)
  }
  const existing = entry(config, path)
  const repos = config.graft.repos.filter((r) => r.path !== path)
  repos.push({
    path,
    summaries: values.summaries ?? existing?.summaries ?? false,
  })
  saveRepos(config, repos)
  const ui = create({ print })
  ui.section(`Graft ${ui.g.dot} ${tilde(path)}`)
  ui.warn(TRACKED)
  await wireAndBuild(path, { config, ui })
  ui.outro(`${tilde(path)} grafted (summaries ${values.summaries ? 'on' : 'off'})`)
}

const rm = async (rest: string[], { config, print, exit }: GraftCtx): Promise<void> => {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true })
  const path = resolve(expand(positionals[0] ?? '.'))
  if (!entry(config, path)) {
    print(`barrito: not in graft.repos: ${path}`)
    return exit(1)
  }
  saveRepos(config, config.graft.repos.filter((r) => r.path !== path))
  print(`${path} removed`)
}

const buildCmd = async (rest: string[], { config, print }: GraftCtx): Promise<void> => {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true })
  const targets = positionals.length
    ? positionals.map((x) => resolve(expand(x)))
    : config.graft.repos.map((r) => r.path)
  targets.forEach((path) => {
    const { started } = build(path, { detached: true, env: envFor(path, { config }) })
    if (started) return print(`graph build started: ${path}`)
    print(`graph build already running or recent: ${path}`)
  })
}

export default (async (argv: string[], ctx: Ctx): Promise<void> => {
  if (!ctx.config) {
    ctx.print('barrito graft: config not loaded')
    return ctx.exit(1)
  }
  const c = { ...ctx, config: ctx.config }
  const [sub, ...rest] = argv
  if (!sub) return pick(c)
  if (sub === '--help' || sub === '-h' || sub === 'help') return c.print(HELP)
  if (sub === '--json') return c.print(JSON.stringify(c.config.graft.repos, null, 2))
  if (sub === 'add') return add(rest, c)
  if (sub === 'rm') return rm(rest, c)
  if (sub === 'build') return buildCmd(rest, c)
  c.print(`barrito graft: unknown argument "${sub}"`)
  c.print(HELP)
  c.exit(2)
}) satisfies Command

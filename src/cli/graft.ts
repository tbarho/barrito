import fs from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { save } from '../config.ts'
import { expand, paths } from '../paths.ts'
import { build, run, runGit, scan, summaries, wire } from '../graft.ts'
import type { SummaryEnv } from '../graft.ts'
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

const install = async (): Promise<boolean> => {
  const yes = await p.confirm({ message: 'graft is missing. Install @nanonets/graft globally now?' })
  if (p.isCancel(yes) || !yes) return false
  run(['npm', 'install', '-g', '@nanonets/graft'])
  return true
}

const buildStep = (path: string, env: SummaryEnv | null): void => {
  const { started } = build(path, { detached: true, env })
  const name = pc.bold(path)
  if (started) return p.log.step(`graph build started in the background: ${name}`)
  p.log.info(`graph build already running or recent: ${name}`)
}

const wireAndBuild = async (path: string, { config }: { config: Config }): Promise<void> => {
  const env = envFor(path, { config })
  try {
    wire(path, { env })
  } catch (err) {
    if (!isMissing(err)) throw err
    if (!(await install())) {
      p.log.warn(`skipped ${path} — graft not installed`)
      return
    }
    wire(path, { env })
  }
  buildStep(path, env)
}

const saveRepos = (config: Config, repos: GraftRepo[]): void => {
  config.graft.repos = repos
  save(config)
}

const pick = async ({ config, exit }: GraftCtx): Promise<void> => {
  p.intro('barrito graft')
  const repos = scan({ roots: config.graft.roots, git: runGit, fs, state: paths.state })
  if (!repos.length) {
    p.outro('no git repos found under graft.roots')
    return
  }
  const selected = await p.multiselect({
    message: 'Graft which repos? (ranked by tracked LOC)',
    options: repos.map((r: ScanEntry) => ({
      value: r.path,
      label: `${r.path} · ${r.partial ? '~' : ''}${r.loc} loc`,
      hint: r.remote,
    })),
    initialValues: config.graft.repos.map((r) => r.path),
    required: false,
  })
  if (p.isCancel(selected)) {
    p.cancel('aborted')
    return exit(1)
  }
  const prev = new Map(config.graft.repos.map((r): [string, GraftRepo] => [r.path, r]))
  saveRepos(config, selected.map((path) => prev.get(path) ?? { path, summaries: false }))
  const fresh = selected.filter((path) => !prev.has(path))
  if (fresh.length) p.log.warn(TRACKED)
  for (const path of fresh) await wireAndBuild(path, { config })
  p.outro(`${selected.length} repo(s) in graft.repos`)
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
  p.log.warn(TRACKED)
  await wireAndBuild(path, { config })
  print(`${path} grafted (summaries ${values.summaries ? 'on' : 'off'})`)
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

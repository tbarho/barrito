import { parseArgs } from 'node:util'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import pc from 'picocolors'
import * as p from '@clack/prompts'
import type { Option } from '@clack/prompts'
import { parse as toml } from 'smol-toml'
import { paths, home, expand, platform, root } from '../paths.ts'
import { load } from '../config.ts'
import * as settings from '../settings.ts'
import * as keychain from '../keychain/index.ts'
import { available as linuxKeyring } from '../keychain/linux.ts'
import * as service from '../service/index.ts'
import { cached, refresh } from '../catalog.ts'
import { scan, runGit } from '../graft.ts'
import { account } from '../claude.ts'
import { detect, keyringRefs, probe } from '../detect.ts'
import { create as createBackup } from '../backup.ts'
import { plan, apply, histories, short } from '../migrate.ts'
import type { Action, GraftRun, ServiceIo, WriteKeychain } from '../migrate.ts'
import type { CatalogModel, Config, Ctx, Exec, Fetch, Identity, TransformState } from '../types.ts'

const CHAIN = ['zai/glm-5.3', 'deepseek/deepseek-v4.1-flash']
const FALLBACKS: Record<'cheap' | 'claude' | 'stop', string[]> = {
  cheap: CHAIN,
  claude: ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5'],
  stop: [],
}

const DEFAULTS: Record<'work' | 'personal', {
  claude_config_dir: string
  share_from?: string
  match: { remotes: string[]; paths: string[] }
  keychain: { gateway: string; cursor: string }
}> = {
  work: {
    claude_config_dir: '~/.claude',
    match: { remotes: [], paths: [] },
    keychain: { gateway: 'Vercel AI Gateway Work', cursor: 'Cursor Work' },
  },
  personal: {
    claude_config_dir: '~/.claude-personal',
    share_from: '~/.claude',
    match: { remotes: [], paths: [] },
    keychain: { gateway: 'Vercel AI Gateway', cursor: 'Cursor' },
  },
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

// no keyring (secret-tool/D-Bus missing, containers, CI) → env: refs, one var per slot
const envRef = (id: string, slot: 'gateway' | 'cursor'): string => {
  const base = slot === 'gateway' ? 'AI_GATEWAY_API_KEY' : 'CURSOR_API_KEY'
  return `env:${id === 'personal' ? base : `${base}_${id.toUpperCase().replaceAll('-', '_')}`}`
}

// one identity's answer sheet — built-in defaults, config entries, and the add-another prompts all produce one
type Def = {
  claude_config_dir: string
  share_from?: string
  match: { remotes: string[]; paths: string[] }
  keychain: { gateway?: string; cursor?: string }
  transforms?: Partial<TransformState>
}

const defOf = (id: string, raw: {
  claude_config_dir?: string
  share_from?: string | null
  match?: { remotes?: string[]; paths?: string[] }
  keychain?: Record<string, string>
  transforms?: Partial<TransformState>
}): Def => ({
  claude_config_dir: raw.claude_config_dir ?? `~/.claude-${id}`,
  share_from: raw.share_from ?? undefined,
  match: { remotes: raw.match?.remotes ?? [], paths: raw.match?.paths ?? [] },
  keychain: { gateway: raw.keychain?.gateway ?? '', cursor: raw.keychain?.cursor ?? '' },
  transforms: raw.transforms,
})

// a launchd plist needs a path that survives `npm cache clean` — npx runs don't
export const viaNpx = (
  script: string = process.argv[1] ?? '',
  env: { npm_config_user_agent?: string } = process.env,
): boolean =>
  /\/_npx\//.test(script) || /\bnpx\b/.test(env.npm_config_user_agent ?? '')

// the wizard's prompts — injectable so tests can script a fully interactive run
export interface Prompts {
  confirm: (message: string, opts?: { value?: boolean }) => Promise<boolean>
  text: (message: string, opts?: { default?: string; validate?: (value: string) => string | undefined }) => Promise<string>
  select: <V extends string>(message: string, opts: { initialValue?: V; options: Array<{ value: V; label: string; hint?: string }> }) => Promise<V>
  multiselect: <V extends string>(message: string, opts: { options: Array<{ value: V; label: string; hint?: string }>; initialValues?: V[]; required?: boolean }) => Promise<V[]>
}

const prompts: Prompts = {
  confirm: async (message, opts) => {
    const answer = await p.confirm({ message, initialValue: opts?.value })
    if (p.isCancel(answer)) {
      p.cancel('aborted — nothing written')
      process.exit(1)
    }
    return answer
  },
  text: async (message, opts) => {
    const answer = await p.text({ message, defaultValue: opts?.default, validate: opts?.validate })
    if (p.isCancel(answer)) {
      p.cancel('aborted — nothing written')
      process.exit(1)
    }
    return answer ?? ''
  },
  select: async <V extends string>(message: string, opts: { initialValue?: V; options: Array<{ value: V; label: string; hint?: string }> }) => {
    // @clack's Option<Value> is a deferred conditional — resolvable only through a cast
    const answer = await p.select<V>({ message, options: opts.options as Option<V>[], initialValue: opts.initialValue })
    if (p.isCancel(answer)) {
      p.cancel('aborted — nothing written')
      process.exit(1)
    }
    return answer
  },
  multiselect: async <V extends string>(message: string, opts: { options: Array<{ value: V; label: string; hint?: string }>; initialValues?: V[]; required?: boolean }) => {
    const answer = await p.multiselect<V>({ message, options: opts.options as Option<V>[], initialValues: opts.initialValues, required: opts.required })
    if (p.isCancel(answer)) {
      p.cancel('aborted — nothing written')
      process.exit(1)
    }
    return answer
  },
}

// everything the wizard does through the outside world, overridable from ctx.io in tests
export interface Io {
  exec: Exec
  spawn: (bin: string, args: string[], opts?: { env?: Record<string, string> }) => unknown
  keychain: WriteKeychain
  node: string
  pathEnv: string | undefined
  bin: string
  script: string | undefined
  shell?: string
  keyring?: (o: { exec?: Exec }) => boolean
  catalog?: CatalogModel[] | null
  sleep?: (ms: number) => Promise<void>
  fetch?: Fetch
  graftExec?: GraftRun
  service?: ServiceIo
  prompts?: Partial<Prompts>
}

// the real wiring — tests override via ctx.io with the same shape and never touch the Keychain
export const io: Io = {
  exec: (bin, args, opts) => execFileSync(bin, args, { encoding: 'utf8', ...opts }) as string,
  spawn: (bin, args, { env } = {}) => spawnSync(bin, args, { stdio: 'inherit', env: { ...process.env, ...env } }),
  keychain: { get: keychain.get, set: keychain.set },
  node: process.execPath,
  pathEnv: process.env.PATH,
  bin: fs.realpathSync(process.argv[1] ?? 'barrito') as string,
  script: process.argv[1],
  shell: process.env.SHELL,
  keyring: ({ exec }) => platform() === 'linux' ? linuxKeyring({ exec }) : true,
}

// dry-run must write nothing, so a cold cache fetches through a no-write fs
const voidFs = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  mkdirSync: () => {},
  mkdir: async () => {},
  writeFile: async () => {},
  rename: async () => {},
}

const catalog = async (config: Config, deps: Io, dry: boolean | undefined): Promise<CatalogModel[]> => {
  const hit = cached({ statePath: paths.state })
  if (hit) return hit
  const gateway = Object.values(config.identities ?? {})[0]?.keychain?.gateway
  const key = gateway != null ? deps.keychain.get(gateway) ?? undefined : undefined
  const statePath = paths.state
  return dry ? refresh({ key, statePath, fetch: deps.fetch, fs: voidFs }) : refresh({ key, statePath })
}

export default async (argv: string[], ctx: Ctx & { io?: Io }): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' } },
  })
  const dry = values['dry-run']
  const yes = values.yes
  const deps = { ...io, ...ctx.io } as Io
  const ui: Prompts = {
    confirm: deps.prompts?.confirm ?? prompts.confirm,
    text: deps.prompts?.text ?? prompts.text,
    select: deps.prompts?.select ?? prompts.select,
    multiselect: deps.prompts?.multiselect ?? prompts.multiselect,
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root(), 'package.json'), 'utf8')) as { version?: string }

  const current = load()
  const ts = new Date().toISOString().slice(0, 16)
  const pf = platform()

  // --yes takes every prompt's default; interactive runs go through ui
  const ask = async (message: string, { value = true }: { value?: boolean } = {}): Promise<boolean> =>
    yes ? value : ui.confirm(message, { value })

  p.intro(`barrito v${pkg.version} · one router, every identity`)
  const detected = detect({ home: home(), exec: deps.exec, fs, path: deps.pathEnv, keychain: deps.keychain, shell: deps.shell })

  p.log.step('Agents found')
  p.log.message(detected.agents.map((a) => `${a.name} ${a.version}`.trim()).join(' · '))
  if (detected.hosts.length) p.log.message(`hosts: ${detected.hosts.join(', ')}`)

  const { launchd, shims, envrcLinks } = detected.legacy
  let replace = true
  if (launchd || shims.length > 0 || envrcLinks.length > 0) {
    p.log.step('Existing setup found')
    p.log.message([
      launchd && `claude-router (launchd :${current.port})`,
      `${shims.length} shims`,
      `${envrcLinks.length} .envrc symlinks`,
    ].filter(Boolean).join(' · '))
    replace = await ask(`back up to ${short(paths.backup)}/${ts} and replace?`)
  }

  let fallback: 'cheap' | 'claude' | 'stop' = 'cheap'
  if (!yes) {
    p.log.step('When Max runs out')
    fallback = await ui.select('When Max runs out', {
      initialValue: 'cheap',
      options: [
        { value: 'cheap', label: 'cheap first, loudly', hint: 'glm-5.3 → deepseek-v4.1-flash' },
        { value: 'claude', label: 'same Claude model on gateway credits' },
        { value: 'stop', label: 'stop and tell me' },
      ],
    })
  }

  // token savers: rtk compression + caveman replies — a config that already has [transforms] wins
  const hasTransforms = (file: string): boolean => {
    try {
      return 'transforms' in (toml(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    } catch {
      return false
    }
  }
  const onPath = (exec: Exec, bin: string): boolean => {
    try {
      return exec('which', [bin]).trim().length > 0
    } catch {
      return false
    }
  }
  const txStep = !hasTransforms(paths.config)
  let tx: TransformState = current.transforms ?? { rtk: true, caveman: 'lite' }
  if (txStep) {
    if (!onPath(deps.exec, 'rtk')) p.log.warn('rtk not found on PATH — brew install rtk (github.com/rtk-ai/rtk), then re-run barrito init')
  }
  if (pf === 'darwin' && !onPath(deps.exec, 'terminal-notifier')) {
    p.log.info('notifications will show no burrito icon — brew install terminal-notifier')
  }
  if (txStep && !yes) {
    p.log.step('Token savers')
    const rtk = await ask('Compress tool output with rtk?', { value: true })
    tx = {
      rtk,
      caveman: await ui.select('How terse should replies be? (caveman)', {
        initialValue: 'lite',
        options: [
          { value: 'off', label: 'off — full replies' },
          { value: 'lite', label: 'lite — terser replies' },
          { value: 'full', label: 'full — very terse replies' },
          { value: 'ultra', label: 'ultra — caveman' },
        ],
      }),
    }
  }

  let share = true
  let historiesAnswer = true
  // no keyring on this machine → identities carry env: refs instead of keyring names
  const keyringOk = deps.keyring?.({ exec: deps.exec }) ?? pf !== 'linux'
  if (!keyringOk) {
    p.log.warn('no keyring available (secret-tool/D-Bus missing) — identities use env: refs instead of keychain names; export the variables below, or install gnome-keyring + secret-tool and rerun barrito init')
  }
  const refFor = (id: string, names: { gateway?: string; cursor?: string }): { gateway: string; cursor: string } => {
    const keep = (ref: string | undefined) => keyringOk || keychain.kind(ref ?? '') !== 'keyring'
    return {
      gateway: keep(names.gateway) ? names.gateway ?? '' : envRef(id, 'gateway'),
      cursor: keep(names.cursor) ? names.cursor ?? '' : envRef(id, 'cursor'),
    }
  }

  // identities: the config's, or the two built-ins on a fresh machine — then as many more as the user wants
  const fresh = Object.keys(current.identities ?? {}).length === 0
  const base: Record<string, Def> = fresh
    ? Object.fromEntries(Object.entries(DEFAULTS).map(([id, def]) => [id, defOf(id, def)]))
    : Object.fromEntries(Object.entries(current.identities).map(([id, raw]) => [id, defOf(id, raw)]))
  // the two match prompts every identity gets — the built-ins on a fresh machine and "add another" alike
  const matchFor = async (name: string): Promise<{ remotes: string[]; paths: string[] }> => {
    const remotes = await ui.text('remotes glob (e.g. github.com/owner/*)', { default: `github.com/${name}/*` })
    const pathsGlob = await ui.text('paths glob (e.g. ~/Code/owner/**)', { default: `~/Code/${name}/**` })
    return { remotes: remotes ? [remotes] : [], paths: pathsGlob ? [pathsGlob] : [] }
  }
  if (!yes && fresh) {
    // the built-ins carry no globs of their own — ask, with the same prompts as any other identity
    for (const [id, def] of Object.entries(base)) base[id] = { ...def, match: await matchFor(id) }
  } else if (fresh) {
    p.log.warn(`work and personal have no match globs yet — every directory resolves to the default identity until match.remotes/match.paths are set (rerun barrito init, or edit ${short(paths.config)})`)
  }
  if (!yes) {
    while (await ask('Add another identity?', { value: false })) {
      const name = await ui.text('identity name (a-z0-9, - and _)', {
        validate: (v) => !NAME_RE.test(v)
          ? 'must match /^[a-z0-9][a-z0-9_-]{0,31}$/'
          : base[v] ? `"${v}" is already configured` : undefined,
      })
      const match = await matchFor(name)
      const dir = await ui.text('claude config dir', { default: `~/.claude-${name}` })
      const gateway = await ui.text('gateway secret (keychain item name; env:VAR or file:~/path when there is no keyring)', {
        default: keyringOk ? `Vercel AI Gateway ${name}` : envRef(name, 'gateway'),
        validate: (v) => v ? undefined : 'required — the router needs a gateway key for this identity',
      })
      const cursor = await ui.text('cursor secret (optional — keychain item name, env:VAR, file:~/path; empty to skip)', {
        default: keyringOk ? `Cursor ${name}` : envRef(name, 'cursor'),
      })
      base[name] = {
        claude_config_dir: dir,
        match,
        keychain: { gateway, cursor },
      }
    }
  }
  const identities = Object.entries(base).reduce<Record<string, Identity>>((memo, [id, def]) => {
    memo[id] = {
      id,
      claude_config_dir: expand(def.claude_config_dir),
      share_from: def.share_from ? expand(def.share_from) : null,
      fallback: FALLBACKS[fallback],
      match: { remotes: def.match.remotes, paths: def.match.paths.map(expand) },
      keychain: refFor(id, def.keychain),
      ...(def.transforms ? { transforms: def.transforms } : {}),
    }
    return memo
  }, {})

  let defaultId = current.default
  const ids = Object.keys(identities)
  if (!yes && ids.length > 1) {
    defaultId = await ui.select('default identity?', {
      initialValue: ids.includes(defaultId) ? defaultId : undefined,
      options: ids.map((id) => ({ value: id, label: id })),
    })
  }

  const show = (ref: string): string => keychain.kind(ref) === 'keyring' ? `keychain "${ref}"` : ref
  const have = (ref: string): boolean => {
    try { return deps.keychain.get(ref) != null } catch { return false }
  }
  for (const [id, identity] of Object.entries(identities)) {
    p.log.step(`Identity · ${id}${id === defaultId ? ' (default)' : ''}`)
    p.log.message(`match    ${identity.match.remotes.join('  ')}  ${identity.match.paths.map(short).join('  ')}`)
    // a just-added identity is not in the config yet, so check its dir directly
    const login = detected.claudeDirs.find((d) => d.dir === identity.claude_config_dir) ?? account(identity.claude_config_dir, { fs, home: home() })
    p.log.message(`claude   ${short(identity.claude_config_dir)}  ${login.loggedIn ? `✓ logged in (${login.email})` : '✗ not logged in'}`)
    if (!login.loggedIn && !dry && await ask(`login now? (CLAUDE_CONFIG_DIR=${short(identity.claude_config_dir)} claude /login)`, { value: false })) {
      deps.spawn('claude', ['/login'], { env: { CLAUDE_CONFIG_DIR: identity.claude_config_dir } })
    }
    const gateway = identity.keychain.gateway ?? ''
    p.log.message(`gateway  ${show(gateway)}  ${have(gateway) ? '✓' : '✗'}`)
    if (!have(gateway) && gateway.startsWith('env:')) p.log.message(`  export ${gateway.slice(4)}=<vercel ai gateway key>`)
    const cursor = identity.keychain.cursor ?? ''
    p.log.message(`cursor   ${show(cursor)}  ${have(cursor) ? '✓' : '✗'}`)
    if (!have(cursor) && cursor.startsWith('env:')) p.log.message(`  export ${cursor.slice(4)}=<cursor key>`)
    if (identity.share_from && id === 'personal') {
      share = await ask(`share rules/skills/agents from ${short(identity.share_from)}?`)
      if (share) p.log.message(`share rules/skills/agents from ${short(identity.share_from)}`)
      const dirs = histories(identity, fs)
      if (dirs.length) {
        historiesAnswer = await ask(`copy ${dirs.length} personal project histories to ${short(identity.claude_config_dir)}?`)
        if (historiesAnswer) p.log.message(`copy ${dirs.length} personal project histories to ${short(identity.claude_config_dir)}`)
      }
    }
  }

  const roots = current.graft.roots.length ? current.graft.roots : ['~/Code', '~/emdash/repositories'].map(expand)
  let repos = current.graft.repos
  if (!yes) {
    const found = scan({ roots, git: runGit, fs, state: dry ? null : paths.state })
    if (found.length) {
      const prev = new Map(repos.map((r): [string, typeof r] => [r.path, r]))
      const selected = await ui.multiselect('Graft which repos?  (ranked by tracked LOC)', {
        options: found.slice(0, 15).map((r: { path: string; remote: string; loc: number }) => ({ value: r.path, label: `${short(r.path)}  ${r.loc} loc`, hint: r.remote })),
        initialValues: repos.map((r) => r.path),
        required: false,
      })
      repos = selected.map((path_) => prev.get(path_) ?? { path: path_, summaries: false })
    }
  }

  let bin = deps.bin
  if (viaNpx(deps.script)) {
    p.log.warn(`running via npx — the ${pf === 'linux' ? 'systemd' : 'launchd'} service needs a stable path`)
    const go = await ask('install barrito globally now? (npm install -g barrito)', { value: false })
    if (go) {
      deps.exec('npm', ['install', '-g', 'barrito'])
      bin = deps.exec('which', ['barrito']).trim() || bin
    }
    if (bin === deps.bin) p.log.warn(`service will run ${bin} — reinstall globally and rerun \`barrito init\` for a stable path`)
  }
  // shims bake node + barrito paths at generation time — bake the stable bin, not this npx run
  process.argv[1] = bin

  const next = {
    port: current.port,
    default: defaultId,
    identities,
    models: current.models,
    graft: { roots, repos },
    harness: current.harness,
    transforms: tx,
  }
  let models: CatalogModel[] | null = null
  try {
    models = deps.catalog ?? await catalog(next, deps, dry)
  } catch {
    p.log.warn('gateway catalog unavailable — run `barrito models sync` once the router is up')
  }
  // detect read the config before the wizard's identities existed — probe their keyring refs
  // too, so a custom cursor item that already holds a key never re-plans the cursor-keys move
  const keychainState = { ...detected.keychain, ...probe(keyringRefs(identities), deps.keychain) }
  // a config without [transforms] must reach plan() transforms-less — load() injects the
  // defaults, which would hide a first-time [transforms] write from canon's diff
  const carried: Partial<Config> = txStep ? { ...current, transforms: undefined } : current
  const actions = plan({ ...detected, keychain: keychainState }, { config: next, existing: carried, replace, share, histories: historiesAnswer, ts, bin, fs, catalog: models })

  p.log.step('Plan')
  const sign: Partial<Record<Action['kind'], string>> = { backup: pc.dim('~'), bootout: pc.red('-'), shims: pc.yellow('±'), envrc: pc.red('-'), note: pc.yellow('!') }
  if (!actions.length) p.log.message('nothing to write — everything is already in place')
  actions.forEach((a) => ctx.print(`  ${sign[a.kind] ?? pc.green('+')} ${a.description}`))
  if (dry) {
    p.outro(pc.dim('(dry run — nothing written)'))
    return
  }
  const go = await ask('write it?')
  if (!go) {
    p.cancel('aborted — nothing written')
    return ctx.exit(1)
  }

  const backup = createBackup({ ts, dir: paths.backup, fs })
  await apply(actions, {
    backup,
    exec: deps.exec,
    fs,
    keychain: deps.keychain,
    service: deps.service ?? service,
    settings,
    config: next,
    catalog: models,
    print: (s) => ctx.print(s),
    bin,
    graftExec: deps.graftExec,
    node: deps.node,
    pathEnv: deps.pathEnv,
    sleep: deps.sleep,
    agentsDir: pf === 'darwin' ? path.join(home(), 'Library', 'LaunchAgents') : undefined,
  })

  const shimNames = actions.find((a) => a.kind === 'shims')?.names
  const wrote = [
    'Wrote config',
    shimNames && `${shimNames.length} shims`,
    actions.some((a) => a.kind === 'service') && (pf === 'linux' ? 'barrito (systemd)' : 'dev.barrito.router'),
    actions.some((a) => a.kind === 'path-rc') && 'PATH line',
    actions.some((a) => a.kind === 'settings') && 'statusline',
  ].filter(Boolean).join(', ')
  p.outro(`${wrote}.
Restart emdash and Conductor once so they pick up PATH.
Next: barrito doctor`)
}

import { parseArgs } from 'node:util'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
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
import type { ClaudeAccount } from '../detect.ts'
import { create as createBackup } from '../backup.ts'
import { plan, apply, short } from '../migrate.ts'
import { outstanding } from '../history.ts'
import { create, loc, prompts, version } from '../ui.ts'
import type { Level, Prompts } from '../ui.ts'
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

export type { Prompts } from '../ui.ts'

// everything the wizard does through the outside world, overridable from ctx.io in tests
export interface Io {
  exec: Exec
  spawn: (bin: string, args: string[], opts?: { env?: Record<string, string> }) => unknown
  keychain: WriteKeychain
  account: (dir: string) => ClaudeAccount
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
  // child stdio is always piped: probes like `launchctl print` of a missing service
  // write "Bad request." to stderr, and init reports findings itself
  exec: (bin, args, opts) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }) as string,
  spawn: (bin, args, { env } = {}) => spawnSync(bin, args, { stdio: 'inherit', env: { ...process.env, ...env } }),
  keychain: { get: keychain.get, has: keychain.has, set: keychain.set },
  account: (dir) => account(dir, { fs, home: home() }),
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
  // reading a foreign Keychain item would prompt on macOS — models sync reads the
  // barrito-owned copy after adoption, so skip the key for refs barrito doesn't own
  const readable = gateway != null && !(platform() === 'darwin' && keychain.kind(gateway) === 'keyring' && !keychain.owned(gateway))
  const key = readable ? deps.keychain.get(gateway!) ?? undefined : undefined
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
  const ui = create({ print: ctx.print })
  const { g, c } = ui
  const real = prompts(ui)
  const q: Prompts = {
    confirm: deps.prompts?.confirm ?? real.confirm,
    text: deps.prompts?.text ?? real.text,
    select: deps.prompts?.select ?? real.select,
    multiselect: deps.prompts?.multiselect ?? real.multiselect,
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root(), 'package.json'), 'utf8')) as { version?: string }

  const current = load()
  const ts = new Date().toISOString().slice(0, 16)
  const pf = platform()

  // --yes takes every prompt's default; either way the answer lands inline in the spine
  const ask = async (message: string, { value = true, label = message }: { value?: boolean; label?: string } = {}): Promise<boolean> => {
    const answer = yes ? value : await q.confirm(message, { value })
    ui.answered(label, answer ? 'Yes' : 'No')
    return answer
  }
  const say = async (message: string, label: string, opts: { default?: string; validate?: (value: string) => string | undefined } = {}): Promise<string> => {
    const answer = await q.text(message, opts)
    ui.answered(label, answer || c.dim('none'))
    return answer
  }
  const onPath = (exec: Exec, bin: string): boolean => {
    try {
      return exec('which', [bin]).trim().length > 0
    } catch {
      return false
    }
  }

  ui.intro(`barrito v${pkg.version} ${g.dot} one router, every identity`)
  const detected = detect({ home: home(), exec: deps.exec, fs, path: deps.pathEnv, keychain: deps.keychain, shell: deps.shell })

  ui.section('Agents found', [detected.agents.map((a) => `${a.name} ${version(a.version)}`.trim()).join(` ${g.dot} `) || c.dim('none on PATH')])
  if (detected.hosts.length) ui.row(`${c.dim('hosts')}  ${detected.hosts.join(` ${g.dot} `)}`)
  if (pf === 'darwin' && !onPath(deps.exec, 'terminal-notifier')) {
    ui.warn('notifications will show no burrito icon — brew install terminal-notifier')
  }

  const { launchd, shims, envrcLinks } = detected.legacy
  let replace = true
  if (launchd || shims.length > 0 || envrcLinks.length > 0) {
    ui.section('Existing setup found', [[
      launchd && `claude-router (launchd :${current.port})`,
      `${shims.length} shims`,
      `${envrcLinks.length} .envrc links`,
    ].filter(Boolean).join(` ${g.dot} `)])
    replace = await ask(`back up to ${short(paths.backup)}/${ts} and replace?`, { label: 'back up and replace?' })
  }

  // no keyring on this machine → identities carry env: refs instead of keyring names
  const keyringOk = deps.keyring?.({ exec: deps.exec }) ?? pf !== 'linux'
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
  if (!yes || !keyringOk) ui.section('Identities')
  if (!keyringOk) {
    ui.warn('no keyring available (secret-tool/D-Bus missing) — identities use env: refs instead of keychain names; export the variables below, or install gnome-keyring + secret-tool and rerun barrito init')
  }
  // the two match prompts every identity gets — the built-ins on a fresh machine and "add another" alike
  const matchFor = async (name: string): Promise<{ remotes: string[]; paths: string[] }> => {
    const remotes = await say('remotes glob (e.g. github.com/owner/*)', `${name} remotes`, { default: `github.com/${name}/*` })
    const pathsGlob = await say('paths glob (e.g. ~/Code/owner/**)', `${name} paths`, { default: `~/Code/${name}/**` })
    return { remotes: remotes ? [remotes] : [], paths: pathsGlob ? [pathsGlob] : [] }
  }
  if (!yes && fresh) {
    // the built-ins carry no globs of their own — ask, with the same prompts as any other identity
    for (const [id, def] of Object.entries(base)) base[id] = { ...def, match: await matchFor(id) }
  }
  if (!yes) {
    while (await ask('Add another identity?', { value: false, label: 'add another identity?' })) {
      const name = await say('identity name (a-z0-9, - and _)', 'name', {
        validate: (v) => !NAME_RE.test(v)
          ? 'must match /^[a-z0-9][a-z0-9_-]{0,31}$/'
          : base[v] ? `"${v}" is already configured` : undefined,
      })
      const match = await matchFor(name)
      const dir = await say('claude config dir', `${name} claude dir`, { default: `~/.claude-${name}` })
      const gateway = await say('gateway secret (keychain item name; env:VAR or file:~/path when there is no keyring)', `${name} gateway`, {
        default: keyringOk ? `Vercel AI Gateway ${name}` : envRef(name, 'gateway'),
        validate: (v) => v ? undefined : 'required — the router needs a gateway key for this identity',
      })
      const cursor = await say('cursor secret (optional — keychain item name, env:VAR, file:~/path; empty to skip)', `${name} cursor`, {
        default: keyringOk ? `Cursor ${name}` : envRef(name, 'cursor'),
      })
      base[name] = {
        claude_config_dir: dir,
        match,
        keychain: { gateway, cursor },
      }
    }
  }
  const draft = Object.entries(base).reduce<Record<string, Identity>>((memo, [id, def]) => {
    memo[id] = {
      id,
      claude_config_dir: expand(def.claude_config_dir),
      share_from: def.share_from ? expand(def.share_from) : null,
      fallback: [],
      match: { remotes: def.match.remotes, paths: def.match.paths.map(expand) },
      keychain: refFor(id, def.keychain),
      ...(def.transforms ? { transforms: def.transforms } : {}),
    }
    return memo
  }, {})

  let defaultId = current.default
  const ids = Object.keys(draft)
  if (!yes && ids.length > 1) {
    defaultId = await q.select('default identity?', {
      initialValue: ids.includes(defaultId) ? defaultId : undefined,
      options: ids.map((id) => ({ value: id, label: id })),
    })
    ui.answered('default identity?', defaultId)
  }

  const show = (ref: string): string => keychain.kind(ref) === 'keyring' ? `keychain "${ref}"` : ref
  const have = (ref: string): boolean => {
    try { return deps.keychain.get(ref) != null } catch { return false }
  }
  // probe the planned refs up front — has() reads attributes only, so a foreign item is
  // never prompted here; the one value read per adopted item happens at apply time
  const probed = probe(keyringRefs(draft), deps.keychain)
  const keychainState = { ...detected.keychain, ...probed }
  // a foreign item that exists is adopted: copied into "barrito: <slot> <id>" by the
  // keychain-own action, with the config slot rewritten to point at the copy
  const adoptTo = (slot: 'gateway' | 'cursor', ref: string, id: string): string | null =>
    pf === 'darwin' && keychain.kind(ref) === 'keyring' && !keychain.owned(ref) && probed[ref] === true
      ? keychain.ownName(slot, id)
      : null
  const secret = (slot: 'gateway' | 'cursor', ref: string, id: string): string => {
    const own = adoptTo(slot, ref, id)
    if (own) return `keychain "${own}"  ${ui.mark('ok')} ${c.dim(`copied from "${ref}"`)}`
    if (!ref) return c.dim('none')
    return `${show(ref)}  ${have(ref) ? ui.mark('ok') : ui.mark('bad')}`
  }
  const loginFor = (dir: string): ClaudeAccount =>
    // a just-added identity is not in the config yet, so check its dir directly
    detected.claudeDirs.find((d) => d.dir === dir) ?? deps.account(dir)
  const signedIn = (a: ClaudeAccount): string => `${ui.mark('ok')} ${a.email ?? 'logged in'}`

  let share = true
  let historiesAnswer = true
  for (const [id, identity] of Object.entries(draft)) {
    ui.section(`Identity ${g.dot} ${id}${id === defaultId ? ' (default)' : ''}`)
    const login = loginFor(identity.claude_config_dir)
    const gateway = identity.keychain.gateway ?? ''
    const cursor = identity.keychain.cursor ?? ''
    ui.rows([
      ['match', [...identity.match.remotes, ...identity.match.paths.map(short)].join('  ') || (id === defaultId
        ? c.dim('none — catches every unmatched directory')
        : `${ui.mark('warn')} none yet — every directory resolves to the default identity; rerun barrito init to add globs`)],
      ['claude', `${short(identity.claude_config_dir)}  ${login.loggedIn ? signedIn(login) : `${ui.mark('bad')} not logged in`}`],
      ['gateway', secret('gateway', gateway, id)],
      ['cursor', secret('cursor', cursor, id)],
    ])
    if (gateway.startsWith('env:') && !have(gateway)) ui.note(`export ${gateway.slice(4)}=<vercel ai gateway key>`)
    if (cursor.startsWith('env:') && !have(cursor)) ui.note(`export ${cursor.slice(4)}=<cursor key>`)
    // never spawn `claude` for the login: its first-run onboarding in a fresh config dir
    // takes over the terminal (theme, login, trust) and asks twice — the user runs it
    if (!login.loggedIn) {
      ui.note(`log in from another terminal:  CLAUDE_CONFIG_DIR=${short(identity.claude_config_dir)} claude  ${g.arrow}  /login`)
      ui.note('tip: open the sign-in URL in a private browser window when the browser is signed into a different account')
      if (!yes && !dry) {
        let email: string | null = null
        let ok = false
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          if (!await ask('logged in? (re-checks)', { value: false })) break
          const again = deps.account(identity.claude_config_dir)
          ok = again.loggedIn
          email = again.email
          if (!ok && attempt < 2) ui.item(ui.mark('bad'), 'still not logged in')
        }
        if (ok) ui.item(ui.mark('ok'), `logged in (${email ?? identity.id})`)
        if (!ok) ui.item(ui.mark('warn'), 'continuing — barrito doctor will flag the login')
      }
    }
    if (identity.share_from && id === 'personal') {
      share = await ask(`share rules/skills/agents from ${short(identity.share_from)}?`)
    }
  }
  // project histories sitting in another identity's dir are invisible to /resume —
  // resolved per project by remote → path → default, exactly like the router
  const historyMoves = outstanding({ default: defaultId, identities: draft, graft: current.graft }, { fs })
  if (historyMoves.length) {
    const targets = [...new Set(historyMoves.map((m) => m.to))].join(', ')
    historiesAnswer = await ask(`copy ${historyMoves.length} project histories into the identity they resolve to (${targets})?`)
  }

  const fallbacks = [
    { value: 'cheap' as const, label: 'cheap first, loudly', hint: CHAIN.map((m) => m.split('/')[1]).join(` ${g.arrow} `) },
    { value: 'claude' as const, label: 'same Claude model on gateway credits' },
    { value: 'stop' as const, label: 'stop and tell me' },
  ]
  const fallback: 'cheap' | 'claude' | 'stop' = yes
    ? 'cheap'
    : await q.select('When Max runs out', { initialValue: 'cheap', options: fallbacks })
  const chosen = fallbacks.find((o) => o.value === fallback)
  ui.section('When Max runs out', [`${c.green(g.radio)} ${chosen?.label ?? fallback}${chosen?.hint ? `   ${c.dim(chosen.hint)}` : ''}`])
  const identities = Object.fromEntries(Object.entries(draft).map(([id, i]) => [id, { ...i, fallback: FALLBACKS[fallback] }]))

  // token savers: rtk compression + caveman replies — a config that already has [transforms] wins
  const hasTransforms = (file: string): boolean => {
    try {
      return 'transforms' in (toml(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    } catch {
      return false
    }
  }
  const txStep = !hasTransforms(paths.config)
  let tx: TransformState = current.transforms ?? { rtk: true, caveman: 'lite' }
  if (txStep) {
    ui.section('Token savers')
    if (!onPath(deps.exec, 'rtk')) ui.warn('rtk not found on PATH — brew install rtk (github.com/rtk-ai/rtk), then re-run barrito init')
    if (yes) {
      ui.rows([['rtk', tx.rtk ? 'compress tool output' : 'off'], ['caveman', tx.caveman ?? 'off']])
    }
    if (!yes) {
      const rtk = await ask('Compress tool output with rtk?', { value: true })
      const caveman = await q.select('How terse should replies be? (caveman)', {
        initialValue: 'lite',
        options: [
          { value: 'off', label: 'off — full replies' },
          { value: 'lite', label: 'lite — terser replies' },
          { value: 'full', label: 'full — very terse replies' },
          { value: 'ultra', label: 'ultra — caveman' },
        ],
      })
      ui.answered('caveman replies?', caveman)
      tx = { rtk, caveman }
    }
  }

  const roots = current.graft.roots.length ? current.graft.roots : ['~/Code', '~/emdash/repositories'].map(expand)
  let repos = current.graft.repos
  const found = scan({ roots, git: runGit, fs, state: dry ? null : paths.state }).slice(0, 15)
  const rel = (repo: string): string => roots.map((r) => path.relative(r, repo)).find((r) => r && !r.startsWith('..')) ?? short(repo)
  if (found.length && !yes) {
    const prev = new Map(repos.map((r): [string, typeof r] => [r.path, r]))
    const selected = await q.multiselect('Graft which repos?  (ranked by size)', {
      options: found.map((r) => ({ value: r.path, label: `${rel(r.path)}  ${loc(r.loc)}`, hint: r.remote })),
      initialValues: repos.map((r) => r.path),
      required: false,
    })
    repos = selected.map((path_) => prev.get(path_) ?? { path: path_, summaries: false })
  }
  const picked = new Set(repos.map((r) => r.path))
  ui.section('Graft which repos?  (ranked by size)')
  if (!found.length) ui.note(`no git repos under ${roots.map(short).join(', ')}`)
  ui.list(found.map((r) => ({ label: rel(r.path), detail: loc(r.loc), on: picked.has(r.path) })))

  let bin = deps.bin
  if (viaNpx(deps.script)) {
    ui.section('Router service')
    ui.warn(`running via npx — the ${pf === 'linux' ? 'systemd' : 'launchd'} service needs a stable path`)
    const go = await ask('install barrito globally now? (npm install -g barrito)', { value: false })
    if (go) {
      deps.exec('npm', ['install', '-g', 'barrito'])
      bin = deps.exec('which', ['barrito']).trim() || bin
    }
    if (bin === deps.bin) ui.warn(`service will run ${bin} — reinstall globally and rerun \`barrito init\` for a stable path`)
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
  let catalogDown = false
  try {
    models = deps.catalog ?? await catalog(next, deps, dry)
  } catch {
    catalogDown = true
  }
  // detect read the config before the wizard's identities existed — the probe above
  // covers their keyring refs, so a custom cursor item that already holds a key never
  // re-plans the cursor-keys move
  // a config without [transforms] must reach plan() transforms-less — load() injects the
  // defaults, which would hide a first-time [transforms] write from canon's diff
  const carried: Partial<Config> = txStep ? { ...current, transforms: undefined } : current
  const actions = plan({ ...detected, keychain: keychainState }, { config: next, existing: carried, replace, share, histories: historiesAnswer, moves: historyMoves, ts, bin, fs, catalog: models })

  ui.section('Plan')
  if (catalogDown) ui.warn('gateway catalog unavailable — run `barrito models sync` once the router is up')
  const sign: Partial<Record<Action['kind'], string>> = { backup: c.dim('~'), bootout: c.red('-'), shims: c.yellow('±'), envrc: c.red('-'), note: c.yellow('!') }
  if (!actions.length) ui.row('nothing to write — everything is already in place')
  actions.forEach((a) => ui.item(sign[a.kind] ?? c.green('+'), a.description))
  if (actions.some((a) => a.kind === 'keychain-own')) {
    ui.warn('macOS asks once per key — click Allow; each foreign item is read exactly once and never modified')
  }
  if (dry) {
    ui.outro(c.dim('dry run — nothing written'))
    return
  }
  const go = await ask('write it?')
  if (!go) {
    ui.outro(c.red('aborted — nothing written'))
    return ctx.exit(1)
  }

  // apply narrates through the spine: one ◆ step per action, its notes as rows under it
  const cur: { done?: ((level?: Level) => void) | null } = {}
  const relay = (s: string): void => {
    const line = s.trim()
    if (line.startsWith('! ')) return ui.warn(line.slice(2))
    if (line.startsWith('✓ ')) return ui.item(ui.mark('ok'), line.slice(2))
    ui.row(line)
  }
  const backup = createBackup({ ts, dir: paths.backup, fs })
  try {
    await apply(actions, {
      backup,
      exec: deps.exec,
      fs,
      keychain: deps.keychain,
      service: deps.service ?? service,
      settings,
      config: next,
      catalog: models,
      print: relay,
      step: (a) => {
        cur.done?.()
        cur.done = a.kind === 'note' ? null : ui.step(a.description)
      },
      bin,
      graftExec: deps.graftExec,
      node: deps.node,
      pathEnv: deps.pathEnv,
      sleep: deps.sleep,
      agentsDir: pf === 'darwin' ? path.join(home(), 'Library', 'LaunchAgents') : undefined,
    })
  } catch (err) {
    cur.done?.('bad')
    throw err
  }
  cur.done?.()

  const shimNames = actions.find((a) => a.kind === 'shims')?.names
  const wrote = [
    'Wrote config',
    shimNames && `${shimNames.length} shims`,
    actions.some((a) => a.kind === 'service') && 'router service',
    actions.some((a) => a.kind === 'path-rc') && 'PATH line',
    actions.some((a) => a.kind === 'settings') && 'statusline',
  ].filter(Boolean).join(', ')
  ui.row(c.dim('restart emdash and Conductor once so they pick up PATH'))
  ui.outro(`${wrote}. Next: ${c.bold('barrito doctor')}`)
}

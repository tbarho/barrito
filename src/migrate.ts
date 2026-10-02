import fsx from 'node:fs'
import path from 'node:path'
import { paths, home, root, platform } from './paths.ts'
import * as harnesses from './harnesses.ts'
import { glob } from './identity.ts'
import { bare } from './catalog.ts'
import * as cfg from './config.ts'
import * as keychain from './keychain/index.ts'
import * as service from './service/index.ts'
import { unit } from './service/systemd.ts'
import * as settings from './settings.ts'
import * as models from './models.ts'
import * as graft from './graft.ts'
import shimCmd from './cli/shim.ts'
import { rcOpen, rcClose, rcLines } from './detect.ts'
import type { Detected } from './detect.ts'
import type { Backup } from './backup.ts'
import type { Builtin, CatalogModel, ClaudeSettings, Config, Exec, Identity, Keychain, ModelRules, Print } from './types.ts'

const SHARE = ['rules', 'skills', 'agents', 'CLAUDE.md']

export type Fs = typeof fsx

export type StatusLine = { type: 'command'; command: string }

export type SettingsFragment = {
  env: Record<string, string>
  statusLine: StatusLine
}

export type Action =
  | { kind: 'backup'; description: string; files: string[]; launchd: string[] }
  | { kind: 'bootout'; description: string }
  | { kind: 'shims'; description: string; names: string[]; remove: string[] }
  | { kind: 'envrc'; description: string; links: string[] }
  | { kind: 'path-rc'; description: string; file: string; lines: string[] }
  | { kind: 'keychain-own'; description: string; copies: { id: string; slot: string; from: string; to: string }[] }
  | { kind: 'cursor-keys'; description: string; moves: { file: string; service: string }[] }
  | { kind: 'dir'; description: string; dir: string }
  | { kind: 'share'; description: string; items: { from: string; to: string }[] }
  | { kind: 'histories'; description: string; dirs: { from: string; to: string }[] }
  | { kind: 'settings'; description: string; dirs: { dir: string; fragment: SettingsFragment; same: boolean }[]; command: { from: string; to: string[] } | null }
  | { kind: 'opencode'; description: string; file: string; fragment: Record<string, unknown> }
  | { kind: 'config'; description: string; config: Config }
  | { kind: 'note'; description: string }
  | { kind: 'models'; description: string; config: Config }
  | { kind: 'graft'; description: string; repos: string[] }
  | { kind: 'service'; description: string; bin: string; port: number }

export interface Answers {
  config: Config
  existing?: Config | Partial<Config> | null
  replace?: boolean
  share?: boolean
  histories?: boolean
  ts: string
  bin: string
  fs?: Fs
  catalog?: CatalogModel[] | null
}

export interface ServiceIo {
  removeLegacy: (opts: { exec?: Exec; dir?: string }) => void
  install: (opts: {
    bin?: string
    port?: number
    exec?: Exec
    dir?: string
    node?: string
    pathEnv?: string
    sleep?: (ms: number) => Promise<void>
  }) => Promise<unknown>
}

export interface SettingsIo {
  read: (dir: string) => ClaudeSettings
  merge: (dir: string, fragment: ClaudeSettings) => ClaudeSettings
}

// cursor-keys writes to the Keychain, so apply's keychain must have set() —
// the read-only Keychain shape would let a get-only default hide the crash
export interface WriteKeychain extends Keychain {
  set: (service: string, value: string, opts?: { account?: string }) => void
}

export interface ApplyOpts {
  fs?: Fs
  exec?: Exec
  keychain?: WriteKeychain
  service?: ServiceIo
  settings?: SettingsIo
  print?: Print
  graftExec?: GraftRun
  backup?: Backup
  config?: Config | null
  catalog?: CatalogModel[] | null
  bin?: string
  node?: string
  pathEnv?: string
  sleep?: (ms: number) => Promise<void>
  agentsDir?: string
  configFile?: string
}

export type GraftRun = typeof graft.run

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable)}]`
  if (v && typeof v === 'object') {
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).sort().join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

const deep = (base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> =>
  Object.entries(over).reduce((memo, [k, v]) => {
    const cur = memo[k]
    const mergeable = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object'
    memo[k] = mergeable ? deep(cur as Record<string, unknown>, v as Record<string, unknown>) : v
    return memo
  }, { ...base })

const read = (fs: Fs, dir: string): ClaudeSettings => {
  try { return settings.read(dir) } catch { return {} }
}

const jsonFile = (fs: Fs, file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export const short = (p: string | null | undefined): string => {
  const h = home()
  return typeof p === 'string' && p.startsWith(h) ? `~${p.slice(h.length)}` : p ?? ''
}

const quote = (s: string): string => `'${String(s).replaceAll("'", "'\\''")}'`

// `barrito statusline --append '<existing>'` wraps a hand-set statusline so init never clobbers one
export const unwrapStatusline = (cmd: string | null | undefined): string | null => {
  const hit = /^barrito statusline --append (.+)$/.exec(cmd ?? '')
  if (!hit) return null
  return (hit[1] ?? '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
}

export const wrapStatusline = (
  existing: string | null | undefined,
  { base = 'barrito statusline' }: { base?: string } = {},
): StatusLine => {
  if (!existing || existing === base) return { type: 'command', command: base }
  if (unwrapStatusline(existing)) return { type: 'command', command: existing }
  return { type: 'command', command: `${base} --append ${quote(existing)}` }
}

export type SeedRow = { model?: string; id?: string }

export type Seeded = { changed: boolean; rules: ModelRules; retired: string[] }

// seed [models] from the picker rows that exist today: include = their providers,
// pin = every row id still in the gateway catalog (e.g. $10/1M Astra under the $5
// cap), so nothing disappears; rows the gateway retired are dropped and reported.
// Only runs on untouched rules — never re-seeds from a picker barrito itself wrote.
export const seed = (rules: ModelRules, rows: SeedRow[], catalog: CatalogModel[] | null = null): Seeded => {
  if (!rows.length || rules.include.length || (rules.pin ?? []).length) return { changed: false, rules, retired: [] }
  const ids = rows.map((row) => bare(row.model ?? row.id ?? '')).filter(Boolean)
  const known = catalog ? new Set(catalog.map((m) => m.id)) : null
  const kept = known ? ids.filter((id) => known.has(bare(id))) : ids
  const retired = known ? [...new Set(ids.filter((id) => !known.has(bare(id))))] : []
  const providers = [...new Set(kept.map((id) => id.split('/')[0]))].sort()

  // reproduce today's ids exactly: rows carrying [1m] force it back on (catalog auto-append
  // now skips models with a long-context surcharge); rows without it that would auto-get
  // it are pinned to ""
  const suffix = catalog ? rows.reduce<Record<string, '[1m]' | ''>>((memo, row) => {
    const raw = row.model ?? row.id ?? ''
    const id = bare(raw)
    const entry = catalog.find((m) => m.id === id)
    if (!entry) return memo
    if (/\[1m\]$/.test(raw)) memo[id] = '[1m]'
    else if ((entry.context_window ?? 0) >= 1000000 && !entry.pricing?.input_tiers) memo[id] = ''
    return memo
  }, {}) : {}

  return {
    changed: true,
    retired,
    rules: {
      ...rules,
      include: providers.map((p) => `${p}/*`),
      pin: [...new Set(kept)],
      max_input_price: rules.max_input_price ?? 5,
      suffix,
    },
  }
}

const decode = (name: string): string => name.replace(/^-/, '/').replaceAll('-', '/')
const enc = (p: string): string => String(p).replace(/[^A-Za-z0-9]/g, '-')

// a project dir matches a `…/**` path glob when its encoded name sits under the encoded
// root — decoding is ambiguous (real paths contain '-' and '_'), encoding isn't
const under = (paths: string[] | undefined, name: string): boolean => (paths ?? []).some((p) => {
  if (!p.endsWith('/**')) return glob(p, decode(name))
  const root = enc(p.slice(0, -3))
  return name === root || name.startsWith(`${root}-`)
})

// personal project histories: ~/.claude/projects/<encoded path> matching the identity's
// match.paths, copied into the new dir's projects/
export const histories = (identity: Identity, fs: Fs): { from: string; to: string }[] => {
  if (!identity.share_from) return []
  const src = path.join(identity.share_from, 'projects')
  if (!fs.existsSync(src)) return []
  return fs.readdirSync(src).reduce<{ from: string; to: string }[]>((memo, name) => {
    if (!under(identity.match.paths, name)) return memo
    const to = path.join(identity.claude_config_dir, 'projects', name)
    if (fs.existsSync(to)) return memo
    memo.push({ from: path.join(src, name), to })
    return memo
  }, [])
}

const identityFor = (config: Config, dir: string): Identity | null =>
  Object.values(config.identities ?? {}).find((identity) =>
    (identity.match.paths ?? []).some((p) => glob(p, dir))) ?? null

const byName: Record<string, Builtin> = harnesses.builtins

const shimTargets = (detected: Detected): string[] => {
  const names = detected.agents.map((a) => a.name)
  const legacy = (detected.legacy.shims ?? []).map((f) => path.basename(f))
  const known = [...names, ...legacy.filter((b) => byName[b]?.bin === b || Object.values(byName).some((h) => h.aliases?.includes(b)))]
  return [...new Set(known.filter((n) => byName[n]))]
}

// PURE: turns what detect() found + the wizard's answers into an ordered action list.
// Every action is skipped when it would change nothing, so a second run plans zero writes.
export const plan = (detected: Detected, answers: Answers): Action[] => {
  const fs = answers.fs ?? fsx
  const next = { ...answers.config }
  const { changed: seeded, rules, retired } = seed(next.models, detected.legacy.modelPicker, answers.catalog)
  next.models = rules
  const actions: Action[] = []
  const pf = platform()
  const legacy = detected.legacy
  const replace = answers.replace && (legacy.launchd || legacy.shims.length > 0 || legacy.envrcLinks.length > 0)
  const plist = path.join(home(), 'Library', 'LaunchAgents', `${service.legacy}.plist`)
  const command = path.join(root(), 'templates', 'barrito-command.md')

  const files = [...legacy.shims, ...legacy.envrcLinks.map((l) => l.path)]
  if (legacy.launchd) files.unshift(plist)
  if (replace && files.length) {
    actions.push({
      kind: 'backup',
      description: `back up ${files.length} existing file(s) → ${short(paths.backup)}/${answers.ts}`,
      files,
      launchd: legacy.launchd ? [service.legacy] : [],
    })
  }
  if (replace && legacy.launchd) {
    actions.push({ kind: 'bootout', description: `boot out and remove the legacy claude-router (launchd; dev.barrito.router takes :${next.port})` })
  }
  if (replace && legacy.shims.length) {
    const names = shimTargets(detected)
    const targets = new Set(names.flatMap((n) => {
      const h = byName[n]
      return h ? [h.bin, ...(h.aliases ?? [])] : []
    }))
    const remove = legacy.shims.filter((f) => !targets.has(path.basename(f)))
    actions.push({
      kind: 'shims',
      description: `replace legacy shims with generated ones (${names.join(', ') || 'none'}); remove ${remove.map((f) => path.basename(f)).join(', ') || 'nothing'}`,
      names,
      remove,
    })
  }
  if (replace && legacy.envrcLinks.length) {
    actions.push({
      kind: 'envrc',
      description: `remove ${legacy.envrcLinks.length} .envrc symlink(s) under ${short(path.join(home(), 'emdash', 'worktrees'))} (barrito covers Cursor and the gateway)`,
      links: legacy.envrcLinks.map((l) => l.path),
    })
  }

  // every platform: the shims dir must be prepended in the shell rc — a fresh machine has no such line
  const rc = detected.rc
  if (rc && !rc.present) {
    actions.push({
      kind: 'path-rc',
      description: `add ~/.local/shims to PATH in ${short(rc.file)}`,
      file: rc.file,
      lines: rc.lines,
    })
  }

  // barrito owns its own Keychain items: a foreign item the planned config still points
  // at (made by another tool, e.g. the Vercel CLI) is copied once into "barrito: <slot>
  // <identity>" and the slot rewritten — macOS then prompts once per key, never again.
  // The original is never modified or deleted; the tool that made it keeps using it.
  const copies: { id: string; slot: string; from: string; to: string }[] = []
  if (pf === 'darwin') {
    for (const [id, identity] of Object.entries(next.identities)) {
      for (const [slot, ref] of Object.entries(identity.keychain ?? {})) {
        if (typeof ref !== 'string' || !ref) continue
        if (keychain.kind(ref) !== 'keyring' || keychain.owned(ref)) continue
        if (detected.keychain[ref] !== true) continue // not in the Keychain yet — keep pointing at the name it will appear under
        const to = keychain.ownName(slot, id)
        copies.push({ id, slot, from: ref, to })
        identity.keychain[slot] = to
      }
    }
  }
  if (copies.length) {
    actions.push({
      kind: 'keychain-own',
      description: `copy ${copies.length} keychain key${copies.length === 1 ? '' : 's'} into barrito-owned items (one macOS prompt each)`,
      copies,
    })
  }

  const moves = legacy.envrcKeys.reduce<{ file: string; service: string }[]>((memo, { file, var: name }) => {
    if (name !== 'CURSOR_API_KEY') return memo
    const identity = identityFor(next, path.dirname(file))
    let target = identity?.keychain?.cursor ?? ''
    // env:/file: refs can't receive a key — only keyring names can
    if (!target || keychain.kind(target) !== 'keyring') return memo
    // an item init creates itself is barrito-owned from birth; an existing foreign one
    // was just adopted above, and the copied key wins over the .envrc line
    if (pf === 'darwin' && !keychain.owned(target)) {
      target = keychain.ownName('cursor', identity!.id)
      identity!.keychain.cursor = target
    }
    if (copies.some((c) => c.to === target) || detected.keychain[target]) return memo
    if (memo.some((m) => m.file === file)) return memo
    memo.push({ file, service: target })
    return memo
  }, [])
  if (moves.length) {
    actions.push({
      kind: 'cursor-keys',
      description: `move CURSOR_API_KEY into Keychain (${moves.map((m) => `"${m.service}"`).join(', ')}) — the .envrc lines are printed for you to delete, never edited silently`,
      moves,
    })
  }

  const fresh = Object.values(next.identities).filter((i) => !fs.existsSync(i.claude_config_dir))
  fresh.forEach((identity) => actions.push({
    kind: 'dir',
    description: `create ${short(identity.claude_config_dir)}`,
    dir: identity.claude_config_dir,
  }))

  const shared = Object.values(next.identities).reduce<{ from: string; to: string }[]>((memo, identity) => {
    const shareFrom = identity.share_from
    if (!shareFrom || answers.share === false) return memo
    SHARE.filter((item) =>
      fs.existsSync(path.join(shareFrom, item)) && !fs.existsSync(path.join(identity.claude_config_dir, item))
    ).forEach((item) => memo.push({ from: path.join(shareFrom, item), to: path.join(identity.claude_config_dir, item) }))
    return memo
  }, [])
  if (shared.length) {
    actions.push({
      kind: 'share',
      description: `symlink ${[...new Set(shared.map((s) => path.basename(s.from)))].join(', ')} from ${short(path.dirname(shared[0]!.from))} into ${short(path.dirname(shared[0]!.to))}`,
      items: shared,
    })
  }

  const historyDirs = answers.histories === false ? [] : Object.values(next.identities).flatMap((i) => histories(i, fs))
  if (historyDirs.length) {
    actions.push({
      kind: 'histories',
      description: `copy ${historyDirs.length} personal project histor${historyDirs.length === 1 ? 'y' : 'ies'} into ${short(path.dirname(historyDirs[0]!.to))}`,
      dirs: historyDirs,
    })
  }

  const fragments = Object.values(next.identities).map((identity) => {
    const dir = identity.claude_config_dir
    const current = read(fs, dir)
    const fragment = {
      env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${next.port}` },
      statusLine: wrapStatusline(current.statusLine?.command),
    }
    return { dir, fragment, same: stable(deep(current, fragment)) === stable(current) }
  })
  const commandSrc = fs.existsSync(command) ? command : null
  const commandTargets = commandSrc ? fragments.map((f) => path.join(f.dir, 'commands', 'barrito.md')) : []
  const commandStale = commandSrc
    ? commandTargets.some((to) => {
      try { return fs.readFileSync(commandSrc, 'utf8') !== fs.readFileSync(to, 'utf8') } catch { return true }
    })
    : false
  if (fragments.some((f) => !f.same) || commandStale) {
    actions.push({
      kind: 'settings',
      description: `merge router settings into ${fragments.map((f) => short(f.dir)).join(', ')} (base URL, statusLine${commandSrc ? ', /barrito command' : ''})`,
      dirs: fragments,
      command: commandSrc ? { from: commandSrc, to: commandTargets } : null,
    })
  }

  // opencode.json provider block pointing the vercel provider at barrito — owned by
  // harnesses.configFragments.opencode; a no-op until that export lands
  const opencodeFragment = harnesses.configFragments?.opencode?.({ port: next.port }) ?? null
  if (opencodeFragment) {
    const file = path.join(home(), '.config', 'opencode', 'opencode.json')
    const raw = jsonFile(fs, file)
    const current = isObj(raw) ? raw : {}
    if (raw === null || stable(deep(current, opencodeFragment)) !== stable(raw)) {
      actions.push({
        kind: 'opencode',
        description: `point opencode's vercel provider at barrito (back up + merge ${short(file)})`,
        file,
        fragment: opencodeFragment,
      })
    }
  }

  const carried = (answers.existing ?? {}) as Partial<Config>
  // canon covers [transforms] too (per-identity transforms ride through `identities`), so a
  // transforms-only diff still plans a config write — callers hand `existing` in as the file
  // holds it, since load() injects the defaults a missing [transforms] table would hide
  const canon = (c: Partial<Config>): string => stable({
    port: c.port,
    default: c.default,
    identities: c.identities ?? {},
    models: c.models,
    graft: c.graft ?? { roots: [], repos: [] },
    harness: c.harness ?? {},
    transforms: c.transforms ?? null,
  })
  if (canon(next) !== canon(carried)) {
    actions.push({ kind: 'config', description: `write ${short(paths.config)}`, config: next })
  }

  const pickerMissing = Object.values(next.identities)
    .some((i) => fs.existsSync(i.claude_config_dir) && !(read(fs, i.claude_config_dir).modelPicker?.options ?? []).length)
  if (seeded || pickerMissing) {
    retired.forEach((id) => actions.push({ kind: 'note', description: `retired: ${id} (dropped)` }))
    actions.push({
      kind: 'models',
      description: `seed [models] from the existing picker rows and sync pickers into ${Object.values(next.identities).map((i) => short(i.claude_config_dir)).join(', ')}`,
      config: next,
    })
  }

  const known = new Set((carried.graft?.repos ?? []).map((r) => r.path))
  const graftRepos = (next.graft.repos ?? []).filter((r) => !known.has(r.path))
  if (graftRepos.length) {
    actions.push({
      kind: 'graft',
      description: `graft wire + build ${graftRepos.map((r) => short(r.path)).join(', ')} (writes tracked files: .claude/, .mcp.json, AGENTS.md)`,
      repos: graftRepos.map((r) => r.path),
    })
  }

  if (!detected.router?.installed) {
    actions.push({
      kind: 'service',
      description: `install ${pf === 'linux' ? unit : service.label} (${pf === 'linux' ? 'systemd' : 'launchd'}, :${next.port})`,
      bin: answers.bin,
      port: next.port,
    })
  }

  return actions
}

const readKey = (fs: Fs, file: string, name: string): string | null => {
  const hit = new RegExp(`^\\s*export\\s+${name}=(.+)$`, 'm').exec(fs.readFileSync(file, 'utf8'))
  if (!hit) return null
  return (hit[1] ?? '').trim().replace(/^['"](.*)['"]$/, '$1')
}

const isMissing = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { missing?: unknown }).missing === true

const why = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0] ?? 'error'
}

// uninstall: remove exactly our marked block — a hand-written PATH line is never touched.
// No init backup manifest covering the rc → a plain copy lands beside it first; a malformed
// block (no close marker) loses only the marker line + the exact barrito PATH line after it.
const lineEndAt = (text: string, from: number): number => {
  const n = text.indexOf('\n', from)
  return n === -1 ? text.length : n
}

const stamp = (): string => new Date().toISOString().slice(0, 16).replaceAll(':', '')

const manifestCovers = (fs: Fs, file: string): boolean => {
  try {
    if (!fs.existsSync(paths.backup)) return false
    return fs.readdirSync(paths.backup).some((ts) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(paths.backup, ts, 'manifest.json'), 'utf8')) as { files?: { original?: unknown }[] }
        return (m.files ?? []).some((e) => e.original === file)
      } catch { return false }
    })
  } catch { return false }
}

const malformedEnd = (text: string, lineStart: number): number => {
  const openEnd = lineEndAt(text, lineStart)
  const next = text.slice(openEnd + 1, lineEndAt(text, openEnd + 1)).trim()
  return next === rcLines('zsh')[0] || next === rcLines('fish')[0] ? lineEndAt(text, openEnd + 1) : openEnd
}

export const stripRcBlock = (file: string, fs: Fs = fsx, print: (line: string) => void = () => {}): boolean => {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return false }
  const open = text.indexOf(rcOpen)
  if (open === -1) return false
  if (!manifestCovers(fs, file)) {
    try { fs.copyFileSync(file, `${file}.barrito-bak-${stamp()}`) } catch {}
  }
  const lineStart = text.lastIndexOf('\n', open) + 1
  const close = text.indexOf(rcClose, open)
  const end = close === -1 ? malformedEnd(text, lineStart) : close + rcClose.length
  if (close === -1) print(`  ! ${short(file)}: PATH block is missing its end marker — removing only barrito's lines; check the file`)
  const head = text.slice(0, lineStart).replace(/\n+$/, '')
  const tail = text.slice(end).replace(/^\n+/, '').replace(/\n+$/, '')
  const joined = head && tail ? `${head}\n${tail}` : `${head}${tail}`
  fs.writeFileSync(file, joined.length ? `${joined}\n` : '')
  return true
}

// plan() in order; every handler is a no-op when the world already matches
export const apply = async (actions: Action[], opts: ApplyOpts = {}): Promise<Config | null> => {
  const fs = opts.fs ?? fsx
  const exec = opts.exec
  const kc = opts.keychain ?? keychain
  const svc = opts.service ?? service
  const st = opts.settings ?? settings
  const print = opts.print ?? (() => {})
  const shimExec = opts.graftExec ?? graft.run
  const backup = opts.backup
  let backed = false
  const record = (kind: 'launchd' | 'removed', data: string): void => {
    if (!backup) return
    backup.record(kind, data)
    backed = true
  }
  let config = opts.config ?? null

  // bin/node: shims embed absolute paths at generation time, so they must be the
  // stable global ones, not whatever npx run is doing the generating
  const genShims = async (names: string[]): Promise<void> => {
    if (!names.length) return
    await shimCmd(['--force', ...names], { config: config ?? { harness: {} }, print: () => {}, exit: () => {}, bin: opts.bin, node: opts.node })
  }

  const keep = (file: string): boolean => {
    if (!fs.existsSync(file)) return false
    backup?.save(file)
    return true
  }

  // a missing graft binary skips the build for that repo but never kills the migration
  const wireAndBuild = (repo: string): void => {
    try {
      graft.wire(repo, { exec: shimExec, fs })
    } catch (err) {
      if (!isMissing(err)) throw err
      print(`  ! graft not installed — npm install -g @nanonets/graft, then barrito graft build ${short(repo)}`)
      return
    }
    graft.build(repo, { exec: shimExec, detached: true })
  }

  for (const action of actions) {
    if (action.kind === 'backup') {
      action.files.forEach((file) => {
        backup?.save(file)
        backed = true
      })
      action.launchd.forEach((label) => record('launchd', label))
    }
    if (action.kind === 'bootout') {
      svc.removeLegacy({ exec })
      record('removed', path.join(home(), 'Library', 'LaunchAgents', `${service.legacy}.plist`))
    }
    if (action.kind === 'shims') {
      await genShims(action.names)
      action.remove.forEach((file) => {
        fs.rmSync(file, { force: true })
        record('removed', file)
      })
    }
    if (action.kind === 'envrc') {
      action.links.forEach((link) => {
        fs.rmSync(link, { force: true })
        record('removed', link)
      })
    }
    if (action.kind === 'path-rc') {
      let text = ''
      try { text = fs.readFileSync(action.file, 'utf8') } catch {}
      // a second apply is a no-op: the marker (or an equivalent hand line) means the job is done
      if (text.includes(rcOpen)) continue
      if (text) backed = keep(action.file)
      fs.mkdirSync(path.dirname(action.file), { recursive: true })
      const block = [rcOpen, ...action.lines, rcClose].join('\n')
      fs.writeFileSync(action.file, text ? `${text}${text.endsWith('\n') ? '' : '\n'}${block}\n` : `${block}\n`)
    }
    if (action.kind === 'keychain-own') {
      // the slot rewrite above points the config at the owned item — a failed copy must
      // point it back at the original before the config action saves it
      const revert = (copy: { id: string; slot: string; from: string }): void => {
        const identity = opts.config?.identities?.[copy.id]
        if (identity) identity.keychain[copy.slot] = copy.from
      }
      action.copies.forEach((copy) => {
        let value: string | null = null
        try {
          value = kc.get(copy.from) // the one prompt: read each foreign item exactly once
        } catch (err) {
          revert(copy)
          print(`  ! "${copy.from}" unreadable (${why(err)}) — config keeps pointing at it`)
          return
        }
        if (value == null) {
          revert(copy)
          print(`  ! "${copy.from}" holds no value — config keeps pointing at it`)
          return
        }
        try {
          kc.set(copy.to, value) // account "barrito", -T /usr/bin/security, value on stdin
        } catch (err) {
          revert(copy)
          print(`  ! "${copy.to}" write failed (${why(err)}) — config keeps pointing at "${copy.from}"`)
          return
        }
        const identity = opts.config?.identities?.[copy.id]
        if (identity) identity.keychain[copy.slot] = copy.to
        print(`  ✓ "${copy.from}" → "${copy.to}" — the original is never touched`)
      })
    }
    if (action.kind === 'cursor-keys') {
      action.moves.forEach(({ file, service: name }) => {
        const value = readKey(fs, file, 'CURSOR_API_KEY')
        if (value == null) return
        kc.set(name, value)
        print(`  ${short(file)}: delete the export CURSOR_API_KEY line — the key now lives in Keychain "${name}"`)
      })
    }
    if (action.kind === 'opencode') {
      keep(action.file)
      const raw = jsonFile(fs, action.file)
      fs.mkdirSync(path.dirname(action.file), { recursive: true })
      fs.writeFileSync(action.file, JSON.stringify(deep(isObj(raw) ? raw : {}, action.fragment), null, 2) + '\n')
    }
    if (action.kind === 'dir') fs.mkdirSync(action.dir, { recursive: true })
    if (action.kind === 'share') {
      action.items.forEach(({ from, to }) => {
        fs.rmSync(to, { force: true })
        fs.symlinkSync(from, to)
      })
    }
    if (action.kind === 'histories') {
      action.dirs.forEach(({ from, to }) => fs.cpSync(from, to, { recursive: true }))
    }
    if (action.kind === 'settings') {
      action.dirs.forEach(({ dir, fragment }) => st.merge(dir, fragment))
      const src = action.command
      if (src) src.to.forEach((to) => {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.copyFileSync(src.from, to)
      })
    }
    if (action.kind === 'config') {
      config = action.config
      // config.toml rides the backup manifest, so uninstall --restore points the slots
      // back at the items they referenced before barrito adopted them
      const file = opts.configFile ?? paths.config
      backed = keep(file) || backed
      cfg.save(config, opts.configFile)
    }
    if (action.kind === 'models') {
      config = config ?? action.config
      if (!opts.catalog) {
        print('  ! gateway catalog unavailable — run `barrito models sync` once the router is up')
        continue
      }
      const result = await models.sync({ config, catalog: opts.catalog, settings: st, fs })
      const dirs = result.dirs.map((d) => d.ok ? short(d.dir) : `✗ ${short(d.dir)}: ${d.error ?? ''}`.trim()).join(', ')
      print(`  picker + agents → ${dirs}`)
    }
    if (action.kind === 'graft') action.repos.forEach((repo) => wireAndBuild(repo))
    if (action.kind === 'service') {
      await svc.install({
        bin: action.bin,
        port: action.port,
        exec,
        dir: opts.agentsDir,
        node: opts.node,
        pathEnv: opts.pathEnv,
        sleep: opts.sleep,
      })
    }
  }

  if (backup && backed) backup.write()
  return config
}

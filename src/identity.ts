import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { paths, expand } from './paths.ts'
import type { Git, IdentityCache, IdentityCacheEntry, Resolution } from './types.ts'

type IdentityConfig = {
  default?: string
  identities?: Record<string, { match?: { remotes?: string[]; paths?: string[] } }>
}

type ResolveOptions = {
  config?: IdentityConfig
  env?: NodeJS.ProcessEnv
  git?: Git
  cache?: IdentityCache | false
}

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRule = (value: unknown): value is Resolution['rule'] =>
  value === 'env' || value === 'remote' || value === 'path' || value === 'default'

const isCacheEntry = (value: unknown): value is IdentityCacheEntry => {
  if (!isObj(value) || !isObj(value.result)) return false
  const { result } = value
  return typeof value.fp === 'string' &&
    (value.top === null || typeof value.top === 'string') &&
    (value.commonDir === null || typeof value.commonDir === 'string') &&
    (value.configFile === null || typeof value.configFile === 'string') &&
    (value.mtimeMs === null || typeof value.mtimeMs === 'number') &&
    (value.url === null || typeof value.url === 'string') &&
    typeof result.id === 'string' && isRule(result.rule) &&
    (result.detail === null || typeof result.detail === 'string')
}

export const normalizeRemote = (url: string): string => {
  let u = String(url).trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  if (u.includes('@')) u = u.replace(/[^@/]+@/, '')
  u = u.replace(/\/+$/, '')
  u = u.replace(/:\d+(?=\/)/, '')
  u = u.replace(/\.git$/, '')
  u = u.replace(/:/, '/')
  u = u.replace(/^(github\.com|gitlab\.com|bitbucket\.org)-[^/]+/i, '$1') // ssh host aliases
  return u.replace(/\/+/g, '/').toLowerCase()
}

const seg = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')

const frag = (parts: string[]): string => {
  if (!parts.length) return ''
  const head = parts[0]!
  const rest = parts.slice(1)
  if (head === '**') return rest.length ? `(?:[^/]+/)*${frag(rest)}` : '.*'
  if (rest.length === 1 && rest[0] === '**') return `${seg(head)}(?:/.*)?`
  if (!rest.length) return seg(head)
  return `${seg(head)}/${frag(rest)}`
}

// `*` matches within one segment, `**` any depth (including zero); trailing `/**` also matches the dir itself.
export const glob = (pattern: string, s: string): boolean => new RegExp(`^${frag(String(pattern).split('/'))}$`).test(s)

// graft's form: git(args, { cwd }) → string | null
export const git = (args: string[], { cwd }: { cwd?: string } = {}): string | null => {
  const r = spawnSync('git', cwd ? ['-C', cwd, ...args] : args, { encoding: 'utf8' })
  if (r.status !== 0) return null
  return r.stdout.trim() || null
}

const noCache: IdentityCache = { get: () => null, set: () => {} }

// which.json: one entry per repo, keyed by git toplevel, plus a small dir → toplevel
// map so subdirectories of a cached repo are warm with zero git spawns
type Which = { repos: Record<string, IdentityCacheEntry>; dirs: Record<string, string> }

const real = (p: string): string => {
  try { return fs.realpathSync(p) } catch { return p }
}

// nearest enclosing repo root — pure fs, never a git spawn
const rootOf = (dir: string, dirs: Record<string, string>): string | null => {
  let cur = dir
  while (true) {
    if (fs.existsSync(join(cur, '.git'))) return real(cur)
    const known = dirs[cur]
    if (known) return known
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

const cap = (o: Record<string, unknown>, n: number): void => {
  const keys = Object.keys(o)
  keys.slice(0, Math.max(0, keys.length - n)).forEach((k) => delete o[k])
}

const entries = (v: Record<string, unknown>): Record<string, IdentityCacheEntry> =>
  Object.entries(v).reduce((memo, [key, value]) => {
    if (isCacheEntry(value)) memo[key] = value
    return memo
  }, {} as Record<string, IdentityCacheEntry>)

const asWhich = (parsed: unknown): Which => {
  if (!isObj(parsed)) return { repos: {}, dirs: {} }
  const dirs = isObj(parsed.dirs)
    ? Object.entries(parsed.dirs).reduce((memo, [dir, key]) => {
      if (typeof key === 'string') memo[dir] = key
      return memo
    }, {} as Record<string, string>)
    : {}
  if (isObj(parsed.repos)) return { repos: entries(parsed.repos), dirs }
  // pre-toplevel format: a flat dir → entry map
  return Object.entries(parsed).reduce<Which>((which, [dir, value]) => {
    if (!isCacheEntry(value)) return which
    const key = value.top ?? dir
    which.repos[key] = value
    if (value.top) which.dirs[dir] = key
    return which
  }, { repos: {}, dirs })
}

const fileCache: IdentityCache & { readonly file: string; read: () => Which } = {
  get file() { return `${paths.state}/which.json` },
  read(): Which {
    try {
      return asWhich(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch { return { repos: {}, dirs: {} } }
  },
  get(dir: string): IdentityCacheEntry | null {
    const { repos, dirs } = this.read()
    const key = dirs[dir] ?? rootOf(dir, dirs) ?? dir
    return repos[key] ?? null
  },
  set(dir: string, value: IdentityCacheEntry): void {
    const which = this.read()
    const key = value.top ? real(value.top) : dir
    which.repos[key] = value
    if (value.top) which.dirs[dir] = key
    cap(which.repos, 100)
    Object.keys(which.dirs).forEach((d) => {
      if (!which.repos[which.dirs[d]!]) delete which.dirs[d]
    })
    cap(which.dirs, 100)
    fs.mkdirSync(paths.state, { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(which))
  },
}

// fingerprint of everything resolution depends on in config; change → cache miss
const fp = (config: IdentityConfig, githubRepository?: string) => createHash('sha256')
  .update(JSON.stringify([config.default, githubRepository ?? null, Object.entries(config.identities ?? {}).map(([id, i]) => [id, i.match])]))
  .digest('hex').slice(0, 12)

const mtime = (f: string | null): number | null => {
  if (!f) return null
  try { return fs.statSync(f).mtimeMs } catch { return null }
}

const fresh = (entry: IdentityCacheEntry | null, config: IdentityConfig, dir: string, githubRepository?: string): entry is IdentityCacheEntry => {
  if (!entry || entry.fp !== fp(config, githubRepository)) return false
  if (!entry.configFile) return !fs.existsSync(join(dir, '.git'))
  return entry.mtimeMs !== null && mtime(entry.configFile) === entry.mtimeMs
}

// macOS tmp (/var) vs realpath (/private/var) — match the fixed prefix as it exists on disk
const realpathPattern = (p: string): string => {
  const i = p.indexOf('*')
  if (i === -1) return p
  const prefix = p.slice(0, i)
  const rest = p.slice(i)
  const dir = prefix.replace(/\/+$/, '')
  const slashes = prefix.length - dir.length
  try { return fs.realpathSync(dir) + '/'.repeat(slashes) + rest } catch { return p }
}

const matchRemotes = (config: IdentityConfig, remote: string): Resolution | null =>
  Object.entries(config.identities ?? {}).reduce<Resolution | null>((hit, [id, identity]) => {
    if (hit) return hit
    if ((identity.match?.remotes ?? []).some((p) => glob(p.toLowerCase(), remote))) return { id, rule: 'remote', detail: remote }
    return hit
  }, null)

const matchPaths = (config: IdentityConfig, dir: string): Resolution | null =>
  Object.entries(config.identities ?? {}).reduce<Resolution | null>((hit, [id, identity]) => {
    if (hit) return hit
    const found = (identity.match?.paths ?? []).find((p) => glob(realpathPattern(expand(p)), dir))
    return found ? { id, rule: 'path', detail: found } : hit
  }, null)

const realpathDir = (cwd: string): string => {
  try { return fs.realpathSync(cwd) } catch { return cwd }
}

export const resolve = (
  cwd: string | undefined,
  { config = { default: '' }, env = process.env, git: gitFn = git, cache = fileCache }: ResolveOptions = {},
): Resolution => {
  if (env.BARRITO_IDENTITY) return { id: env.BARRITO_IDENTITY, rule: 'env', detail: 'BARRITO_IDENTITY' }

  const dir = realpathDir(cwd ?? process.cwd())
  const store = cache === false ? noCache : cache
  const entry = store.get(dir)
  if (fresh(entry, config, dir, env.GITHUB_REPOSITORY)) return entry.result

  const top = gitFn(['rev-parse', '--show-toplevel'], { cwd: dir })
  const url = top ? gitFn(['remote', 'get-url', 'origin'], { cwd: dir }) : null
  const common = top ? gitFn(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir }) : null
  const configFile = common ? join(common, 'config') : null
  const githubRemote = !url && env.GITHUB_REPOSITORY
    ? `github.com/${env.GITHUB_REPOSITORY.trim().toLowerCase()}`
    : null
  const remote = url ? normalizeRemote(url) : githubRemote

  const found: Resolution =
    (remote && matchRemotes(config, remote)) ||
    matchPaths(config, dir) ||
    { id: config.default ?? '', rule: 'default', detail: config.default ?? '' }

  if (found.rule === 'remote' && githubRemote === remote) found.detail = `${remote} (GITHUB_REPOSITORY)`

  store.set(dir, { top, commonDir: common, configFile, mtimeMs: mtime(configFile), url, result: found, fp: fp(config, env.GITHUB_REPOSITORY) })
  return found
}

// warm-cache entry without touching git (so `env` can spare graft a spawn); null when cold
export const peek = (
  cwd: string | undefined,
  { config = { default: '' }, env = process.env, cache = fileCache }: ResolveOptions = {},
): IdentityCacheEntry | null => {
  if (env.BARRITO_IDENTITY) return null
  const dir = realpathDir(cwd ?? process.cwd())
  const entry = (cache === false ? noCache : cache).get(dir)
  return fresh(entry, config, dir, env.GITHUB_REPOSITORY) ? entry : null
}

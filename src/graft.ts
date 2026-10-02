import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsx from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { paths } from './paths.ts'
import { resolve as resolveIdentity } from './identity.ts'
import type {
  Child,
  Clock,
  Git,
  GraftConfigSlice,
  GraftExec,
  MissingError,
  Resolution,
  RunOpts,
  RunResult,
  ScanEntry,
} from './types.ts'

type FS = typeof fsx

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tgz', 'tar',
  'jar', 'class', 'so', 'dylib', 'dll', 'exe', 'bin', 'wasm', 'woff', 'woff2',
  'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'sqlite', 'db', 'psd',
  'sketch', 'lockb', 'pyc', 'node',
])
const MAX_BYTES = 1024 * 1024
const MAX_DEPTH = 3
const LOC_MS = 1500
const LOCK_MS = 10 * 60 * 1000

const missing = (bin: string): MissingError =>
  Object.assign(
    new Error(bin === 'graft' ? 'graft not installed — npm install -g @nanonets/graft' : `${bin} not found`),
    { missing: true },
  )

export function run(cmd: string[], opts?: RunOpts & { detached: true }): Child
export function run(cmd: string[], opts?: RunOpts): string
export function run(cmd: string[], opts: RunOpts = {}): RunResult {
  const { cwd, detached, env } = opts
  const bin = cmd[0]!
  if (cwd && !fsx.existsSync(cwd)) throw new Error(`directory not found: ${cwd}`)
  const childEnv = env ? { ...process.env, ...env } : process.env
  if (detached) {
    const child = spawn(bin, cmd.slice(1), { cwd, detached: true, stdio: 'ignore', env: childEnv })
    child.on('error', () => {})
    child.unref()
    return child
  }
  const r = spawnSync(bin, cmd.slice(1), { cwd, encoding: 'utf8', env: childEnv })
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw missing(bin)
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`\`${cmd.join(' ')}\` failed (exit ${r.status})\n${r.stderr}`)
  return r.stdout
}

export const runGit = (args: string[], opts?: RunOpts): string => run(['git', ...args], opts)

const try_ = <T>(fn: () => T): T | null => {
  try {
    return fn()
  } catch {
    return null
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const read = (p: string, fs: FS): string => try_(() => fs.readFileSync(p, 'utf8')) ?? ''

const norm = (p: string, fs: FS): string => try_(() => fs.realpathSync(p)) ?? p

const isRepo = (dir: string, fs: FS): boolean => fs.existsSync(join(dir, '.git'))

const findRepos = (root: string, { fs }: { fs: FS }): string[] => {
  const walk = (dir: string, depth: number, out: string[]): string[] => {
    const dirents = try_(() => fs.readdirSync(dir, { withFileTypes: true }))
    if (!dirents) return out
    dirents.reduce((memo: string[], d) => {
      const sub = join(dir, d.name)
      if (!d.isDirectory() || d.name === '.git' || d.name === 'node_modules') return memo
      if (isRepo(sub, fs)) {
        memo.push(sub)
        return memo
      }
      if (depth < MAX_DEPTH) walk(sub, depth + 1, memo)
      return memo
    }, out)
    return out
  }
  return (isRepo(root, fs) ? [root] : []).concat(walk(root, 1, []))
}

const lines = (s: string): number => (!s ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0))

const loc = (repo: string, { git, fs, now }: { git: Git; fs: FS; now: Clock }): { count: number; partial: boolean } => {
  const start = now()
  let partial = false
  const files = git(['ls-files'], { cwd: repo })
  if (!files) return { count: 0, partial: false }
  const count = files
    .trim()
    .split('\n')
    .filter(Boolean)
    .reduce((memo: number, f: string) => {
      if (now() - start > LOC_MS) {
        partial = true
        return memo
      }
      const full = join(repo, f)
      const stat = try_(() => fs.statSync(full))
      if (!stat || stat.size > MAX_BYTES) return memo
      const ext = f.split('.').pop()
      if (ext && BINARY_EXTS.has(ext.toLowerCase())) return memo
      return memo + lines(read(full, fs))
    }, 0)
  return { count, partial }
}

const remote = (repo: string, { git }: { git: Git }): string =>
  try_(() => git(['remote', 'get-url', 'origin'], { cwd: repo })?.trim()) ?? ''

const head = (repo: string, { git }: { git: Git }): string =>
  try_(() => git(['rev-parse', 'HEAD'], { cwd: repo })?.trim()) ?? ''

const commonDir = (repo: string, { git, fs }: { git: Git; fs: FS }): string => {
  const raw = try_(() => git(['rev-parse', '--git-common-dir'], { cwd: repo })?.trim())
  return raw ? norm(resolve(repo, raw), fs) : repo
}

interface ScanCacheEntry {
  sha: string
  remote: string
  loc: number
}

const readCache = (state: string | null | undefined, fs: FS): Record<string, ScanCacheEntry> => {
  if (!state) return {}
  const parsed = try_((): unknown => JSON.parse(read(join(state, 'graft-scan.json'), fs)))
  const repos = parsed !== null && isObj(parsed) && isObj(parsed.repos) ? parsed.repos : null
  if (!repos) return {}
  return Object.entries(repos).reduce((memo: Record<string, ScanCacheEntry>, [repo, v]) => {
    if (isObj(v) && typeof v.sha === 'string' && typeof v.remote === 'string' && typeof v.loc === 'number')
      memo[repo] = { sha: v.sha, remote: v.remote, loc: v.loc }
    return memo
  }, {})
}

const writeCache = (state: string | null | undefined, fs: FS, repos: Record<string, ScanCacheEntry>): void => {
  if (!state) return
  try_(() => {
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(join(state, 'graft-scan.json'), JSON.stringify({ version: 1, repos }, null, 2))
  })
}

export const scan = ({
  roots,
  git,
  fs,
  state,
  now = Date.now,
}: {
  roots?: string[]
  git: Git
  fs: FS
  state?: string | null
  now?: Clock
}): ScanEntry[] => {
  const cache = readCache(state, fs)
  const found = (roots ?? []).reduce((memo: string[], root) => memo.concat(findRepos(root, { fs })), [])

  const repos = Object.values(
    found.reduce<Record<string, string>>((memo, repo) => {
      const key = commonDir(repo, { git, fs })
      if (!memo[key] || norm(repo, fs) === dirname(key)) memo[key] = repo
      return memo
    }, {}),
  ).reduce<ScanEntry[]>((memo, repo) => {
    const sha = head(repo, { git })
    const hit = cache[repo]
    if (hit && hit.sha === sha) {
      memo.push({ path: repo, remote: hit.remote, loc: hit.loc })
      return memo
    }
    const counted = try_(() => loc(repo, { git, fs, now })) ?? { count: 0, partial: false }
    const entry: ScanEntry = { path: repo, remote: remote(repo, { git }), loc: counted.count }
    if (counted.partial) entry.partial = true
    else cache[repo] = { sha, remote: entry.remote, loc: entry.loc }
    memo.push(entry)
    return memo
  }, [])

  writeCache(state, fs, cache)
  return repos.sort((a, b) => b.loc - a.loc || a.path.localeCompare(b.path))
}

export const wired = (repoPath: string, { fs = fsx }: { fs?: FS } = {}): boolean =>
  fs.existsSync(join(repoPath, '.claude/skills/graft/SKILL.md')) &&
  fs.existsSync(join(repoPath, '.claude/helpers/graft-hooks.cjs')) &&
  /"graft"/.test(read(join(repoPath, '.mcp.json'), fs)) &&
  /graft-hooks/.test(
    read(join(repoPath, '.claude/settings.local.json'), fs) + read(join(repoPath, '.claude/settings.json'), fs),
  )

const INIT = ['graft', 'init', '--yes', '--no-global', '--no-statusline', '--no-agents', '--no-build']

export const wire = (
  repoPath: string,
  { exec = run, fs = fsx, env }: { exec?: GraftExec; fs?: FS; env?: NodeJS.ProcessEnv | null } = {},
): void => {
  if (wired(repoPath, { fs })) return
  exec(INIT, { cwd: repoPath, env })
}

const lockFile = (repoPath: string, state: string): string =>
  join(state, 'graft-build', `${createHash('sha1').update(repoPath).digest('hex')}.json`)

// a failed detached build leaves nothing but its stamp — the <10min window is
// the backoff that keeps a broken build from respawning on every shim launch
const locked = (
  repoPath: string,
  { fs, state, now }: { fs: FS; state?: string | null; now: Clock },
): 'locked' | 'recent' | null => {
  if (!state) return null
  const parsed = try_((): unknown => JSON.parse(read(lockFile(repoPath, state), fs)))
  if (!isObj(parsed)) return null
  const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
  if (now() - startedAt < LOCK_MS) return 'recent'
  if (typeof parsed.pid !== 'number') return null
  try {
    process.kill(parsed.pid, 0)
    return 'locked'
  } catch {
    return null
  }
}

const stamp = (
  repoPath: string,
  { pid, fs, state, now }: { pid: number | null; fs: FS; state?: string | null; now: Clock },
): void => {
  if (!state) return
  try_(() => {
    fs.mkdirSync(join(state, 'graft-build'), { recursive: true })
    fs.writeFileSync(lockFile(repoPath, state), JSON.stringify({ pid, startedAt: now() }))
  })
}

export type BuildResult = { started: boolean; pid?: number; reason?: 'locked' | 'recent' }

export const build = (
  repoPath: string,
  {
    exec = run,
    detached,
    env,
    fs = fsx,
    state = paths.state,
    now = Date.now,
  }: {
    exec?: GraftExec
    detached?: boolean
    env?: NodeJS.ProcessEnv | null
    fs?: FS
    state?: string | null
    now?: Clock
  } = {},
): BuildResult => {
  if (!detached) {
    exec(['graft', 'build'], { cwd: repoPath, env })
    return { started: true }
  }
  const reason = locked(repoPath, { fs, state, now })
  if (reason) return { started: false, reason }
  const spawned = exec(['graft', 'build'], { cwd: repoPath, detached: true, env })
  const pid = spawned && typeof spawned === 'object' ? spawned.pid ?? null : null
  stamp(repoPath, { pid, fs, state, now })
  return pid === null ? { started: true } : { started: true, pid }
}

export const ensure = (
  cwd: string,
  {
    config,
    exec = run,
    fs = fsx,
    git = runGit,
    state = paths.state,
    now = Date.now,
  }: {
    config?: GraftConfigSlice | null
    exec?: GraftExec
    fs?: FS
    git?: Git
    state?: string | null
    now?: Clock
  } = {},
): void => {
  const repos = config?.graft?.repos ?? []
  if (!repos.length) return
  try {
    const out = git(['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd })?.trim()
    if (!out) return
    const [toplevel, common] = out.split('\n')
    if (!toplevel || !common) return
    const mainRepo = norm(dirname(resolve(toplevel, common)), fs)
    const entry = repos.find((r) => norm(resolve(r.path), fs) === mainRepo)
    if (!entry) return
    if (fs.existsSync(join(toplevel, 'graft'))) return
    const env = entry.summaries ? summaries(entry.path, { config }) : undefined
    build(toplevel, { exec, detached: true, env, fs, state, now })
  } catch {}
}

export type SummaryEnv = { GRAFT_PROVIDER: string; GRAFT_BASE_URL: string; GRAFT_API_KEY: string }

export const summaries = (
  repoPath: string,
  {
    config,
    resolve: resolveId,
  }: {
    config?: GraftConfigSlice | null
    resolve?: (cwd: string, opts: { config?: GraftConfigSlice | null }) => Resolution
  } = {},
): SummaryEnv | null => {
  if (!config) return null
  const entry = (config.graft?.repos ?? []).find((r) => r.path === repoPath)
  if (!entry?.summaries) return null
  const identity: Resolution = (resolveId ?? resolveIdentity)(repoPath, { config })
  if (!identity.id) return null // no default identity → nothing for graft's summary calls to route through
  return {
    GRAFT_PROVIDER: 'openai',
    GRAFT_BASE_URL: `http://127.0.0.1:${config.port}/gateway/v1`,
    GRAFT_API_KEY: `barrito:${identity.id}`,
  }
}

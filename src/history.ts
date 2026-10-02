import fsx from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { home } from './paths.ts'
import { git as realGit, glob, resolve } from './identity.ts'
import type { Config, Git, HistoryHow, HistoryMove, HistoryProject } from './types.ts'

type Fs = typeof fsx
type HistoryConfig = Pick<Config, 'default' | 'identities'> & { graft?: Pick<Config['graft'], 'repos'> }
type Opts = { config: HistoryConfig; fs?: Fs; git?: Git }
type Known = { name: string; id: string; path: string | null }
type Meta = { cwd: string | null; branch: string | null }

const LIMIT = 16 * 1024 * 1024
const TRIVIAL = new Set(['', 'HEAD', 'main', 'master', 'develop', 'trunk'])

// Claude Code names a project dir after its launch cwd with every non-alphanumeric → '-'
export const enc = (p: string): string => String(p).replace(/[^A-Za-z0-9]/g, '-')

const decode = (name: string): string => name.replace(/^-/, '/').replaceAll('-', '/')

const list = (fs: Fs, dir: string): string[] => {
  try { return fs.readdirSync(dir) } catch { return [] }
}

const isDir = (fs: Fs, p: string): boolean => {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

const field = (line: string, key: string): string | null => {
  const hit = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`).exec(line)
  if (!hit) return null
  try { return JSON.parse(hit[1]!) as string } catch { return null }
}

// first line carrying `cwd` — read line by line, never the whole session
const meta = (fs: Fs, file: string): Meta => {
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch { return { cwd: null, branch: null } }
  const buf = Buffer.alloc(64 * 1024)
  const utf8 = new StringDecoder('utf8')
  try {
    let pos = 0
    let tail = ''
    while (pos < LIMIT) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (!n) return { cwd: field(tail, 'cwd'), branch: field(tail, 'gitBranch') }
      pos += n
      const lines = (tail + utf8.write(buf.subarray(0, n))).split('\n')
      tail = lines.pop() ?? ''
      const line = lines.find((l) => l.includes('"cwd":'))
      const cwd = line ? field(line, 'cwd') : null
      if (cwd) return { cwd, branch: field(line!, 'gitBranch') }
    }
    return { cwd: null, branch: null }
  } finally {
    fs.closeSync(fd)
  }
}

const sessionsOf = (fs: Fs, dir: string): string[] => list(fs, dir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => path.join(dir, f))
  .map((f) => ({ f, t: (() => { try { return fs.statSync(f).mtimeMs } catch { return 0 } })() }))
  .sort((a, b) => b.t - a.t)
  .map((x) => x.f)

const metaOf = (fs: Fs, files: string[]): Meta =>
  files.reduce<Meta>((hit, f) => hit.cwd ? hit : meta(fs, f), { cwd: null, branch: null })

// an encoded name back to the path on disk it was made from, by walking the fs; null when gone
const locate = (fs: Fs, dir: string, rest: string): string | null => {
  if (!rest) return dir
  return list(fs, dir).reduce<string | null>((hit, name) => {
    if (hit) return hit
    const e = enc(name)
    if (rest !== e && !rest.startsWith(`${e}-`)) return null
    const child = path.join(dir, name)
    if (rest !== e && !isDir(fs, child)) return null
    return locate(fs, child, rest === e ? '' : rest.slice(e.length + 1))
  }, null)
}

// a `…/**` path glob matched against an encoded name — decoding is lossy, encoding isn't
export const under = (globs: string[] | undefined, name: string): boolean => (globs ?? []).some((p) => {
  if (!p.endsWith('/**')) return glob(p, decode(name))
  const root = enc(p.slice(0, -3))
  return name === root || name.startsWith(`${root}-`)
})

// repos a deleted worktree can be traced back to: emdash/Conductor repository dirs,
// grafted repos, and exact repo names in config remotes
const knownRepos = (config: HistoryConfig, fs: Fs, git: Git): Known[] => {
  const h = home()
  const at = (dir: string): string[] => list(fs, dir).map((n) => path.join(dir, n)).filter((p) => isDir(fs, p))
  const workspaces = at(path.join(h, 'conductor', 'workspaces')).map((d) => ({ name: path.basename(d), path: at(d)[0] ?? null }))
  const dirs = [
    ...at(path.join(h, 'emdash', 'repositories')),
    ...at(path.join(h, 'conductor', 'repos')),
    ...(config.graft?.repos ?? []).map((r) => r.path),
  ].map((p) => ({ name: path.basename(p), path: p }))
  const repos = [...dirs, ...workspaces].reduce<Known[]>((memo, r) => {
    if (!r.path || !fs.existsSync(r.path)) return memo
    const id = resolve(r.path, { config, env: {}, git, cache: false }).id
    memo.push({ name: enc(r.name).toLowerCase(), id, path: r.path })
    return memo
  }, [])
  const named = Object.entries(config.identities).flatMap(([id, i]) => (i.match.remotes ?? [])
    .filter((r) => !r.includes('*'))
    .map((r) => ({ name: enc(r.split('/').pop() ?? '').toLowerCase(), id, path: null })))
  return [...repos, ...named].filter((k) => k.name)
}

const one = (ids: string[]): string | null => {
  const set = new Set(ids)
  return set.size === 1 ? [...set][0]! : null
}

const markers = (): string[] => {
  const h = home()
  return [
    ...[['emdash', 'worktrees'], ['emdash', 'repositories'], ['conductor', 'workspaces'], ['conductor', 'repos'], ['conductor', 'archived-contexts']]
      .map((parts) => `${enc(path.join(h, ...parts))}-`),
    '--emdash-',
    '--conductor-',
  ].map((m) => m.toLowerCase())
}

// worktree container name (`tybarho.com-dd36a54e/…`) → the repo it was cut from
const byName = (known: Known[], encoded: string): string | null => {
  const e = encoded.toLowerCase()
  const ids = markers().flatMap((m) => {
    const at = e.indexOf(m)
    if (at === -1) return []
    const rest = e.slice(at + m.length)
    const hits = known.filter((k) => rest === k.name || rest.startsWith(`${k.name}-`))
    const longest = hits.reduce((n, k) => Math.max(n, k.name.length), 0)
    return hits.filter((k) => k.name.length === longest).map((k) => k.id)
  })
  return one(ids)
}

// a feature branch that still exists in exactly one identity's repos
const byBranch = (known: Known[], branch: string | null, git: Git): string | null => {
  if (!branch || TRIVIAL.has(branch)) return null
  const ids = known
    .filter((k) => k.path && git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: k.path }))
    .map((k) => k.id)
  return one(ids)
}

const owners = (config: HistoryConfig): Array<[string, string]> => {
  const seen = new Set<string>()
  return Object.entries(config.identities).reduce<Array<[string, string]>>((memo, [id, i]) => {
    if (seen.has(i.claude_config_dir)) return memo
    seen.add(i.claude_config_dir)
    memo.push([id, i.claude_config_dir])
    return memo
  }, [])
}

export const scan = ({ config, fs = fsx, git = realGit }: Opts): HistoryProject[] => {
  let repos: Known[] | null = null
  const known = (): Known[] => repos ?? (repos = knownRepos(config, fs, git))
  const opts = { config, env: {}, git, cache: false as const }

  const where = (cwd: string, exact: boolean, name: string, branch: string | null): { to: string | null; how: HistoryHow } => {
    if (exact && fs.existsSync(cwd)) {
      const r = resolve(cwd, opts)
      return { to: r.id, how: r.rule === 'env' ? 'default' : r.rule }
    }
    const traced = byName(known(), exact ? enc(cwd) : name) ?? byBranch(known(), branch, git)
    if (traced) return { to: traced, how: 'metadata' }
    const pathId = exact
      ? [resolve(cwd, opts)].filter((r) => r.rule === 'path').map((r) => r.id)[0]
      : Object.entries(config.identities).find(([, i]) => under(i.match.paths, name))?.[0]
    if (pathId) return { to: pathId, how: 'path' }
    return { to: null, how: 'unknown' }
  }

  return owners(config).flatMap(([from, root]) => {
    const projects = path.join(root, 'projects')
    return list(fs, projects).sort().reduce<HistoryProject[]>((memo, name) => {
      const dir = path.join(projects, name)
      if (!isDir(fs, dir)) return memo
      const files = sessionsOf(fs, dir)
      const m = metaOf(fs, files)
      const found = m.cwd ?? (name.startsWith('-') ? locate(fs, '/', name.slice(1)) : null)
      const cwd = found ?? decode(name)
      const { to, how } = where(cwd, Boolean(found), name, m.branch)
      memo.push({ dir, cwd, sessions: files.length, memory: list(fs, path.join(dir, 'memory')).length > 0, from, to, how })
      return memo
    }, [])
  })
}

// every file under dir, relative, sorted
const walk = (fs: Fs, dir: string, rel = ''): string[] => list(fs, path.join(dir, rel)).sort().flatMap((n) => {
  const r = path.join(rel, n)
  let st: fsx.Stats
  try { st = fs.lstatSync(path.join(dir, r)) } catch { return [] }
  if (st.isDirectory()) return walk(fs, dir, r)
  return st.isFile() ? [r] : []
})

// identical size + mtime, or (an earlier copy that dropped the mtime) identical bytes
const same = (fs: Fs, src: string, dst: string): boolean => {
  const a = fs.statSync(src)
  const b = fs.statSync(dst)
  if (a.size !== b.size) return false
  if (Math.abs(a.mtimeMs - b.mtimeMs) < 1) return true
  return fs.readFileSync(src).equals(fs.readFileSync(dst))
}

// misplaced projects (and unknowns, when `include` names a target) with their per-file plan
export const moves = (projects: HistoryProject[], { config, fs = fsx, include = null }: { config: HistoryConfig; fs?: Fs; include?: string | null }): HistoryMove[] =>
  projects.reduce<HistoryMove[]>((memo, p) => {
    const to = p.to ?? include
    if (!to || to === p.from) return memo
    const identity = config.identities[to]
    if (!identity) return memo
    const target = path.join(identity.claude_config_dir, 'projects', path.basename(p.dir))
    if (path.resolve(target) === path.resolve(p.dir)) return memo
    const plan = walk(fs, p.dir).reduce((acc, rel) => {
      const dst = path.join(target, rel)
      if (!fs.existsSync(dst)) {
        acc.copy.push(rel)
        return acc
      }
      if (same(fs, path.join(p.dir, rel), dst)) {
        acc.same++
        return acc
      }
      acc.conflicts.push(rel)
      return acc
    }, { copy: [] as string[], same: 0, conflicts: [] as string[] })
    memo.push({ ...p, to, target, ...plan })
    return memo
  }, [])

// something left to copy — conflicts alone are reported, never actionable by sync
export const pending = (m: HistoryMove): boolean => m.copy.length > 0

// COPY only — never moves, deletes or overwrites; preserves mtimes
export const copy = (m: HistoryMove, { fs = fsx }: { fs?: Fs } = {}): string[] =>
  m.copy.reduce<string[]>((memo, rel) => {
    const src = path.join(m.dir, rel)
    const dst = path.join(m.target, rel)
    if (fs.existsSync(dst)) return memo
    const st = fs.statSync(src)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL)
    fs.utimesSync(dst, st.atimeMs / 1000, st.mtimeMs / 1000)
    memo.push(rel)
    return memo
  }, [])

// what init and doctor need: misplaced projects with something left to copy
export const outstanding = (config: HistoryConfig, { fs = fsx, git = realGit }: { fs?: Fs; git?: Git } = {}): HistoryMove[] =>
  moves(scan({ config, fs, git }), { config, fs }).filter(pending)

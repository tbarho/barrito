import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { stripVTControlCharacters as strip } from 'node:util'
import { enc, moves, scan, copy, outstanding } from '../src/history.ts'
import history from '../src/cli/history.ts'
import { load } from '../src/config.ts'
import { snap } from './fixtures/home/_copy.ts'
import type { CommandCtx, Config, HistoryProject, Identity } from '../src/types.ts'

const KEYS = ['BARRITO_HOME', 'BARRITO_STATE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
let prev: Record<string, string | undefined>
let home: string

beforeEach(() => {
  prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  // realpath: macOS tmp is /var → /private/var, and a deleted cwd can't be realpath'd later
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bhist')))
  process.env.BARRITO_HOME = home
  process.env.BARRITO_STATE = path.join(home, 'state')
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterEach(() => {
  KEYS.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
  fs.rmSync(home, { recursive: true, force: true })
})

const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { stdio: 'ignore' })
}

const repo = (rel: string, remote: string | null, branches: string[] = []): string => {
  const dir = path.join(home, rel)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  if (remote) git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'x')
  branches.forEach((b) => git(dir, 'branch', b))
  return dir
}

const idn = (id: string, dir: string, match: Identity['match']): Identity => ({
  id, claude_config_dir: path.join(home, dir), share_from: null, fallback: [], match, keychain: {},
})

const config = (): Config => ({
  ...load(path.join(home, 'none.toml')),
  default: 'work',
  identities: {
    work: idn('work', '.claude', { remotes: ['github.com/acme/*'], paths: [path.join(home, 'Code', 'acme', '**')] }),
    personal: idn('personal', '.claude-personal', { remotes: ['github.com/you/*'], paths: [path.join(home, 'Code', 'you', '**')] }),
  },
})

const T = new Date('2026-09-01T10:00:00.000Z')

// a fake Claude Code project dir: sessions carry cwd/gitBranch on their first user line
const project = (owner: '.claude' | '.claude-personal', cwd: string, { branch = 'main', sessions = 1, memory = false, name = enc(cwd) } = {}): string => {
  const dir = path.join(home, owner, 'projects', name)
  fs.mkdirSync(dir, { recursive: true })
  Array.from({ length: sessions }).forEach((_, i) => {
    const file = path.join(dir, `s${i}.jsonl`)
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'x'.repeat(100000) }),
      JSON.stringify({ type: 'user', cwd, gitBranch: branch, sessionId: `s${i}`, message: { content: 'hi "quoted"' } }),
      '',
    ].join('\n'))
    fs.utimesSync(file, T, T)
  })
  if (memory) {
    fs.mkdirSync(path.join(dir, 'memory'))
    fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '- a fact\n')
    fs.utimesSync(path.join(dir, 'memory', 'MEMORY.md'), T, T)
  }
  return dir
}

const byCwd = (list: HistoryProject[], cwd: string): HistoryProject => {
  const hit = list.find((p) => p.cwd === cwd)
  assert.ok(hit, `no project for ${cwd}`)
  return hit
}

const ctxOf = (out: string[], c = config()): CommandCtx & { code: number | null } => {
  const ctx = { config: c, print: (s: string) => { out.push(strip(s)) }, exit: (code: number) => { ctx.code = code }, code: null as number | null }
  return ctx
}

test('remote: an emdash worktree (personal only by git remote) in ~/.claude moves to personal', () => {
  const wt = repo('emdash/worktrees/site-1234abcd/tbarho-bold-cats', 'git@github.com:you/site.git')
  project('.claude', wt, { sessions: 2, memory: true })
  const p = byCwd(scan({ config: config() }), wt)
  assert.deepEqual({ from: p.from, to: p.to, how: p.how, sessions: p.sessions, memory: p.memory }, { from: 'work', to: 'personal', how: 'remote', sessions: 2, memory: true })
})

test('path: a non-git dir under a path glob; default: anything else', () => {
  const notes = path.join(home, 'Code', 'you', 'notes')
  const misc = path.join(home, 'misc')
  fs.mkdirSync(notes, { recursive: true })
  fs.mkdirSync(misc, { recursive: true })
  project('.claude', notes)
  project('.claude-personal', misc)
  const list = scan({ config: config() })
  assert.deepEqual([byCwd(list, notes).to, byCwd(list, notes).how], ['personal', 'path'])
  assert.deepEqual([byCwd(list, misc).from, byCwd(list, misc).to, byCwd(list, misc).how], ['personal', 'work', 'default'])
})

test('no session file: the encoded name is walked back to the dir on disk (dashes and dots survive)', () => {
  const dir = path.join(home, 'Code', 'you', 'my-site.com')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude', 'projects', enc(dir), 'memory'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'projects', enc(dir), 'memory', 'MEMORY.md'), 'x')
  const p = scan({ config: config() })[0]!
  assert.deepEqual([p.cwd, p.to, p.how, p.sessions, p.memory], [dir, 'personal', 'path', 0, true])
})

test('metadata: a deleted worktree is traced to its repo by container name, or by a surviving branch', () => {
  repo('emdash/repositories/site.com', 'https://github.com/you/site.com.git', ['tbarho/shiny-feature'])
  const gone = path.join(home, 'emdash', 'worktrees', 'site.com-dd36a54e', 'tbarho-strict-boxes')
  const branched = path.join(home, 'tmp', 'old-checkout')
  project('.claude', gone, { branch: 'tbarho/strict-boxes' })
  project('.claude', branched, { branch: 'tbarho/shiny-feature' })
  const list = scan({ config: config() })
  assert.deepEqual([byCwd(list, gone).to, byCwd(list, gone).how], ['personal', 'metadata'])
  assert.deepEqual([byCwd(list, branched).to, byCwd(list, branched).how], ['personal', 'metadata'])
})

test('metadata: an exact repo name in a config remote counts; the longest repo name wins', () => {
  const c = config()
  c.identities.work!.match.remotes.push('github.com/someone/site-admin')
  repo('emdash/repositories/site', 'git@github.com:you/site.git')
  const gone = path.join(home, 'emdash', 'worktrees', 'site-admin-0badf00d', 'feature')
  project('.claude-personal', gone)
  const p = byCwd(scan({ config: c }), gone)
  assert.deepEqual([p.to, p.how], ['work', 'metadata'])
})

test('ambiguous → unknown, never guessed', () => {
  repo('emdash/repositories/dup', 'git@github.com:you/dup.git')
  repo('conductor/repos/dup', 'git@github.com:acme/dup.git')
  const twin = path.join(home, 'emdash', 'worktrees', 'dup-12345678', 'x')
  const nowhere = path.join(home, 'gone', 'thing')
  project('.claude', twin)
  project('.claude', nowhere, { branch: 'main' })
  const list = scan({ config: config() })
  assert.deepEqual([byCwd(list, twin).to, byCwd(list, twin).how], [null, 'unknown'])
  assert.deepEqual([byCwd(list, nowhere).to, byCwd(list, nowhere).how], [null, 'unknown'])
  assert.deepEqual(moves(list, { config: config() }), [])
  assert.equal(moves(list, { config: config(), include: 'personal' }).length, 2)
})

test('dry run: prints sections + summary and writes nothing', async () => {
  const wt = repo('emdash/worktrees/site-1234abcd/feat', 'git@github.com:you/site.git')
  project('.claude', wt, { sessions: 3, memory: true })
  project('.claude', path.join(home, 'gone', 'x'))
  const kept = path.join(home, 'Code', 'acme', 'api')
  fs.mkdirSync(kept, { recursive: true })
  project('.claude', kept)
  const before = snap(home)
  const out: string[] = []
  await history(['sync'], ctxOf(out))
  assert.deepEqual(snap(home), before)
  const text = out.join('\n')
  assert.match(text, /work → personal/)
  assert.match(text, /~\/emdash\/worktrees\/site-1234abcd\/feat\s+3 sessions · memory · remote/)
  assert.match(text, /unknown — not copied[\s\S]*~\/gone\/x/)
  assert.match(text, /1 project to copy \(3 sessions\), 1 unknown, 1 already in place — barrito history sync --apply/)
})

test('--apply copies sessions + memory, preserves mtimes, never touches the source; re-run copies nothing', async () => {
  const wt = repo('emdash/worktrees/site-1234abcd/feat', 'git@github.com:you/site.git')
  const src = project('.claude', wt, { sessions: 2, memory: true })
  const before = fs.readdirSync(src)
  const out: string[] = []
  await history(['sync', '--apply'], ctxOf(out))
  const dst = path.join(home, '.claude-personal', 'projects', enc(wt))
  assert.deepEqual(fs.readdirSync(dst).sort(), ['memory', 's0.jsonl', 's1.jsonl'])
  assert.equal(fs.statSync(path.join(dst, 's0.jsonl')).mtimeMs, T.getTime())
  assert.equal(fs.statSync(path.join(dst, 'memory', 'MEMORY.md')).mtimeMs, T.getTime())
  assert.equal(fs.readFileSync(path.join(dst, 's1.jsonl'), 'utf8'), fs.readFileSync(path.join(src, 's1.jsonl'), 'utf8'))
  assert.deepEqual(fs.readdirSync(src), before, 'source kept — copy, never move')
  assert.match(out.join('\n'), /Copied[\s\S]*\(3 files\)/)
  assert.match(out.join('\n'), /1 project copied \(2 sessions\)/)

  const snapshot = snap(home)
  const again: string[] = []
  await history(['sync', '--apply'], ctxOf(again))
  assert.deepEqual(snap(home), snapshot)
  assert.match(again.join('\n'), /0 projects copied \(0 sessions\), 0 unknown, 2 already in place/, "the source (synced) + the copy (home)")
  assert.deepEqual(outstanding(config()), [])
})

test('conflict: a differing destination file is never overwritten; missing siblings still copy', async () => {
  const wt = repo('emdash/worktrees/site-1234abcd/feat', 'git@github.com:you/site.git')
  project('.claude', wt, { sessions: 2 })
  const dst = path.join(home, '.claude-personal', 'projects', enc(wt))
  fs.mkdirSync(dst, { recursive: true })
  fs.writeFileSync(path.join(dst, 's0.jsonl'), 'newer local session\n')
  const out: string[] = []
  await history(['sync', '--apply'], ctxOf(out))
  assert.equal(fs.readFileSync(path.join(dst, 's0.jsonl'), 'utf8'), 'newer local session\n')
  assert.ok(fs.existsSync(path.join(dst, 's1.jsonl')))
  assert.match(out.join('\n'), /s0\.jsonl differs — never overwritten/)
  const [m] = moves(scan({ config: config() }), { config: config() })
  assert.deepEqual([m?.copy, m?.conflicts], [[], ['s0.jsonl']])
  assert.deepEqual(copy(m!), [])
})

test('--include-unknown copies unknowns to the named identity; a bad identity exits 2', async () => {
  const gone = path.join(home, 'gone', 'x')
  project('.claude', gone)
  const out: string[] = []
  await history(['sync', '--apply', '--include-unknown', 'personal'], ctxOf(out))
  assert.ok(fs.existsSync(path.join(home, '.claude-personal', 'projects', enc(gone), 's0.jsonl')))
  const bad = ctxOf([])
  await history(['sync', '--include-unknown', 'nope'], bad)
  assert.equal(bad.code, 2)
})

test('--json: projects, moves and summary', async () => {
  const wt = repo('emdash/worktrees/site-1234abcd/feat', 'git@github.com:you/site.git')
  project('.claude', wt)
  const out: string[] = []
  await history(['sync', '--json'], ctxOf(out))
  const data = JSON.parse(out.join('\n')) as { summary: Record<string, number>; moves: Array<{ how: string; to: string }> }
  assert.deepEqual(data.summary, { copy: 1, sessions: 1, unknown: 0, inPlace: 0, conflicts: 0 })
  assert.deepEqual([data.moves[0]?.to, data.moves[0]?.how], ['personal', 'remote'])
})

test('doctor: ! when misplaced histories exist, silent once synced', async () => {
  const { diagnose } = await import('../src/cli/doctor.ts')
  const wt = repo('emdash/worktrees/site-1234abcd/feat', 'git@github.com:you/site.git')
  project('.claude', wt)
  const run = () => diagnose(config(), {
    fetch: async () => { throw new Error('refused') },
    exec: () => '',
    pathEnv: '/usr/bin:/bin',
    keychain: { get: () => null },
    settings: { read: () => ({}) },
    env: {},
  })
  const hit = (await run()).find((r) => r.text.includes('history sync'))
  assert.deepEqual(hit, { level: 'warn', text: "1 project history lives in another identity's dir (/resume can't see it) — barrito history sync" })
  await history(['sync', '--apply'], ctxOf([]))
  assert.equal((await run()).find((r) => r.text.includes('history sync')), undefined)
})

test('an earlier copy that dropped mtimes (same bytes) counts as in place; conflicts alone are not outstanding', async () => {
  const wt = repo('emdash/worktrees/site-1234abcd/feat', 'git@github.com:you/site.git')
  const src = project('.claude', wt, { sessions: 2 })
  const dst = path.join(home, '.claude-personal', 'projects', enc(wt))
  fs.cpSync(src, dst, { recursive: true })
  fs.writeFileSync(path.join(dst, 's1.jsonl'), 'diverged\n')
  const [m] = moves(scan({ config: config() }), { config: config() })
  assert.deepEqual([m?.copy, m?.same, m?.conflicts], [[], 1, ['s1.jsonl']])
  assert.deepEqual(outstanding(config()), [])
  const out: string[] = []
  await history(['sync'], ctxOf(out))
  assert.match(out.join('\n'), /0 projects to copy \(0 sessions\), 0 unknown, 2 already in place, 1 conflict/)
})

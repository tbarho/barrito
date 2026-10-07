import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, ensure, run, scan, summaries, wire } from '../src/graft.ts'
import { normalizeRemote } from '../src/identity.ts'
import type { GraftExec, MissingError, Resolution, RunOpts, ScanEntry } from '../src/types.ts'

delete process.env.BARRITO_IDENTITY

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'barrito-graft-'))
  process.env.BARRITO_STATE = join(dir, 'env-state')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sh = (cmd: string, args: string[], opts: ExecFileSyncOptions = {}): string =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }) as string

const git = (args: string[], opts: ExecFileSyncOptions = {}): string => sh('git', args, opts)

const gitRec = (log: string[]) => (args: string[], opts: ExecFileSyncOptions): string => {
  log.push(args[0] === 'ls-files' ? 'ls-files' : args.join(' '))
  return git(args, opts)
}

const repo = (path: string, files: Record<string, string> = {}): string => {
  mkdirSync(path, { recursive: true })
  git(['init', '-q'], { cwd: path })
  git(['config', 'user.email', 't@t.t'], { cwd: path })
  git(['config', 'user.name', 't'], { cwd: path })
  Object.entries(files).reduce((memo, [name, content]) => {
    writeFileSync(join(path, name), content)
    return memo
  }, null)
  git(['add', '.'], { cwd: path })
  git(['commit', '--allow-empty', '-qm', 'x'], { cwd: path })
  return path
}

const worktree = (main: string, path: string): string => {
  git(['worktree', 'add', '-q', path], { cwd: main })
  return path
}

const fakeExec = (): GraftExec & { calls: { cmd: string[]; opts: RunOpts | undefined }[] } => {
  const calls: { cmd: string[]; opts: RunOpts | undefined }[] = []
  const fn = (cmd: string[], opts?: RunOpts): void => {
    calls.push({ cmd, opts })
  }
  return Object.assign(fn, { calls })
}

const markWired = (r: string, settings = 'settings.local.json'): void => {
  mkdirSync(join(r, '.claude/skills/graft'), { recursive: true })
  mkdirSync(join(r, '.claude/helpers'), { recursive: true })
  writeFileSync(join(r, '.claude/skills/graft/SKILL.md'), 'skill')
  writeFileSync(join(r, '.claude/helpers/graft-hooks.cjs'), 'hooks')
  writeFileSync(join(r, '.mcp.json'), '{"mcpServers":{"graft":{}}}')
  writeFileSync(join(r, '.claude', settings), '{"graft-hooks":true}')
}

const state = (): string => join(dir, 'state')
const pathsOf = (repos: ScanEntry[]): string[] => repos.map((r) => r.path)

test('scan finds repos up to depth 3', () => {
  repo(join(dir, 'r1'))
  repo(join(dir, 'a/b/r2'))
  repo(join(dir, 'a/b/c/r3'))
  const repos = scan({ roots: [dir], git, fs, state: state() })
  assert.deepEqual(pathsOf(repos).sort(), [join(dir, 'a/b/r2'), join(dir, 'r1')])
})

test('scan skips node_modules and counts a .git file as a repo', () => {
  repo(join(dir, 'node_modules/x'))
  const main = repo(join(dir, 'main'))
  worktree(main, join(dir, 'wt'))
  const repos = scan({ roots: [dir], git, fs, state: state() })
  assert.deepEqual(pathsOf(repos), [join(dir, 'main')])
})

test('scan dedupes worktrees by git-common-dir', () => {
  const main = repo(join(dir, 'main'), { 'a.js': 'x\n' })
  worktree(main, join(dir, 'aa-wt'))
  const repos = scan({ roots: [dir], git, fs, state: state() })
  assert.equal(repos.length, 1)
  assert.equal(repos[0]?.path, main)
})

test('scan sorts by loc desc and captures the origin remote', () => {
  repo(join(dir, 'big'), { 'a.js': '1\n2\n3\n4\n5\n' })
  const small = repo(join(dir, 'small'), { 'a.js': '1\n' })
  git(['remote', 'add', 'origin', 'git@github.com:tbarho/barrito.git'], { cwd: small })
  const repos = scan({ roots: [dir], git, fs, state: state() })
  assert.deepEqual(pathsOf(repos), [join(dir, 'big'), join(dir, 'small')])
  assert.equal(normalizeRemote(repos[1]?.remote ?? ''), 'github.com/tbarho/barrito')
  assert.equal(repos[0]?.loc, 5)
})

test('scan loc skips binaries by extension and files over 1MB', () => {
  repo(join(dir, 'r'), {
    'index.js': 'a\nb\nc\n',
    'logo.png': 'a\nb\nc\nd\ne\n',
    'big.txt': 'x\n'.repeat(600000),
  })
  const repos = scan({ roots: [dir], git, fs, state: state() })
  assert.equal(repos[0]?.loc, 3)
})

test('scan caches by repo path + HEAD sha', () => {
  const r = repo(join(dir, 'r'), { 'a.js': '1\n2\n' })
  const log1: string[] = []
  const first = scan({ roots: [dir], git: gitRec(log1), fs, state: state() })
  assert.equal(log1.filter((l) => l === 'ls-files').length, 1)
  assert.ok(fs.existsSync(join(state(), 'graft-scan.json')))

  const log2: string[] = []
  assert.deepEqual(scan({ roots: [dir], git: gitRec(log2), fs, state: state() }), first)
  assert.equal(log2.filter((l) => l === 'ls-files').length, 0)

  git(['commit', '--allow-empty', '-qm', 'bump'], { cwd: r })
  const log3: string[] = []
  scan({ roots: [dir], git: gitRec(log3), fs, state: state() })
  assert.equal(log3.filter((l) => l === 'ls-files').length, 1)
})

test('wire runs graft init with the minimal flags', () => {
  const r = repo(join(dir, 'r'))
  const exec = fakeExec()
  wire(r, { exec })
  assert.equal(exec.calls.length, 1)
  assert.deepEqual(exec.calls[0]?.cmd, [
    'graft', 'init', '--yes', '--no-global', '--no-statusline', '--no-agents', '--no-build',
  ])
  assert.equal(exec.calls[0]?.opts?.cwd, r)
})

test('wire passes summaries env through to graft', () => {
  const r = repo(join(dir, 'r'))
  const exec = fakeExec()
  wire(r, { exec, env: { GRAFT_PROVIDER: 'openai' } })
  assert.deepEqual(exec.calls[0]?.opts?.env, { GRAFT_PROVIDER: 'openai' })
})

test('wire skips an already-wired repo', () => {
  const r = repo(join(dir, 'r'))
  markWired(r)
  const exec = fakeExec()
  wire(r, { exec })
  assert.equal(exec.calls.length, 0)
})

test('wire rewires when wiring is partial', () => {
  const r = repo(join(dir, 'r'))
  mkdirSync(join(r, '.claude/skills/graft'), { recursive: true })
  writeFileSync(join(r, '.claude/skills/graft/SKILL.md'), 'skill')
  const exec = fakeExec()
  wire(r, { exec })
  assert.equal(exec.calls.length, 1)
})

test('wire accepts hooks living in either settings file', () => {
  const r = repo(join(dir, 'r'))
  markWired(r, 'settings.json')
  const exec = fakeExec()
  wire(r, { exec })
  assert.equal(exec.calls.length, 0)
})

test('build spawns graft build with the detached flag and env', () => {
  const r = repo(join(dir, 'r'))
  const exec = fakeExec()
  assert.deepEqual(build(r, { exec, detached: true, env: { GRAFT_API_KEY: 'barrito:work' } }), { started: true })
  assert.deepEqual(build(r, { exec }), { started: true })
  assert.deepEqual(exec.calls[0], {
    cmd: ['graft', 'build'],
    opts: { cwd: r, detached: true, env: { GRAFT_API_KEY: 'barrito:work' } },
  })
  assert.deepEqual(exec.calls[1], { cmd: ['graft', 'build'], opts: { cwd: r, env: undefined } })
})

test('build reports why a detached build did not start', () => {
  const r = repo(join(dir, 'r'))
  const st = join(dir, 'locks')
  const exec = fakeExec()
  const lockPath = join(st, 'graft-build', `${createHash('sha1').update(r).digest('hex')}.json`)
  mkdirSync(join(st, 'graft-build'), { recursive: true })

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 11 * 60 * 1000 }))
  assert.deepEqual(build(r, { exec, detached: true, state: st }), { started: false, reason: 'locked' })

  writeFileSync(lockPath, JSON.stringify({ pid: 99999, startedAt: Date.now() }))
  assert.deepEqual(build(r, { exec, detached: true, state: st }), { started: false, reason: 'recent' })
  assert.equal(exec.calls.length, 0)
})

test('build detached with the default exec spawns, ignores stdio and unrefs', async () => {
  const out = join(dir, 'detached.txt')
  run(['sh', '-c', `echo ok > "${out}"`], { detached: true, cwd: dir })
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(fs.readFileSync(out, 'utf8').trim(), 'ok')
})

test('wire and build throw an actionable error when the graft binary is missing', () => {
  const noPath = { PATH: '/definitely-not-on-path' }
  assert.throws(
    () => run(['graft', 'build'], { env: noPath }),
    (err) =>
      err instanceof Error &&
      (err as Partial<MissingError>).missing === true &&
      err.message === 'graft not installed — npm install -g @nanonets/graft',
  )
  const r = repo(join(dir, 'r'))
  assert.throws(
    () => wire(r, { exec: (cmd: string[], opts?: RunOpts): string => run(cmd, { ...opts, env: noPath }) }),
    (err) => err instanceof Error && err.message === 'graft not installed — npm install -g @nanonets/graft',
  )
})

test('ensure triggers a detached build for a worktree of a configured repo', () => {
  const main = repo(join(dir, 'main'), { 'a.js': 'x\n' })
  const wt = worktree(main, join(dir, 'wt'))
  const config = { graft: { repos: [{ path: main, summaries: false }] } }
  const exec = fakeExec()
  ensure(wt, { config, exec, fs, git })
  assert.equal(exec.calls.length, 1)
  const real = fs.realpathSync(wt)
  assert.deepEqual(exec.calls[0], { cmd: ['graft', 'build'], opts: { cwd: real, detached: true, env: undefined } })
})

test('ensure triggers for the configured main repo itself', () => {
  const main = repo(join(dir, 'main'), { 'a.js': 'x\n' })
  const config = { graft: { repos: [{ path: main, summaries: false }] } }
  const exec = fakeExec()
  ensure(main, { config, exec, fs, git })
  assert.deepEqual(exec.calls[0], {
    cmd: ['graft', 'build'],
    opts: { cwd: fs.realpathSync(main), detached: true, env: undefined },
  })
})

test('ensure skips unconfigured repos, existing graphs and non-git dirs', () => {
  const main = repo(join(dir, 'main'), { 'a.js': 'x\n' })
  worktree(main, join(dir, 'wt'))
  const exec = fakeExec()
  ensure(join(dir, 'wt'), { config: { graft: { repos: [{ path: join(dir, 'nope') }] } }, exec, fs, git })

  mkdirSync(join(dir, 'wt/graft'))
  ensure(join(dir, 'wt'), { config: { graft: { repos: [{ path: main }] } }, exec, fs, git })
  rmSync(join(dir, 'wt/graft'), { recursive: true, force: true })

  ensure(dir, { config: { graft: { repos: [{ path: main }] } }, exec, fs, git })
  assert.equal(exec.calls.length, 0)
})

test('ensure never throws and stays cheap', () => {
  const wt = join(dir, 'wt')
  const exec = fakeExec()
  const failingGit = (): string => {
    throw new Error('boom')
  }
  assert.doesNotThrow(() => ensure(wt, { config: { graft: { repos: [{ path: wt }] } }, exec, fs, git: failingGit }))

  const fakeGit = (args: string[]): string => {
    if (args.join(' ') !== 'rev-parse --show-toplevel --git-common-dir') throw new Error('unexpected git call')
    return `${wt}\n${join(dir, 'main/.git')}\n`
  }
  const t0 = performance.now()
  ensure(wt, { config: { graft: { repos: [{ path: join(dir, 'main') }] } }, exec, fs, git: fakeGit })
  assert.ok(performance.now() - t0 < 100)
})

test('summaries env points graft at the barrito gateway', () => {
  const r = repo(join(dir, 'r'))
  const config = { port: 4141, graft: { repos: [{ path: r, summaries: true }] } }
  const seen: [string, { config?: unknown }][] = []
  const resolve = (cwd: string, opts: { config?: unknown }): Resolution => {
    seen.push([cwd, opts])
    return { id: 'work', rule: 'default', detail: '' }
  }
  assert.deepEqual(summaries(r, { config, resolve }), {
    GRAFT_PROVIDER: 'openai',
    GRAFT_BASE_URL: 'http://127.0.0.1:4141/gateway/v1',
    GRAFT_API_KEY: 'barrito:work',
  })
  assert.equal(seen[0]?.[0], r)
  assert.equal(seen[0]?.[1]?.config, config)

  const off = { port: 4141, graft: { repos: [{ path: r, summaries: false }] } }
  assert.equal(summaries(r, { config: off, resolve }), null)
  assert.equal(summaries(join(dir, 'nope'), { config, resolve }), null)

  const noDefault = (cwd: string): Resolution => {
    seen.push([cwd, {}])
    return { id: '', rule: 'default', detail: '' }
  }
  assert.equal(summaries(r, { config: { graft: { repos: [{ path: r, summaries: true }] } }, resolve: noDefault }), null)
})

test('run distinguishes a missing cwd from a missing binary', () => {
  const gone = join(dir, 'gone')
  assert.throws(
    () => run(['graft', 'build'], { cwd: gone }),
    (err) =>
      err instanceof Error &&
      err.message === `directory not found: ${gone}` &&
      !(err as Partial<MissingError>).missing,
  )
})

test('ensure returns before spawning git when graft.repos is empty', () => {
  const gitCalls: string[] = []
  const spy = (args: string[], opts: ExecFileSyncOptions): string => {
    gitCalls.push(args.join(' '))
    return git(args, opts)
  }
  const exec = fakeExec()
  ensure(join(dir, 'main'), { config: { graft: { repos: [] } }, exec, fs, git: spy, state: state() })
  assert.equal(gitCalls.length, 0)
  assert.equal(exec.calls.length, 0)
})

test('ensure gives worktree builds the summaries env of the configured repo', () => {
  const main = repo(join(dir, 'main'), { 'a.js': 'x\n' })
  const wt = worktree(main, join(dir, 'wt'))
  const config = { port: 4141, default: 'work', graft: { repos: [{ path: main, summaries: true }] } }
  const exec = fakeExec()
  ensure(wt, { config, exec, fs, git, state: state() })
  assert.deepEqual(exec.calls[0]?.opts?.env, {
    GRAFT_PROVIDER: 'openai',
    GRAFT_BASE_URL: 'http://127.0.0.1:4141/gateway/v1',
    GRAFT_API_KEY: 'barrito:work',
  })
})

test('a fresh build stamp holds, a stale dead one frees, a live pid holds', () => {
  const main = repo(join(dir, 'main'), { 'a.js': 'x\n' })
  const wt = worktree(main, join(dir, 'wt'))
  const config = { graft: { repos: [{ path: main }] } }
  const st = state()
  const exec = fakeExec()
  ensure(wt, { config, exec, fs, git, state: st })
  ensure(wt, { config, exec, fs, git, state: st })
  assert.equal(exec.calls.length, 1)

  const lockState = join(dir, 'locks')
  const wtTop = fs.realpathSync(wt)
  const lockPath = join(lockState, 'graft-build', `${createHash('sha1').update(wtTop).digest('hex')}.json`)
  mkdirSync(join(lockState, 'graft-build'), { recursive: true })
  const deadPid = [99999, 199999, 299999].find((pid) => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  })
  writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: Date.now() - 11 * 60 * 1000 }))
  ensure(wt, { config, exec, fs, git, state: lockState })
  assert.equal(exec.calls.length, 2)

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 11 * 60 * 1000 }))
  ensure(wt, { config, exec, fs, git, state: lockState })
  assert.equal(exec.calls.length, 2)
})

test('scan marks a repo partial when its loc budget trips and does not cache it', () => {
  const r = repo(join(dir, 'r'), { 'a.js': 'a\nb\n', 'c.js': 'c\n' })
  let n = 0
  const now = (): number => [0, 1, 5000][n++] ?? 5000
  const repos = scan({ roots: [dir], git, fs, state: state(), now })
  assert.deepEqual(repos, [{ path: r, remote: '', loc: 2, partial: true }])
  assert.deepEqual((JSON.parse(fs.readFileSync(join(state(), 'graft-scan.json'), 'utf8')) as { repos: unknown }).repos, {})
})

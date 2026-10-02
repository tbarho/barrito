import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolve, peek, normalizeRemote, glob, git as defaultGit } from '../src/identity.ts'
import type { Git, IdentityCache, IdentityCacheEntry } from '../src/types.ts'

type IdentityTestConfig = {
  default: string
  identities: Record<string, { id: string; match: { remotes: string[]; paths: string[] }; keychain?: Record<string, string> }>
}

const config: IdentityTestConfig = {
  default: 'personal',
  identities: {
    work: { id: 'work', match: { remotes: ['github.com/acme/*'], paths: [] }, keychain: { gateway: 'Vercel AI Gateway Work', cursor: 'Cursor Work' } },
    personal: { id: 'personal', match: { remotes: ['github.com/you/*'], paths: [] } },
  },
}

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'barrito-identity-'))

// git(args, { cwd }) — graft's form; args[0] is the subcommand
const fakeGit = (repo: { top?: string | null; common?: string | null; url?: string | null } = {}): Git & { calls: number } => {
  const fn = ((args: string[]) => {
    fn.calls += 1
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return repo.top ?? null
    if (args[0] === 'rev-parse') return repo.common ?? null
    if (args[0] === 'remote') return repo.url ?? null
    return null
  }) as unknown as Git & { calls: number }
  fn.calls = 0
  return fn
}

const memCache = () => {
  const m = new Map<string, IdentityCacheEntry>()
  const cache: IdentityCache & { size: () => number; map: Map<string, IdentityCacheEntry> } = {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, v) },
    size: () => m.size,
    map: m,
  }
  return cache
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

describe('normalizeRemote', () => {
  const cases: [string, string][] = [
    ['git@github.com:acme/api.git', 'github.com/acme/api'],
    ['git@github.com:acme/web', 'github.com/acme/web'],
    ['https://github.com/acme/api', 'github.com/acme/api'],
    ['https://github.com/acme/api.git', 'github.com/acme/api'],
    ['https://github.com/acme/api.git/', 'github.com/acme/api'],
    ['ssh://git@github.com:22/acme/api.git', 'github.com/acme/api'],
    ['ssh://git@github.com/acme/api', 'github.com/acme/api'],
    ['git@git.corp.example.com:team/repo.git', 'git.corp.example.com/team/repo'],
    ['https://github.example.com/owner/repo.git', 'github.example.com/owner/repo'],
    ['https://user:token@github.com/owner/repo', 'github.com/owner/repo'],
    ['git://github.com/owner/repo.git', 'github.com/owner/repo'],
    ['https://github.com/owner/repo/', 'github.com/owner/repo'],
    // case-insensitive: real remotes come in mixed case
    ['git@github.com:Acme/Arts.git', 'github.com/acme/arts'],
    ['https://GitHub.com/Owner/Repo', 'github.com/owner/repo'],
    // ssh host aliases like `github.com-work`
    ['git@github.com-work:acme/x.git', 'github.com/acme/x'],
    ['ssh://git@github.com-personal:2222/you/y.git', 'github.com/you/y'],
    ['git@gitlab.com-work:group/sub/repo.git', 'gitlab.com/group/sub/repo'],
    ['git@bitbucket.org-alt:team/repo.git', 'bitbucket.org/team/repo'],
  ]
  for (const [url, expected] of cases) {
    test(`${url} → ${expected}`, () => assert.equal(normalizeRemote(url), expected))
  }
})

describe('glob', () => {
  test('* stays within one segment', () => {
    assert.equal(glob('github.com/acme/*', 'github.com/acme/api'), true)
    assert.equal(glob('github.com/acme/*', 'github.com/acme/a/b'), false)
    assert.equal(glob('github.com/acme/*', 'github.com/you/x'), false)
    assert.equal(glob('github.com/acme/*', 'evil.com/acme/x'), false)
  })

  test('** matches any depth, including zero', () => {
    assert.equal(glob('a/**/b', 'a/b'), true)
    assert.equal(glob('a/**/b', 'a/x/y/b'), true)
    assert.equal(glob('a/**/b', 'a/x/y'), false)
    assert.equal(glob('**/x', 'x'), true)
    assert.equal(glob('**/x', 'a/b/x'), true)
    assert.equal(glob('/Users/x/Code/**', '/Users/x/Code/acme/api/packages/a'), true)
    assert.equal(glob('/Users/x/Code/**', '/Users/x/Other/a'), false)
  })

  test('trailing /** also matches the dir itself', () => {
    assert.equal(glob('/Users/x/Code/acme/**', '/Users/x/Code/acme'), true)
    assert.equal(glob('/Users/x/Code/acme/**', '/Users/x/Code/acme/api/lib/b'), true)
    assert.equal(glob('/Users/x/Code/acme/**', '/Users/x/Code/other'), false)
  })
})

describe('resolve order', () => {
  test('BARRITO_IDENTITY wins over everything', () => {
    const dir = tmp()
    const r = resolve(dir, {
      config,
      env: { BARRITO_IDENTITY: 'work' },
      git: fakeGit({ top: dir, url: 'git@github.com:you/x.git' }),
      cache: memCache(),
    })
    assert.deepEqual(r, { id: 'work', rule: 'env', detail: 'BARRITO_IDENTITY' })
  })

  test('remote match is case-insensitive on both sides', () => {
    const dir = tmp()
    const cfg = { default: 'personal', identities: { work: { id: 'work', match: { remotes: ['GitHub.com/Acme/*'], paths: [] } } } }
    const r = resolve(dir, { config: cfg, git: fakeGit({ top: dir, url: 'git@github.com:Acme/Arts.git' }), cache: memCache() })
    assert.deepEqual(r, { id: 'work', rule: 'remote', detail: 'github.com/acme/arts' })
  })

  test('ssh host alias remote matches the base host glob', () => {
    const dir = tmp()
    const r = resolve(dir, { config, git: fakeGit({ top: dir, url: 'git@github.com-work:acme/x.git' }), cache: memCache() })
    assert.deepEqual(r, { id: 'work', rule: 'remote', detail: 'github.com/acme/x' })
  })

  test('remote beats path', () => {
    const dir = fs.realpathSync(tmp())
    const cfg = {
      default: 'personal',
      identities: {
        work: { id: 'work', match: { remotes: [], paths: [`${dir}/**`] } },
        personal: { id: 'personal', match: { remotes: ['github.com/you/*'], paths: [] } },
      },
    }
    const r = resolve(dir, { config: cfg, git: fakeGit({ top: dir, url: 'git@github.com:you/x.git' }), cache: memCache() })
    assert.equal(r.id, 'personal')
    assert.equal(r.rule, 'remote')
  })

  test('path match for a repo without a remote', () => {
    const dir = fs.realpathSync(tmp())
    const cfg = { default: 'personal', identities: { work: { id: 'work', match: { remotes: [], paths: [`${dir}/**`] } } } }
    const r = resolve(dir, { config: cfg, git: fakeGit({ top: dir, url: null }), cache: memCache() })
    assert.deepEqual(r, { id: 'work', rule: 'path', detail: `${dir}/**` })
  })

  test('GitHub Actions repository matches as a remote when origin is missing', () => {
    const dir = tmp()
    const r = resolve(dir, {
      config,
      env: { GITHUB_REPOSITORY: 'acme/api' },
      git: fakeGit({ top: dir, url: null }),
      cache: memCache(),
    })
    assert.deepEqual(r, {
      id: 'work',
      rule: 'remote',
      detail: 'github.com/acme/api (GITHUB_REPOSITORY)',
    })
  })

  test('path match for a non-repo dir', () => {
    const dir = fs.realpathSync(tmp())
    const cfg = { default: 'personal', identities: { work: { id: 'work', match: { remotes: [], paths: [`${dir}/**`] } } } }
    const r = resolve(dir, { config: cfg, git: fakeGit({}), cache: memCache() })
    assert.deepEqual(r, { id: 'work', rule: 'path', detail: `${dir}/**` })
  })

  test('path patterns are matched with their fixed prefix realpathed (/var vs /private/var)', (t) => {
    const base = join(os.tmpdir(), `barrito-prefix-${process.pid}`) // tmpdir form; realpath differs on macOS
    const dir = join(base, 'sub')
    fs.mkdirSync(dir, { recursive: true })
    t.after(() => fs.rmSync(base, { recursive: true, force: true }))
    const cfg = { default: 'personal', identities: { work: { id: 'work', match: { remotes: [], paths: [`${base}/**`] } } } }
    const r = resolve(dir, { config: cfg, git: fakeGit({}), cache: memCache() })
    assert.equal(r.id, 'work')
    assert.equal(r.rule, 'path')
  })

  test('default when nothing matches', () => {
    const dir = tmp()
    const r = resolve(dir, {
      config,
      git: fakeGit({ top: dir, url: 'git@gitlab.com:somewhere/else.git' }),
      cache: memCache(),
    })
    assert.deepEqual(r, { id: 'personal', rule: 'default', detail: 'personal' })
  })
})

describe('cache (keyed by realpath, validated by git config mtime + fingerprint)', () => {
  // a fake repo whose git config file is real, so the mtime check can pass
  const fakeRepo = () => {
    const dir = fs.realpathSync(tmp())
    const common = join(dir, 'common')
    fs.mkdirSync(common)
    fs.writeFileSync(join(common, 'config'), '[remote "origin"]\n')
    return { dir, common, config: join(common, 'config') }
  }

  const cfgFor = (remotes: { work: string; personal: string }) => ({
    default: 'personal',
    identities: {
      work: { id: 'work', match: { remotes: [remotes.work], paths: [] } },
      personal: { id: 'personal', match: { remotes: [remotes.personal], paths: [] } },
    },
  })

  test('cold resolves via git, warm hit makes zero git calls', () => {
    const repo = fakeRepo()
    const cfg = cfgFor({ work: 'github.com/acme/*', personal: 'github.com/you/*' })
    const git = fakeGit({ top: repo.dir, url: 'git@github.com:acme/x.git', common: repo.common })
    const cache = memCache()

    const cold = resolve(repo.dir, { config: cfg, git, cache })
    assert.equal(cold.id, 'work')
    assert.equal(git.calls, 3)
    const entry = cache.map.get(repo.dir)
    assert.ok(entry)
    assert.equal(entry.configFile, repo.config)
    assert.equal(entry.result.id, 'work')

    const warm = resolve(repo.dir, { config: cfg, git, cache })
    assert.equal(git.calls, 3) // no new git calls
    assert.deepEqual(warm, cold)
    assert.equal(peek(repo.dir, { config: cfg, cache })!.result.id, 'work')

    cfg.identities.work.match.remotes = [] // match config change → fingerprint invalidates
    assert.equal(git.calls, 3)
    const redone = resolve(repo.dir, { config: cfg, git, cache })
    assert.equal(git.calls, 6)
    assert.equal(redone.id, 'personal') // no remote match left → default
  })

  test('changed remote edits the git config → mtime invalidates', async () => {
    const repo = fakeRepo()
    const cfg = cfgFor({ work: 'github.com/acme/*', personal: 'github.com/you/*' })
    const git = fakeGit({ top: repo.dir, url: 'git@github.com:acme/x.git', common: repo.common })
    const cache = memCache()
    assert.equal(resolve(repo.dir, { config: cfg, git, cache }).id, 'work')

    await new Promise((done) => setTimeout(done, 10))
    fs.writeFileSync(repo.config, '[remote "origin"]\nurl = git@github.com:you/x.git\n')
    const git2 = fakeGit({ top: repo.dir, url: 'git@github.com:you/x.git', common: repo.common })
    const r = resolve(repo.dir, { config: cfg, git: git2, cache })
    assert.equal(r.id, 'personal')
    assert.equal(r.rule, 'remote')
    assert.equal(git2.calls, 3)
  })

  test('match config change (fingerprint) invalidates even without a git config touch', () => {
    const repo = fakeRepo()
    const cfg = cfgFor({ work: 'github.com/acme/*', personal: 'github.com/you/*' })
    const git = fakeGit({ top: repo.dir, url: 'git@github.com:acme/x.git', common: repo.common })
    const cache = memCache()
    resolve(repo.dir, { config: cfg, git, cache })
    assert.equal(git.calls, 3)

    const git2 = fakeGit({ top: repo.dir, url: 'git@github.com:acme/x.git', common: repo.common })
    cfg.identities.work.match.remotes = []
    const r = resolve(repo.dir, { config: cfg, git: git2, cache })
    assert.equal(r.id, 'personal')
    assert.equal(git2.calls, 3)
  })

  test('non-repo dirs are cached and stay warm with zero git calls — until .git appears', () => {
    const dir = fs.realpathSync(tmp())
    const cfg = { default: 'personal', identities: { work: { id: 'work', match: { remotes: [], paths: [`${dir}/**`] } } } }
    const git = fakeGit({})
    const cache = memCache()
    assert.equal(resolve(dir, { config: cfg, git, cache }).id, 'work')
    assert.equal(resolve(dir, { config: cfg, git, cache }).id, 'work')
    assert.equal(git.calls, 1)

    fs.mkdirSync(join(dir, '.git'))
    const git2 = fakeGit({ top: dir, url: 'git@github.com:you/x.git' })
    const after = resolve(dir, { config: cfg, git: git2, cache })
    assert.equal(after.rule, 'path') // no identity matches the remote; the path glob still does
    assert.equal(after.id, 'work')
    assert.equal(git2.calls, 3)
  })

  test('env overrides and cache:false bypass the cache entirely', () => {
    const repo = fakeRepo()
    const cfg = cfgFor({ work: 'github.com/acme/*', personal: 'github.com/you/*' })
    const git = fakeGit({ top: repo.dir, url: 'git@github.com:you/x.git', common: repo.common })
    const cache = memCache()
    resolve(repo.dir, { config: cfg, env: { BARRITO_IDENTITY: 'work' }, git, cache })
    assert.equal(cache.size(), 0)
    resolve(repo.dir, { config: cfg, git, cache: false })
    assert.equal(cache.size(), 0)
  })

  const setState = (v: string | undefined): void => {
    if (v === undefined) delete process.env.BARRITO_STATE
    else process.env.BARRITO_STATE = v
  }

  test('which.json: pre-toplevel flat format migrates and stays warm', (t) => {
    const state = fs.mkdtempSync(join(os.tmpdir(), 'barrito-which-'))
    const saved = process.env.BARRITO_STATE
    setState(state)
    t.after(() => {
      setState(saved)
      fs.rmSync(state, { recursive: true, force: true })
    })

    const repo = fakeRepo()
    const cfg = cfgFor({ work: 'github.com/acme/*', personal: 'github.com/you/*' })
    const git = fakeGit({ top: repo.dir, url: 'git@github.com:acme/x.git', common: repo.common })
    const mem = memCache()
    resolve(repo.dir, { config: cfg, git, cache: mem, env: {} })
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(join(state, 'which.json'), JSON.stringify({ [repo.dir]: mem.map.get(repo.dir) }))

    const git2 = fakeGit({ top: repo.dir, url: 'git@github.com:acme/x.git', common: repo.common })
    assert.equal(resolve(repo.dir, { config: cfg, git: git2, env: {} }).id, 'work')
    assert.equal(git2.calls, 0)

    cfg.identities.work.match.remotes = [] // cold again → the rewrite lands in the new format
    const git3 = fakeGit({ top: repo.dir, url: 'git@github.com:you/x.git', common: repo.common })
    assert.equal(resolve(repo.dir, { config: cfg, git: git3, env: {} }).id, 'personal')
    const which = JSON.parse(fs.readFileSync(join(state, 'which.json'), 'utf8'))
    assert.deepEqual(Object.keys(which.repos), [repo.dir])
    assert.deepEqual(which.dirs, { [repo.dir]: repo.dir })
  })
})

describe('real git (default helper)', () => {
  const withGitEnv = (fn: () => void): void => {
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    try {
      return fn()
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL
      process.env.GIT_CONFIG_SYSTEM = saved.GIT_CONFIG_SYSTEM
    }
  }

  test('cold cache resolves via origin remote; warm makes zero git spawns', () => {
    const dir = tmp()
    const real = fs.realpathSync(dir)
    let calls = 0
    const countingGit: Git = (args, opts) => {
      calls += 1
      return defaultGit(args, opts)
    }
    try {
      withGitEnv(() => {
        execFileSync('git', ['init', '-q', dir])
        execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/api.git'])
      })
      const cache = memCache()
      const cold = resolve(dir, { config, git: countingGit, cache })
      assert.deepEqual(cold, { id: 'work', rule: 'remote', detail: 'github.com/acme/api' })
      assert.equal(calls, 3)
      assert.equal(cache.map.get(real)!.configFile, join(real, '.git', 'config'))

      const warm = resolve(dir, { config, git: countingGit, cache })
      assert.deepEqual(warm, cold)
      assert.equal(calls, 3) // zero git spawns on the warm path
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fileCache: a never-seen subdir of a cached repo is warm with zero git spawns', (t) => {
    const state = fs.mkdtempSync(join(os.tmpdir(), 'barrito-which-'))
    const saved = process.env.BARRITO_STATE
    process.env.BARRITO_STATE = state
    t.after(() => {
      if (saved === undefined) delete process.env.BARRITO_STATE
      else process.env.BARRITO_STATE = saved
      fs.rmSync(state, { recursive: true, force: true })
    })

    const dir = fs.realpathSync(tmp())
    const sub = join(dir, 'packages', 'x')
    fs.mkdirSync(sub, { recursive: true })
    let calls = 0
    const countingGit: Git = (args, opts) => {
      calls += 1
      return defaultGit(args, opts)
    }
    try {
      withGitEnv(() => {
        execFileSync('git', ['init', '-q', dir])
        execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/api.git'])
      })
      const cold = resolve(sub, { config, git: countingGit, env: {} }) // no cache option → which.json
      assert.deepEqual(cold, { id: 'work', rule: 'remote', detail: 'github.com/acme/api' })
      assert.equal(calls, 3)

      calls = 0
      const warm = resolve(join(sub, 'deeper', 'y'), { config, git: countingGit, env: {} })
      assert.deepEqual(warm, cold)
      assert.equal(calls, 0) // the .git walkup found the toplevel without a spawn

      const which = JSON.parse(fs.readFileSync(join(state, 'which.json'), 'utf8'))
      assert.deepEqual(Object.keys(which.repos), [dir])
      assert.equal(which.dirs[sub], dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('git(args, { cwd }) returns null on failure', () => {
    withGitEnv(() => assert.equal(defaultGit(['rev-parse', '--show-toplevel'], { cwd: tmp() }), null))
  })
})

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { copy, env, snap } from './fixtures/home/_copy.ts'
import init from '../src/cli/init.ts'
import { io } from '../src/cli/init.ts'
import type { Io, Prompts } from '../src/cli/init.ts'
import uninstall from '../src/cli/uninstall.ts'
import { detect, rcOpen, rcClose } from '../src/detect.ts'
import { load, save } from '../src/config.ts'
import * as settings from '../src/settings.ts'
import type { Ctx } from '../src/types.ts'

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url)), 'utf8')).data

const KEYS = ['BARRITO_HOME', 'BARRITO_CONFIG', 'BARRITO_STATE', 'BARRITO_LOG', 'BARRITO_SHIMS', 'BARRITO_PLATFORM']
let prev: Record<string, string | undefined>, home: string

beforeEach(() => {
  prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  home = env(copy())
  process.env.BARRITO_PLATFORM = 'darwin' // these suites assert launchd behavior; linux gets its own tests below
})

afterEach(() => {
  KEYS.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
  fs.rmSync(home, { recursive: true, force: true })
})

const fakes = () => {
  const calls: Array<{ bin: string; args: string[]; spawn?: boolean }> = []
  const items: Record<string, string> = { 'Vercel AI Gateway': 'gw-personal-key', 'Vercel AI Gateway Work': 'gw-work-key' }
  const exec = (bin: string, args: string[]): string => {
    calls.push({ bin, args })
    if (args[0] === 'print') throw new Error('not loaded')
    if (args[0] === '--version') return 'fake 1.0.0'
    return ''
  }
  const keychain = {
    get: (s: string): string | null => items[s] ?? null,
    set: (s: string, v: string): void => { items[s] = v },
  }
  const io: Io = {
    exec,
    keychain,
    catalog,
    sleep: async () => {},
    bin: '/usr/local/bin/barrito',
    script: '/usr/local/bin/barrito',
    node: process.execPath,
    pathEnv: `${home}/bin:/usr/bin:/bin`,
    shell: '/bin/zsh',
    // the injected login re-check — tests answer the "logged in?" confirm against this
    account: (): { loggedIn: boolean; email: string | null } => ({ loggedIn: false, email: null }),
    spawn: (bin: string, args: string[]): void => { calls.push({ bin, args, spawn: true }) },
  }
  return { calls, items, exec, keychain, io }
}

const stdout = async (fn: () => Promise<unknown>): Promise<string> => {
  const chunks: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((s: unknown) => { chunks.push(String(s)); return true }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = write
  }
  return chunks.join('')
}

// Ctx.exit is `never` (bin/init contract); the fake must return so tests can keep
// asserting output past the call — one centralized cast instead of one per call site
const fakeExit = (out: string[]): Ctx['exit'] =>
  ((code: number) => { out.push(`__exit${code}`) }) as Ctx['exit']

const run = async (argv: string[], f: ReturnType<typeof fakes>, io: Io = f.io): Promise<string[]> => {
  const out: string[] = []
  await init(argv, {
    config: null,
    print: (s: string) => { out.push(s) },
    exit: fakeExit(out),
    io,
  })
  return out
}

// strict-order prompt script: every interactive prompt must match the next queued answer
const script = (queue: Array<[RegExp, unknown]>): Prompts => {
  let i = 0
  const next = (message: string): unknown => {
    assert.ok(i < queue.length, `unexpected prompt: "${message}"`)
    const [re, answer] = queue[i]!
    assert.match(message, re, `prompt #${i} out of order: "${message}"`)
    i++
    return answer
  }
  return {
    confirm: async (message: string, _opts?: { value?: boolean }): Promise<boolean> => Boolean(next(message)),
    text: async (message: string, _opts?: { default?: string; validate?: (value: string) => string | undefined }): Promise<string> => String(next(message)),
    select: async <V extends string>(message: string, _opts: { initialValue?: V; options: Array<{ value: V; label?: string }> }): Promise<V> => next(message) as V,
    multiselect: async <V extends string>(message: string, _opts: { options: Array<{ value: V; label?: string }>; initialValues?: V[]; required?: boolean }): Promise<V[]> => next(message) as V[],
  }
}

test('--dry-run --yes: prints the plan, writes nothing, exits 0', async () => {
  const f = fakes()
  const before = snap(home)
  const out: string[] = []
  const text = await stdout(async () => {
    await init(['--dry-run', '--yes'], {
      config: null,
      print: (s: string) => { out.push(s) },
      exit: fakeExit(out),
      io: f.io,
    })
  })
  const plan = out.join('\n')
  assert.match(plan, /back up 9 existing file\(s\)/)
  assert.match(plan, /boot out and remove the legacy claude-router/)
  assert.match(plan, /replace legacy shims/)
  assert.match(plan, /remove 3 \.envrc symlink/)
  assert.match(plan, /\+ copy 2 keychain keys into barrito-owned items \(one macOS prompt each\)/)
  assert.match(text, /work and personal have no match globs yet — every directory resolves to the default identity/)
  assert.match(plan, /retired: openai\/gpt-5\.6-luna \(dropped\)/)
  assert.match(plan, /seed \[models\]/)
  assert.match(text, /dry run — nothing written/)
  assert.equal(out.includes('__exit0'), false)
  assert.equal(out.includes('__exit1'), false)
  assert.deepEqual(snap(home), before)
})

test('--yes: full write, then a second --yes run plans zero actions', async () => {
  const f = fakes()
  await run(['--yes'], f)

  // config
  const config = load()
  assert.deepEqual(Object.keys(config.identities), ['work', 'personal'])
  assert.equal(config.identities.personal!.claude_config_dir, path.join(home, '.claude-personal'))
  // the foreign gateway items were adopted: slots point at barrito-owned copies
  assert.equal(config.identities.work!.keychain.gateway, 'barrito: gateway work')
  assert.equal(config.identities.personal!.keychain.gateway, 'barrito: gateway personal')
  assert.equal(f.items['barrito: gateway work'], 'gw-work-key')
  assert.equal(f.items['barrito: gateway personal'], 'gw-personal-key')
  assert.equal(f.items['Vercel AI Gateway Work'], 'gw-work-key', 'the original item is never touched')
  assert.ok(config.models.include.includes('zai/*'))
  assert.ok(config.models.pin.includes('openai/gpt-6-astra'))
  assert.deepEqual(config.transforms, { rtk: true, caveman: 'lite' })

  // legacy replaced
  assert.ok(fs.readFileSync(path.join(home, '.local', 'shims', 'claude'), 'utf8').includes('generated by barrito'))
  assert.equal(fs.readlinkSync(path.join(home, '.local', 'shims', 'agent')), 'cursor-agent')
  assert.equal(fs.existsSync(path.join(home, '.local', 'shims', '_ai-gateway-env.sh')), false)
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.tybarho.claude-router.plist')), false)
  assert.ok(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'dev.barrito.router.plist')))
  assert.ok(f.calls.some((c) => c.bin === '/bin/launchctl' && c.args[0] === 'bootout' && c.args[1]!.endsWith('com.tybarho.claude-router')))
  assert.equal(fs.existsSync(path.join(home, 'emdash', 'worktrees', 'myos', '.envrc')), false)

  // .envrc files are never edited
  assert.match(fs.readFileSync(path.join(home, 'Code', 'acme', '.envrc'), 'utf8'), /CURSOR_API_KEY/)

  // built-in identities carry empty match globs under --yes: the .envrc cursor keys
  // can't be attributed to an identity, so they stay in the files (interactive init asks for globs)
  assert.deepEqual(config.identities.work!.match, { remotes: [], paths: [] })
  assert.equal(f.items['Cursor Work'], undefined)

  // settings
  const work = settings.read(path.join(home, '.claude'))
  assert.equal(work.env!.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4141')
  assert.equal(work.statusLine!.command, "barrito statusline --append '/usr/local/bin/tsline'")
  const personal = settings.read(path.join(home, '.claude-personal'))
  assert.deepEqual(personal.statusLine, { type: 'command', command: 'barrito statusline' })

  // models synced into both dirs, pinned Astra survived the $5 cap
  const picker = personal.modelPicker!.options.map((o) => o.model)
  assert.ok(picker.includes('claude-code/openai/gpt-6-astra'))
  assert.equal(work.modelPicker!.options.length, picker.length)

  // /barrito command installed into both dirs
  for (const dir of ['.claude', '.claude-personal']) {
    assert.ok(fs.existsSync(path.join(home, dir, 'commands', 'barrito.md')), `${dir} missing /barrito`)
  }

  // backup manifest
  const manifest = path.join(home, '.config', 'barrito', 'backup')
  const ts = fs.readdirSync(manifest).at(-1) ?? ''
  const saved = JSON.parse(readFileSync(path.join(manifest, ts, 'manifest.json'), 'utf8'))
  assert.equal(saved.files.length, 9)
  assert.deepEqual(saved.launchd, ['com.tybarho.claude-router'])

  // idempotent: second run plans zero write actions
  const f2 = fakes()
  f2.io.keychain = f.keychain
  const second = await stdout(() => run(['--yes'], f2))
  assert.match(second, /nothing to write/)
})

test('--yes hides secrets from stdout', async () => {
  const f = fakes()
  const text = await stdout(() => run(['--yes'], f))
  assert.ok(!text.includes('fake-cursor'))
  assert.ok(!text.includes('gw-personal-key'))
  assert.ok(!text.includes('gw-work-key'), 'the adoption copy line never carries the value')
})

test('default io.keychain has set — the cursor-keys step writes through it (typeof only, never invoked)', () => {
  assert.equal(typeof io.keychain.get, 'function')
  assert.equal(typeof io.keychain.set, 'function')
})

test('uninstall: removes the marked PATH block from the shell rc, keeps hand-written lines', async () => {
  const f = fakes()
  // a fresh machine: no hand-written shims PATH line, so init writes its marked block
  const rc = path.join(home, '.zshrc')
  fs.writeFileSync(rc, 'eval "$(starship init zsh)"\nalias g=git\n')
  const prevShell = process.env.SHELL
  process.env.SHELL = '/bin/zsh'
  try {
    await run(['--yes'], f)
    const afterInit = fs.readFileSync(rc, 'utf8')
    assert.ok(afterInit.includes(rcOpen), 'init wrote the marked block')
    assert.ok(afterInit.includes(rcClose))
    assert.ok(afterInit.includes('export PATH="$HOME/.local/shims:$PATH"'))
    assert.ok(afterInit.includes('alias g=git'))

    const out: string[] = []
    await uninstall(['--yes'], {
      config: load(),
      print: (s: string) => { out.push(s) },
      exit: fakeExit(out),
      io: { exec: (bin: string, args: string[]): string => '' },
    })
    const after = fs.readFileSync(rc, 'utf8')
    assert.ok(!after.includes(rcOpen), 'marked block removed')
    assert.ok(!after.includes(rcClose))
    assert.ok(!after.includes('.local/shims'), 'no barrito PATH line left behind')
    assert.ok(after.includes('alias g=git'), 'hand-written lines kept')
    assert.ok(after.includes('starship'))
  } finally {
    process.env.SHELL = prevShell
  }
})

test('uninstall: strips only barrito-owned pieces, unwraps statusline, --restore round-trips', async () => {
  const f = fakes()
  await run(['--yes'], f)

  const calls: Array<{ bin: string; args: string[] }> = []
  const io = {
    exec: (bin: string, args: string[]): string => {
      calls.push({ bin, args })
      return ''
    },
    shell: '/bin/zsh',
  }
  const out: string[] = []
  await uninstall(['--restore', '--yes'], {
    config: load(),
    print: (s: string) => { out.push(s) },
    exit: fakeExit(out),
    io,
  })

  // service out, legacy service back
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'dev.barrito.router.plist')), false)
  assert.ok(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.tybarho.claude-router.plist')))
  assert.ok(calls.some((c) => c.bin === '/bin/launchctl' && c.args[0] === 'bootstrap' && c.args[2]!.endsWith('com.tybarho.claude-router.plist')))

  // generated shims gone, legacy shims restored
  const shim = fs.readFileSync(path.join(home, '.local', 'shims', 'claude'), 'utf8')
  assert.ok(shim.includes('claude shim: per-directory Vercel AI Gateway header'))
  assert.ok(!shim.includes('generated by barrito'))
  assert.ok(fs.existsSync(path.join(home, '.local', 'shims', '_ai-gateway-env.sh')))
  assert.ok(fs.existsSync(path.join(home, 'emdash', 'worktrees', 'api', '.envrc')))

  // statusline unwrapped back to the original, base URL dropped
  const work = settings.read(path.join(home, '.claude'))
  assert.deepEqual(work.statusLine, { type: 'command', command: '/usr/local/bin/tsline' })
  assert.equal(work.env, undefined)
  assert.equal(fs.existsSync(path.join(home, '.claude', 'commands', 'barrito.md')), false)
  // foreign keys kept
  assert.deepEqual(work.permissions, { allow: ['Bash(git:*)'] })

  // barrito-owned keychain copies removed — delete-generic-password, one per owned slot
  const removes = calls.filter((c) => c.bin === '/usr/bin/security' && c.args[0] === 'delete-generic-password')
  assert.deepEqual(removes.map((c) => c.args[c.args.indexOf('-s') + 1]).sort(),
    ['barrito: gateway personal', 'barrito: gateway work'])
})

test('uninstall --restore: config.toml backed up by init comes back, pointing at the pre-adoption names', async () => {
  const f = fakes()
  // a pre-barrito config pointing at foreign items — exactly what adoption rewrites
  save({
    port: 4141,
    default: 'work',
    identities: {
      work: {
        claude_config_dir: path.join(home, '.claude'),
        keychain: { gateway: 'Vercel AI Gateway Work', cursor: 'Cursor Work' },
      },
    },
  })
  await run(['--yes'], f)
  assert.equal(load().identities.work!.keychain.gateway, 'barrito: gateway work')

  const calls: Array<{ bin: string; args: string[] }> = []
  const io = { exec: (bin: string, args: string[]): string => { calls.push({ bin, args }); return '' }, shell: '/bin/zsh' }
  const out: string[] = []
  await uninstall(['--restore', '--yes'], {
    config: load(),
    print: (s: string) => { out.push(s) },
    exit: fakeExit(out),
    io,
  })
  assert.equal(load().identities.work!.keychain.gateway, 'Vercel AI Gateway Work')
  assert.ok(calls.some((c) => c.bin === '/usr/bin/security' && c.args.includes('barrito: gateway work') && c.args[0] === 'delete-generic-password'))
})

// ── linux + the shell rc PATH line ────────────────────────────────────────────

test('linux --dry-run --yes: no launchd actions, systemd service, env: refs when keyring unavailable', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const f = fakes()
  f.io.shell = '/bin/bash'
  f.io.keyring = () => false
  let out: string[] = []
  const text = await stdout(async () => {
    out = await run(['--dry-run', '--yes'], f)
  })
  const planText = out.join('\n')

  // no macOS-only legacy actions; the service step is systemd
  assert.doesNotMatch(planText, /launchd/)
  assert.doesNotMatch(planText, /boot out and remove/)
  assert.match(planText, /install barrito \(systemd, :4141\)/)

  // fresh machine: the rc PATH line is planned, in the detected shell's rc
  assert.match(planText, /add ~\/\.local\/shims to PATH in ~\/\.bashrc/)

  // keyring unavailable → env: refs offered, with the why
  assert.match(text, /no keyring available/)
  assert.match(text, /gateway  env:AI_GATEWAY_API_KEY_WORK  ✗/)
  assert.match(text, /gateway  env:AI_GATEWAY_API_KEY  ✗/)
  assert.match(text, /export AI_GATEWAY_API_KEY_WORK=<vercel ai gateway key>/)
  assert.match(text, /dry run — nothing written/)
})

test('linux --yes: env: refs in config, service via the systemd default dir (never ~/Library/LaunchAgents)', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  fs.rmSync(path.join(home, '.zshrc')) // fresh machine: no PATH line anywhere yet
  const f = fakes()
  const installs: Array<{ dir?: string; port?: number }> = []
  f.io.shell = '/bin/zsh'
  f.io.keyring = () => false
  f.io.service = {
    removeLegacy: () => {},
    install: async (opts) => { installs.push({ dir: opts.dir, port: opts.port }); return '' },
  }
  await run(['--yes'], f)

  const config = load()
  assert.equal(config.identities.work?.keychain.gateway, 'env:AI_GATEWAY_API_KEY_WORK')
  assert.equal(config.identities.work?.keychain.cursor, 'env:CURSOR_API_KEY_WORK')
  assert.equal(config.identities.personal?.keychain.gateway, 'env:AI_GATEWAY_API_KEY')
  assert.equal(config.identities.personal?.keychain.cursor, 'env:CURSOR_API_KEY')

  // env: refs can't receive the .envrc cursor keys — the file keeps its export line
  assert.match(fs.readFileSync(path.join(home, 'Code', 'acme', '.envrc'), 'utf8'), /CURSOR_API_KEY/)
  // the rc PATH line landed in ~/.zshrc
  assert.match(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), /# >>> barrito >>>/)

  assert.equal(installs.length, 1)
  assert.equal(installs[0]?.dir, undefined)
  assert.equal(installs[0]?.port, 4141)
})

test('linux --yes with a working keyring keeps keychain names', async () => {
  process.env.BARRITO_PLATFORM = 'linux'
  const f = fakes()
  f.io.shell = '/bin/zsh'
  f.io.keyring = () => true
  f.io.service = { removeLegacy: () => {}, install: async () => '' }
  await run(['--yes'], f)
  assert.equal(load().identities.work?.keychain.gateway, 'Vercel AI Gateway Work')
  assert.equal(load().identities.work?.keychain.cursor, 'Cursor Work')
})

test('darwin --dry-run on a fresh machine plans the rc PATH line for the detected shell', async () => {
  fs.rmSync(path.join(home, '.zshrc'))
  const f = fakes()
  f.io.shell = '/bin/zsh'
  const out = await run(['--dry-run', '--yes'], f)
  assert.match(out.join('\n'), /add ~\/\.local\/shims to PATH in ~\/\.zshrc/)
})

// ── any number of identities ──────────────────────────────────────────────────

test('interactive: a third identity via scripted prompts lands in config with its own claude dir', async () => {
  const f = fakes()
  // the custom identity's cursor item already holds a key — the wizard must probe it,
  // or the cursor-keys migrate action re-plans on every init run
  f.items['Cursor SIDE'] = 'already-in-keychain'
  const prompts = script([
    [/back up .* and replace\?/, true],
    [/When Max runs out/, 'cheap'],
    [/Compress tool output with rtk\?/, true],               // token savers
    [/How terse should replies be\? \(caveman\)/, 'ultra'],
    [/remotes glob/, 'github.com/work/*'],                  // work — the prompt's default
    [/paths glob/, '~/Code/work/**'],
    [/remotes glob/, 'github.com/you/*'],                   // personal
    [/paths glob/, '~/Code/you/**'],
    [/Add another identity\?/, true],
    [/identity name/, 'side'],
    [/remotes glob/, 'github.com/side/*'],
    [/paths glob/, '~/Code/acme/**'],                       // matches the fixture Code/acme/.envrc
    [/claude config dir/, '~/.claude-side'],
    [/gateway secret/, 'Vercel AI Gateway SIDE'],
    [/cursor secret/, 'Cursor SIDE'],
    [/Add another identity\?/, false],
    [/default identity\?/, 'side'],
    [/logged in\? \(re-checks\)/, false],                     // personal — .claude (work) is logged in
    [/share rules\/skills\/agents/, true],                   // personal
    [/copy .* personal project histories/, true],            // personal
    [/logged in\? \(re-checks\)/, false],                     // side — its dir is brand new
    [/write it\?/, true],
  ])
  const plan = await run([], f, { ...f.io, prompts })
  // side's already-populated "Cursor SIDE" is adopted (copied, never moved into); the
  // personal .envrc key moves into a barrito-owned item, created owned from birth
  assert.match(plan.join('\n'), /\+ copy 3 keychain keys into barrito-owned items \(one macOS prompt each\)/)
  assert.match(plan.join('\n'), /move CURSOR_API_KEY into Keychain \("barrito: cursor personal"\)/)
  assert.ok(!plan.join('\n').includes('move CURSOR_API_KEY into Keychain ("barrito: cursor side")'),
    'no cursor-keys move planned for the already-populated custom item (it is adopted, not overwritten)')

  const config = load()
  assert.deepEqual(Object.keys(config.identities), ['work', 'personal', 'side'])
  assert.equal(config.default, 'side')
  assert.deepEqual(config.transforms, { rtk: true, caveman: 'ultra' })
  const work = config.identities.work!
  assert.deepEqual(work.match, { remotes: ['github.com/work/*'], paths: [path.join(home, 'Code', 'work', '**')] })
  assert.deepEqual(config.identities.personal!.match, { remotes: ['github.com/you/*'], paths: [path.join(home, 'Code', 'you', '**')] })
  const side = config.identities.side!
  assert.equal(side.claude_config_dir, path.join(home, '.claude-side'))
  assert.deepEqual(side.match.remotes, ['github.com/side/*'])
  assert.deepEqual(side.match.paths, [path.join(home, 'Code', 'acme', '**')])
  assert.equal(side.keychain.gateway, 'Vercel AI Gateway SIDE')
  assert.equal(side.keychain.cursor, 'barrito: cursor side', 'the existing foreign cursor item was adopted')
  assert.deepEqual(side.fallback, ['zai/glm-5.3', 'deepseek/deepseek-v4.1-flash'])
  assert.ok(fs.existsSync(path.join(home, '.claude-side')), 'side got its own claude dir')
  assert.equal(f.items['barrito: cursor personal'], 'fake-cursor-personal-99aa88')
  assert.equal(f.items['barrito: cursor side'], 'already-in-keychain', 'the owned copy holds the adopted value')
  assert.equal(f.items['Cursor SIDE'], 'already-in-keychain', 'the original item is never touched')
  assert.equal(config.identities.work?.keychain.gateway, 'barrito: gateway work')
  assert.equal(config.identities.personal?.keychain.gateway, 'barrito: gateway personal')

  // detect lists every configured dir — config-driven, not a hardcoded pair
  const found = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  assert.deepEqual(
    [...new Set(found.claudeDirs.map((d) => d.dir))].sort(),
    [path.join(home, '.claude'), path.join(home, '.claude-personal'), path.join(home, '.claude-side')].sort(),
  )
  assert.equal(found.claudeDirs.find((d) => d.dir === path.join(home, '.claude'))?.loggedIn, true)
  assert.equal(found.keychain['barrito: cursor side'], true, 'detect probes the config identities\' keyring names')
  // the login step never spawns claude — it prints the command for the user to run elsewhere
  assert.ok(!f.calls.some((c) => c.spawn), 'nothing is ever spawned')

  // re-run with the existing 3-identity config plans zero writes — and zero cursor-keys moves
  const f2 = fakes()
  f2.io.keychain = f.keychain
  let replan: string[] = []
  const second = await stdout(async () => {
    replan = await run(['--yes'], f2)
  })
  assert.match(second, /nothing to write/)
  assert.ok(!replan.join('\n').includes('move CURSOR_API_KEY'), 're-plan has zero cursor-keys actions')
})

// ── the login step ─────────────────────────────────────────────────────────────

test('login step: --yes prints the command, never spawns claude', async () => {
  const f = fakes()
  const text = await stdout(() => run(['--yes'], f))
  // personal is not logged in in the fixture: init points at the command instead of taking over
  assert.match(text, /CLAUDE_CONFIG_DIR=~\/\.claude-personal claude/)
  assert.match(text, /\/login/)
  assert.match(text, /private browser window/)
  assert.ok(!f.calls.some((c) => c.spawn && c.bin === 'claude'), 'claude is never spawned')
})

test('login step: "logged in? (re-checks)" re-runs the injected account check, up to 3 times', async () => {
  const f = fakes()
  const checked: string[] = []
  f.io.account = (dir: string): { loggedIn: boolean; email: string | null } => {
    checked.push(dir)
    // the first re-check misses, the second lands — proving init re-checks rather than trusting the confirm
    return { loggedIn: checked.length > 1, email: 'me@x.test' }
  }
  const prompts = script([
    [/back up .* and replace\?/, true],
    [/When Max runs out/, 'cheap'],
    [/Compress tool output with rtk\?/, true],
    [/How terse should replies be\? \(caveman\)/, 'lite'],
    [/remotes glob/, 'github.com/work/*'],
    [/paths glob/, '~/Code/work/**'],
    [/remotes glob/, 'github.com/you/*'],
    [/paths glob/, '~/Code/you/**'],
    [/Add another identity\?/, false],
    [/default identity\?/, 'work'],
    [/logged in\? \(re-checks\)/, true],
    [/logged in\? \(re-checks\)/, true],
    [/share rules\/skills\/agents/, true],
    [/copy .* personal project histories/, true],
    [/write it\?/, true],
  ])
  const text = await stdout(async () => { await run([], f, { ...f.io, prompts }) })
  assert.match(text, /CLAUDE_CONFIG_DIR=~\/\.claude-personal claude/)
  assert.match(text, /still not logged in/)
  assert.match(text, /✓ logged in \(me@x\.test\)/)
  assert.ok(!f.calls.some((c) => c.spawn && c.bin === 'claude'), 'claude is never spawned')
  // "When Max runs out" is the select's message alone — the old p.log.step duplicate is gone
  // (the select itself is the scripted prompt, which matched the message exactly once)
  assert.ok(!text.includes('When Max runs out'), 'no step heading printed before the select')
})

test('login step: three failed re-checks continue with the doctor note', async () => {
  const f = fakes()
  const prompts = script([
    [/back up .* and replace\?/, true],
    [/When Max runs out/, 'cheap'],
    [/Compress tool output with rtk\?/, true],
    [/How terse should replies be\? \(caveman\)/, 'lite'],
    [/remotes glob/, 'github.com/work/*'],
    [/paths glob/, '~/Code/work/**'],
    [/remotes glob/, 'github.com/you/*'],
    [/paths glob/, '~/Code/you/**'],
    [/Add another identity\?/, false],
    [/default identity\?/, 'work'],
    [/logged in\? \(re-checks\)/, true],
    [/logged in\? \(re-checks\)/, true],
    [/logged in\? \(re-checks\)/, true],
    [/share rules\/skills\/agents/, true],
    [/copy .* personal project histories/, true],
    [/write it\?/, true],
  ])
  const text = await stdout(async () => { await run([], f, { ...f.io, prompts }) })
  assert.match(text, /continuing — barrito doctor will flag the login/)
})

test('io.exec pipes child stdio — the launchctl probe never leaks "Bad request." to the terminal', () => {
  const chunks: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((s: unknown) => { chunks.push(String(s)); return true }) as typeof process.stderr.write
  try {
    assert.equal(io.exec('/bin/sh', ['-c', 'echo chatter >&2; echo out']), 'out\n')
  } finally {
    process.stderr.write = write
  }
  assert.equal(chunks.join(''), '', 'child stderr was inherited')
})

// ── token savers (transforms) step ───────────────────────────────────────────

test('--yes takes the token-saver defaults; a second --yes run keeps them and plans zero actions', async () => {
  const f = fakes()
  await run(['--yes'], f)
  assert.deepEqual(load().transforms, { rtk: true, caveman: 'lite' })
})

test('interactive: an existing [transforms] table wins — the step is skipped', async () => {
  const f = fakes()
  save({
    port: 4141,
    default: 'work',
    identities: {
      work: {
        claude_config_dir: path.join(home, '.claude'),
        keychain: { gateway: 'Vercel AI Gateway Work', cursor: 'Cursor Work' },
      },
    },
    transforms: { rtk: false, caveman: 'ultra' },
  })
  // no rtk/caveman answers queued — the strict script fails if the step prompts anyway
  const prompts = script([
    [/back up .* and replace\?/, true],
    [/When Max runs out/, 'cheap'],
    [/Add another identity\?/, false],
    [/write it\?/, true],
  ])
  const text = await stdout(async () => { await run([], f, { ...f.io, prompts }) })
  assert.ok(!text.includes('Token savers'), 'the token-savers step never ran')
  assert.deepEqual(load().transforms, { rtk: false, caveman: 'ultra' })
})

test('a config missing [transforms] gets it written even when nothing else changed', async () => {
  const f = fakes()
  await run(['--yes'], f)
  const cfgPath = path.join(home, '.config', 'barrito', 'config.toml')
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(/\n?\[transforms\]\n[^[]*/, ''))
  const f2 = fakes()
  f2.io.keychain = f.keychain
  let out: string[] = []
  await stdout(async () => { out = await run(['--yes'], f2) })
  assert.match(out.join('\n'), /write ~\/\.config\/barrito\/config\.toml/)
  assert.deepEqual(load().transforms, { rtk: true, caveman: 'lite' })
})

test('a config with per-identity [transforms] keeps them through init (values win)', async () => {
  const f = fakes()
  save({
    port: 4141,
    default: 'work',
    identities: {
      work: {
        claude_config_dir: path.join(home, '.claude'),
        keychain: { gateway: 'Vercel AI Gateway Work', cursor: 'Cursor Work' },
        transforms: { caveman: 'full' },
      },
    },
    transforms: { rtk: false, caveman: 'ultra' },
  })
  await run(['--yes'], f)
  const config = load()
  assert.deepEqual(config.transforms, { rtk: false, caveman: 'ultra' })
  assert.deepEqual(config.identities.work!.transforms, { caveman: 'full' })
})

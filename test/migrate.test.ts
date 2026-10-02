import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fakeSecurity, parseSecurityI } from './fixtures/security.ts'
import { copy, env, snap } from './fixtures/home/_copy.ts'
import { detect } from '../src/detect.ts'
import type { Detected } from '../src/detect.ts'
import { load } from '../src/config.ts'
import { create as createBackup } from '../src/backup.ts'
import { plan, apply, seed, wrapStatusline, unwrapStatusline, stripRcBlock } from '../src/migrate.ts'
import type { Action, Answers } from '../src/migrate.ts'
import * as idx from '../src/keychain/index.ts'
import { viaNpx } from '../src/cli/init.ts'
import * as settings from '../src/settings.ts'
import * as models from '../src/models.ts'
import type { Config } from '../src/types.ts'

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url)), 'utf8')).data

const KEYS = ['BARRITO_HOME', 'BARRITO_CONFIG', 'BARRITO_STATE', 'BARRITO_LOG', 'BARRITO_SHIMS', 'BARRITO_PLATFORM']
let prev: Record<string, string | undefined>, home: string

beforeEach(() => {
  prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  home = env(copy())
  process.env.BARRITO_PLATFORM = 'darwin' // these suites assert launchd behavior; linux branches get their own tests
})

afterEach(() => {
  KEYS.forEach((k) => {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  })
  fs.rmSync(home, { recursive: true, force: true })
})

const fakes = () => {
  const calls: Array<{ bin: string; args: string[] }> = []
  const items: Record<string, string> = { 'Vercel AI Gateway': 'gw-personal-key', 'Vercel AI Gateway Work': 'gw-work-key' }
  return {
    calls,
    exec: (bin: string, args: string[]): string => {
      calls.push({ bin, args })
      if (args[0] === 'print') throw new Error('not loaded')
      if (args[0] === '--version') return 'fake 1.0.0'
      return ''
    },
    keychain: {
      items,
      get: (s: string): string | null => items[s] ?? null,
      set: (s: string, v: string): void => { items[s] = v },
    },
  }
}

const next = (): Config => ({
  port: 4141,
  default: 'personal',
  identities: {
    work: {
      id: 'work',
      claude_config_dir: path.join(home, '.claude'),
      share_from: null,
      fallback: ['zai/glm-5.3', 'deepseek/deepseek-v4.1-flash'],
      match: { remotes: ['github.com/acme/*'], paths: [path.join(home, 'Code', 'acme', '**')] },
      keychain: { gateway: 'Vercel AI Gateway Work', cursor: 'Cursor Work' },
    },
    personal: {
      id: 'personal',
      claude_config_dir: path.join(home, '.claude-personal'),
      share_from: path.join(home, '.claude'),
      fallback: ['zai/glm-5.3', 'deepseek/deepseek-v4.1-flash'],
      match: { remotes: ['github.com/you/*'], paths: [path.join(home, 'Code', 'you', '**')] },
      keychain: { gateway: 'Vercel AI Gateway', cursor: 'Cursor' },
    },
  },
  models: load().models,
  graft: { roots: [path.join(home, 'Code')], repos: [] },
  harness: {},
  transforms: { rtk: true, caveman: 'lite' },
})

const answers = (config: Config, detected: Detected, extra: Partial<Answers> = {}): Answers => ({
  config,
  existing: load(),
  replace: true,
  share: true,
  histories: true,
  ts: '2026-10-01T2030',
  bin: '/usr/local/bin/barrito',
  catalog,
  ...extra,
})

const at = <K extends Action['kind']>(a: Action | undefined, k: K): Extract<Action, { kind: K }> =>
  a as Extract<Action, { kind: K }>

test('plan is pure: no writes, stable order', () => {
  const f = fakes()
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  const before = snap(home)
  const actions = plan(detected, answers(next(), detected))
  assert.deepEqual(snap(home), before)

  assert.deepEqual(actions.map((a) => a.kind), [
    'backup', 'bootout', 'shims', 'envrc', 'keychain-own', 'cursor-keys', 'dir', 'share', 'histories',
    'settings', 'opencode', 'config', 'note', 'models', 'service',
  ])
  assert.deepEqual(at(actions[0], 'backup').files.length, 9)
  assert.deepEqual(at(actions[2], 'shims').names.sort(), ['claude', 'codex', 'cursor-agent', 'opencode'])
  assert.deepEqual(at(actions[2], 'shims').remove.map((f) => path.basename(f)), ['_ai-gateway-env.sh'])
  assert.deepEqual(at(actions[3], 'envrc').links.length, 3)
  // histories: resolved per project like the router — Code/you/dotfiles → personal by path glob
  const hist = at(actions.find((a) => a.kind === 'histories'), 'histories')
  assert.equal(hist.description, 'copy 1 project history to personal (resolved by path)')
  assert.deepEqual(hist.moves.map((m) => [m.from, m.to, m.how]), [['work', 'personal', 'path']])
  // the foreign gateway items exist in the fakes → adopted, slots rewritten to barrito-owned names
  assert.deepEqual(at(actions[4], 'keychain-own').copies, [
    { id: 'work', slot: 'gateway', from: 'Vercel AI Gateway Work', to: 'barrito: gateway work' },
    { id: 'personal', slot: 'gateway', from: 'Vercel AI Gateway', to: 'barrito: gateway personal' },
  ])
  assert.match(at(actions[4], 'keychain-own').description, /copy 2 keychain keys into barrito-owned items \(one macOS prompt each\)/)
  // the missing cursor items are created by the moves — barrito-owned from birth
  assert.deepEqual(at(actions[5], 'cursor-keys').moves, [
    { file: path.join(home, 'Code', 'acme', '.envrc'), service: 'barrito: cursor work' },
    { file: path.join(home, 'Code', 'you', '.envrc'), service: 'barrito: cursor personal' },
  ])
  const cfgAction = at(actions.find((a) => a.kind === 'config'), 'config')
  assert.equal(cfgAction.config.identities.work?.keychain.gateway, 'barrito: gateway work')
  assert.equal(cfgAction.config.identities.work?.keychain.cursor, 'barrito: cursor work')
  assert.equal(cfgAction.config.identities.personal?.keychain.gateway, 'barrito: gateway personal')
})

test('seed pins every live picker row (incl. $10 Astra), reports retired', () => {
  const rows = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).modelPicker.options
  const { rules, retired } = seed(load().models, rows, catalog)
  assert.deepEqual(retired, ['openai/gpt-5.6-luna'])
  assert.equal(rules.pin.length, 11)
  assert.ok(rules.pin.includes('openai/gpt-6-astra'))
  assert.ok(!rules.pin.includes('openai/gpt-5.6-luna'))
  assert.deepEqual(rules.include, ['anthropic/*', 'deepseek/*', 'google/*', 'meta/*', 'openai/*', 'stepfun/*', 'zai/*'])
  assert.equal(rules.max_input_price, 5)
  assert.deepEqual(rules.suffix, Object.fromEntries(
    ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-fable-5.1',
      'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash-0731', 'zai/glm-5.3',
      'zai/glm-5.3-flash', 'meta/muse-spark-1.3-contributor', 'google/gemini-3.8-flash'].map((id) => [id, '[1m]'])
  ))
  // untouched rules on a re-run → no re-seed, no pin churn
  const again = seed(rules, rows, catalog)
  assert.equal(again.changed, false)
  assert.deepEqual(again.rules, rules)
})

test('seeded rows then models.sync reproduce today\'s picker ids exactly (minus retired)', async () => {
  const rows = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).modelPicker.options as Array<{ model: string }>
  const { rules } = seed(load().models, rows, catalog)
  const dir = fs.mkdtempSync(path.join(home, '.claude', 'x'))
  const config = { identities: { work: { claude_config_dir: dir } }, models: rules }
  const result = await models.sync({ config, catalog, settings, fs })
  const got = settings.read(dir).modelPicker!.options.map((o) => o.model)
  const want = rows.map((r) => r.model).filter((m) => m !== 'claude-code/openai/gpt-5.6-luna')
  assert.deepEqual(got.filter((m) => want.includes(m)).sort(), [...want].sort())
  want.forEach((m) => assert.ok(got.includes(m), `${m} missing from synced picker`))
})

test('statusline wrap and unwrap round-trip', () => {
  assert.deepEqual(wrapStatusline(null), { type: 'command', command: 'barrito statusline' })
  const wrapped = wrapStatusline('/usr/local/bin/tsline')
  assert.deepEqual(wrapped, { type: 'command', command: "barrito statusline --append '/usr/local/bin/tsline'" })
  assert.equal(unwrapStatusline(wrapped.command), '/usr/local/bin/tsline')
  assert.deepEqual(wrapStatusline(wrapped.command), wrapped)
  assert.equal(unwrapStatusline('barrito statusline'), null)
  assert.equal(unwrapStatusline('/usr/local/bin/tsline'), null)
})

test('apply: cursor keys land in keychain, never in stdout; statusline wraps; shims regenerate', async () => {
  const f = fakes()
  const out: string[] = []
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  const config = next()
  const actions = plan(detected, answers(config, detected))
  await apply(actions, {
    backup: createBackup({ ts: '2026-10-01T2030' }),
    exec: f.exec,
    fs,
    keychain: f.keychain,
    config,
    catalog,
    print: (s) => out.push(s),
    node: process.execPath,
    pathEnv: '/usr/bin:/bin',
    sleep: async () => {},
  })

  assert.equal(f.keychain.items['barrito: cursor work'], 'fake-cursor-work-a1b2c3')
  assert.equal(f.keychain.items['barrito: cursor personal'], 'fake-cursor-personal-99aa88')
  // the foreign gateway items were adopted: read once each, copied, originals untouched
  assert.equal(f.keychain.items['barrito: gateway work'], 'gw-work-key')
  assert.equal(f.keychain.items['barrito: gateway personal'], 'gw-personal-key')
  assert.equal(f.keychain.items['Vercel AI Gateway Work'], 'gw-work-key')
  assert.ok(!out.join('\n').includes('fake-cursor'))
  assert.ok(!out.join('\n').includes('gw-work-key'), 'secret values never print')

  const work = settings.read(path.join(home, '.claude'))
  assert.equal(work.env!.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4141')
  assert.equal(work.statusLine!.command, "barrito statusline --append '/usr/local/bin/tsline'")

  assert.ok(fs.readFileSync(path.join(home, '.local', 'shims', 'claude'), 'utf8').includes('generated by barrito'))
  assert.equal(fs.lstatSync(path.join(home, '.local', 'shims', 'agent')).isSymbolicLink(), true)
  assert.equal(fs.existsSync(path.join(home, '.local', 'shims', '_ai-gateway-env.sh')), false)
  assert.equal(fs.existsSync(path.join(home, 'emdash', 'worktrees', 'api', '.envrc')), false)
  assert.ok(fs.readFileSync(path.join(home, 'Code', 'acme', '.envrc'), 'utf8').includes('fake-cursor-work'))

  assert.equal(fs.lstatSync(path.join(home, '.claude-personal', 'skills')).isSymbolicLink(), true)
  assert.ok(fs.existsSync(path.join(home, '.claude-personal', 'projects')))
})

test('apply keychain-own: reads each foreign item once, writes the owned copy with -T + stdin; config slots rewritten; originals never deleted', async () => {
  const { calls, exec } = fakeSecurity({ 'Vercel AI Gateway Work': 'gw-work-key' })
  const keychain = {
    get: (s: string): string | null => idx.get(s, { exec }),
    set: (s: string, v: string): void => idx.set(s, v, { exec }),
  }
  const out: string[] = []
  const config = next()
  const actions: Action[] = [{
    kind: 'keychain-own',
    description: '',
    copies: [{ id: 'work', slot: 'gateway', from: 'Vercel AI Gateway Work', to: 'barrito: gateway work' }],
  }, { kind: 'config', description: '', config }]
  await apply(actions, { fs, keychain, config, print: (s) => out.push(s) })

  // one value read, the owned target probed for an old value to back up (none), then the
  // owned copy via `security -i` (-T /usr/bin/security, value on stdin), then read back
  assert.deepEqual(calls.map((c) => c.args), [
    ['find-generic-password', '-s', 'Vercel AI Gateway Work', '-w'],
    ['find-generic-password', '-s', 'barrito: gateway work', '-w'],
    ['-i'],
    ['find-generic-password', '-s', 'barrito: gateway work', '-w'],
  ])
  assert.deepEqual(parseSecurityI(calls[2]?.input ?? ''), { service: 'barrito: gateway work', account: 'barrito', value: 'gw-work-key', trusted: true })
  assert.equal(calls.some((c) => c.args.includes('gw-work-key')), false, 'value never rides argv')
  assert.equal(calls.some((c) => c.args[0] === 'delete-generic-password'), false, 'originals are never deleted')
  assert.equal(config.identities.work?.keychain.gateway, 'barrito: gateway work')
  assert.match(out.join('\n'), /✓ "Vercel AI Gateway Work" → "barrito: gateway work" — the original is never touched/)
  assert.ok(!out.join('\n').includes('gw-work-key'), 'the value never prints')
})

test('apply keychain-own: a denied read reverts the slot so the config keeps pointing at the original', async () => {
  const exec = (): string => {
    throw new Error('security: SecKeychainItemCopyAttributesAndData: User canceled the operation.')
  }
  const keychain = {
    get: (s: string): string | null => idx.get(s, { exec }),
    set: (s: string, v: string): void => idx.set(s, v, { exec }),
  }
  const out: string[] = []
  const config = next()
  const actions: Action[] = [{
    kind: 'keychain-own',
    description: '',
    copies: [{ id: 'work', slot: 'gateway', from: 'Vercel AI Gateway Work', to: 'barrito: gateway work' }],
  }, { kind: 'config', description: '', config }]
  await apply(actions, { fs, keychain, config, print: (s) => out.push(s) })
  assert.equal(config.identities.work?.keychain.gateway, 'Vercel AI Gateway Work')
  assert.match(out.join('\n'), /! "Vercel AI Gateway Work" unreadable/)
})

test('apply models: prints the synced dir paths, never [object Object]', async () => {
  const f = fakes()
  const out: string[] = []
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  const config = next()
  await apply(plan(detected, answers(config, detected)), {
    backup: createBackup({ ts: '2026-10-01T2030' }),
    exec: f.exec,
    fs,
    keychain: f.keychain,
    config,
    catalog,
    print: (s) => out.push(s),
    node: process.execPath,
    pathEnv: '/usr/bin:/bin',
    sleep: async () => {},
  })
  assert.match(out.join('\n'), /picker \+ agents → ~\/\.claude, ~\/\.claude-personal/)
  assert.ok(!out.join('\n').includes('[object Object]'))
})

test('apply then re-plan → zero actions (idempotent)', async () => {
  const f = fakes()
  const out: string[] = []
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  const config = next()
  await apply(plan(detected, answers(config, detected)), {
    backup: createBackup({ ts: '2026-10-01T2030' }),
    exec: f.exec,
    fs,
    keychain: f.keychain,
    config,
    catalog,
    print: (s) => out.push(s),
    node: process.execPath,
    pathEnv: '/usr/bin:/bin',
    sleep: async () => {},
  })

  const again = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  const actions = plan(again, answers(load(), again))
  assert.deepEqual(actions, [])
})

test('replace: false keeps the legacy setup untouched', () => {
  const f = fakes()
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  const actions = plan(detected, answers(next(), detected, { replace: false }))
  assert.deepEqual(actions.map((a) => a.kind).filter((k) => ['backup', 'bootout', 'shims', 'envrc'].includes(k)), [])
})

test('canon: a transforms-only diff plans one config write — global, per-identity and absent alike', () => {
  const f = fakes()
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  // models pre-seeded from the fixture's picker rows, so seed() is a no-op and only the
  // transforms fields differ between config and existing
  const rows = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).modelPicker.options
  const base = next()
  base.models = seed(load().models, rows, catalog).rules
  const configs = (actions: Action[]): number => actions.filter((a) => a.kind === 'config').length

  // identical transforms on both sides → no config action from canon
  assert.equal(configs(plan(detected, answers(base, detected, { existing: base }))), 0)

  // global [transforms] changed / absent on disk → one config action
  const changed: Config = { ...base, transforms: { rtk: false, caveman: 'ultra' } }
  assert.equal(configs(plan(detected, answers(changed, detected, { existing: base }))), 1)
  const missing: Config = { ...base, transforms: undefined }
  assert.equal(configs(plan(detected, answers(base, detected, { existing: missing }))), 1)

  // per-identity transforms changed → one config action
  const withPer: Config = {
    ...base,
    identities: { ...base.identities, work: { ...base.identities.work!, transforms: { caveman: 'full' } } },
  }
  assert.equal(configs(plan(detected, answers(withPer, detected, { existing: base }))), 1)
})

test('viaNpx: _npx script path or npx user agent', () => {
  assert.equal(viaNpx('/Users/x/.npm/_npx/abc/node_modules/.bin/barrito'), true)
  assert.equal(viaNpx('/usr/local/bin/barrito', { npm_config_user_agent: 'npm/11.0.0' }), false)
  assert.equal(viaNpx('/usr/local/bin/barrito', { npm_config_user_agent: 'npm/11.0.0 node/v22 npx/11.0.0' }), true)
})

// ── path-rc: the shell rc PATH line, every platform ───────────────────────────

const see = (detected: Detected, extra: Partial<Answers> = {}): Action[] =>
  plan(detected, answers(next(), detected, extra))

test('path-rc: fresh zsh rc gets the marked block, backed up first; re-plan plans nothing', async () => {
  const f = fakes()
  fs.writeFileSync(path.join(home, '.zshrc'), 'export EDITOR=vim\n')
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  assert.equal(detected.rc.present, false)

  const actions = see(detected)
  const rc = at(actions.find((a) => a.kind === 'path-rc'), 'path-rc')
  assert.equal(rc.file, path.join(home, '.zshrc'))
  assert.deepEqual(rc.lines, ['export PATH="$HOME/.local/shims:$PATH"'])
  assert.match(rc.description, /add ~\/\.local\/shims to PATH in ~\/\.zshrc/)

  const backup = createBackup({ ts: '2026-10-01T2030' })
  await apply([rc], { backup, fs, keychain: f.keychain })
  assert.equal(
    fs.readFileSync(path.join(home, '.zshrc'), 'utf8'),
    'export EDITOR=vim\n# >>> barrito >>>\nexport PATH="$HOME/.local/shims:$PATH"\n# <<< barrito <<<\n',
  )
  assert.deepEqual(backup.manifest.files.map((e) => e.original), [path.join(home, '.zshrc')])

  const again = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  assert.equal(again.rc.present, true)
  assert.equal(see(again).some((a) => a.kind === 'path-rc'), false)
})

test('path-rc: bash→~/.bashrc (linux), ~/.bash_profile (darwin); fish→conf.d/barrito.fish', async () => {
  const f = fakes()
  const cases: Array<[string, 'darwin' | 'linux', string, string]> = [
    ['/bin/bash', 'linux', path.join(home, '.bashrc'), 'export PATH="$HOME/.local/shims:$PATH"'],
    ['/bin/bash', 'darwin', path.join(home, '.bash_profile'), 'export PATH="$HOME/.local/shims:$PATH"'],
    ['/usr/bin/fish', 'linux', path.join(home, '.config', 'fish', 'conf.d', 'barrito.fish'), 'fish_add_path -p ~/.local/shims'],
  ]
  for (const [shell, pf, file, line] of cases) {
    process.env.BARRITO_PLATFORM = pf
    const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell })
    const rc = at(see(detected).find((a) => a.kind === 'path-rc'), 'path-rc')
    assert.equal(rc.file, file)
    assert.deepEqual(rc.lines, [line])
    await apply([rc], { fs, keychain: f.keychain })
    assert.equal(fs.readFileSync(file, 'utf8'), `# >>> barrito >>>\n${line}\n# <<< barrito <<<\n`)
    fs.rmSync(file, { force: true })
  }
})

test('path-rc: an existing unmarked equivalent line plans nothing (the fixture ~/.zshrc ships one)', () => {
  const f = fakes()
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  assert.equal(detected.rc.file, path.join(home, '.zshrc'))
  assert.equal(detected.rc.present, true)
  assert.equal(see(detected).some((a) => a.kind === 'path-rc'), false)
})

test('path-rc: an appended (not prepended) shims line is not equivalent', () => {
  const f = fakes()
  fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH="$PATH:$HOME/.local/shims"\n')
  const detected = detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell: '/bin/zsh' })
  assert.equal(detected.rc.present, false)
})

test('stripRcBlock: removes only the marked block (uninstall)', () => {
  const file = path.join(home, '.zshrc')
  fs.writeFileSync(file, 'export EDITOR=vim\n# >>> barrito >>>\nexport PATH="$HOME/.local/shims:$PATH"\n# <<< barrito <<<\nalias g=git\n')
  assert.equal(stripRcBlock(file), true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'export EDITOR=vim\nalias g=git\n')
  assert.equal(stripRcBlock(file), false) // idempotent, and the hand lines survive
  assert.equal(fs.readFileSync(file, 'utf8'), 'export EDITOR=vim\nalias g=git\n')
  assert.equal(stripRcBlock(path.join(home, '.nope')), false)
})

test('stripRcBlock: missing close marker removes only the marker + exact barrito line, keeps later user lines, warns, side-backs-up', () => {
  const file = path.join(home, '.zshrc')
  fs.writeFileSync(file, 'export EDITOR=vim\n# >>> barrito >>>\nexport PATH="$HOME/.local/shims:$PATH"\nalias g=git\nalias c=clear\n')
  const out: string[] = []
  assert.equal(stripRcBlock(file, fs, (s) => out.push(s)), true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'export EDITOR=vim\nalias g=git\nalias c=clear\n')
  assert.match(out.join('\n'), /missing its end marker/)

  // a plain copy landed beside the rc (no init backup manifest covers it)
  const bak = fs.readdirSync(home).find((n) => n.startsWith('.zshrc.barrito-bak-'))
  assert.ok(bak)
  assert.match(fs.readFileSync(path.join(home, bak ?? ''), 'utf8'), /alias c=clear/)
})

test('stripRcBlock: missing close marker with a foreign line under it loses only the marker line', () => {
  const file = path.join(home, '.zshrc')
  fs.writeFileSync(file, 'export EDITOR=vim\n# >>> barrito >>>\nexport PATH="$HOME/.local/bin:$PATH"\nalias g=git\n')
  assert.equal(stripRcBlock(file, fs, () => {}), true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'export EDITOR=vim\nexport PATH="$HOME/.local/bin:$PATH"\nalias g=git\n')
})

test('stripRcBlock: an init backup manifest covering the rc means no side backup', () => {
  const file = path.join(home, '.bashrc')
  fs.writeFileSync(file, 'export EDITOR=vim\n# >>> barrito >>>\nexport PATH="$HOME/.local/shims:$PATH"\n# <<< barrito <<<\n')
  const backup = createBackup({ ts: '2026-10-01T2030' })
  backup.save(file)
  backup.write()
  assert.equal(stripRcBlock(file), true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'export EDITOR=vim\n')
  assert.equal(fs.readdirSync(home).some((n) => n.startsWith('.bashrc.barrito-bak-')), false)
})

// ── linux detection ───────────────────────────────────────────────────────────

test('detect on linux: hosts via .desktop files, no launchd legacy, systemd unit = installed', () => {
  const f = fakes()
  process.env.BARRITO_PLATFORM = 'linux'
  fs.rmSync(path.join(home, 'emdash'), { recursive: true, force: true })
  fs.mkdirSync(path.join(home, '.local', 'share', 'applications'), { recursive: true })
  fs.writeFileSync(path.join(home, '.local', 'share', 'applications', 'emdash.desktop'), '[Desktop Entry]\n')

  const look = (shell = '/bin/bash') => detect({ home, exec: f.exec, fs, path: `${home}/bin:/usr/bin:/bin`, keychain: f.keychain, shell })
  const found = look()
  assert.deepEqual(found.hosts, ['emdash'])
  assert.equal(found.legacy.launchd, false) // the fixture ships the claude-router plist; on linux it's inert
  assert.equal(found.router.installed, false)

  fs.mkdirSync(path.join(home, '.config', 'systemd', 'user'), { recursive: true })
  fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'barrito.service'), '[Unit]\n')
  assert.equal(look().router.installed, true)
})

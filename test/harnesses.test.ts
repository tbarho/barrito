import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { builtins, find, envFor, realBin, configFragments, MARKER } from '../src/harnesses.ts'
import type { Harness, Identity, Keychain } from '../src/types.ts'

const work: Identity = {
  id: 'work',
  claude_config_dir: '/Users/x/.claude',
  share_from: null,
  fallback: [],
  match: { remotes: [], paths: [] },
  keychain: { gateway: 'Vercel AI Gateway Work', cursor: 'Cursor Work' },
}

const keychain = (map: Record<string, string> = {}): Keychain & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    get: (service: string) => {
      calls.push(service)
      return map[service] ?? null
    },
  }
}

describe('builtins', () => {
  test('claude is full level with no env templates', () => {
    assert.equal(builtins.claude.bin, 'claude')
    assert.equal(builtins.claude.level, 'full')
    assert.equal(builtins.claude.env, undefined)
  })

  test('gateway harnesses point at the router gateway with a handle key', () => {
    assert.deepEqual(builtins.codex.env, { OPENAI_BASE_URL: '{gateway}/v1', OPENAI_API_KEY: '{handle}' })
    assert.deepEqual(builtins.opencode.env, {
      AI_GATEWAY_API_KEY: '{handle}',
      VERCEL_AI_GATEWAY_BASE_URL: '{gateway}/v1/ai',
      BARRITO_HANDLE: '{handle}',
    })
  })

  test('cursor-agent has the agent alias and file credential store', () => {
    assert.equal(builtins['cursor-agent'].bin, 'cursor-agent')
    assert.deepEqual(builtins['cursor-agent'].aliases, ['agent'])
    assert.equal(builtins['cursor-agent'].env!.AGENT_CLI_CREDENTIAL_STORE, 'file')
  })

  test('configFragments.opencode points the vercel provider at the router with a handle key', () => {
    const frag = configFragments.opencode({ port: 4141 })
    assert.equal(frag.provider.vercel.npm, '@ai-sdk/vercel')
    assert.equal(frag.provider.vercel.options.baseURL, 'http://127.0.0.1:4141/gateway/v1/ai')
    assert.equal(frag.provider.vercel.options.apiKey, '{env:BARRITO_HANDLE}')
    assert.equal(configFragments.opencode({ port: 9 }).provider.vercel.options.baseURL, 'http://127.0.0.1:9/gateway/v1/ai')
  })
})

describe('find', () => {
  test('builtin by name, carrying its name', () => {
    assert.equal(find('claude', {})!.bin, 'claude')
    assert.equal(find('claude', {})!.name, 'claude')
  })

  test('builtin by alias', () => {
    assert.equal(find('agent', {})!.bin, 'cursor-agent')
  })

  test('custom harness from config', () => {
    const config = { harness: { mybot: { bin: 'mybot', env: { OPENAI_BASE_URL: '{gateway}/v1', OPENAI_API_KEY: '{handle}' } } } }
    assert.equal(find('mybot', config)!.bin, 'mybot')
    assert.equal(find('mybot', config)!.env!.OPENAI_API_KEY, '{handle}')
  })

  test('config overrides extend builtins without clobbering unsaid fields', () => {
    const h = find('claude', { harness: { claude: { env: { EXTRA: '{identity}' } } } })!
    assert.equal(h.level, 'full')
    assert.equal(h.env?.EXTRA, '{identity}')
  })

  test('unknown → null', () => {
    assert.equal(find('nope', {}), null)
  })
})

describe('envFor', () => {
  test('claude: router base URL, config dir, identity header — and never a key', () => {
    const kc = keychain({ 'Vercel AI Gateway Work': 'sk-gw-work', 'Cursor Work': 'sk-cursor-work' })
    const env = envFor(builtins.claude, work, { config: { port: 4141 }, keychain: kc })
    assert.deepEqual(env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141',
      CLAUDE_CONFIG_DIR: '/Users/x/.claude',
      ANTHROPIC_CUSTOM_HEADERS: 'x-barrito-identity: work',
      BARRITO_IDENTITY: 'work',
    })
    assert.equal(kc.calls.length, 0)
  })

  test('{keychain:…} outside level "env" is a config error naming the harness — keys never reach env', () => {
    const claudeWithKey = find('claude', { harness: { claude: { env: { ANTHROPIC_AUTH_TOKEN: '{keychain:gateway}' } } } })
    assert.throws(() => envFor(claudeWithKey!, work, { config: {}, keychain: keychain() }), /"claude" is level "full"/)
    assert.throws(
      () => envFor({ name: 'mybot', bin: 'mybot', level: 'gateway', env: { K: '{keychain:gateway}' } }, work, { keychain: keychain() }),
      /"mybot" is level "gateway"/,
    )
  })

  test('codex: gateway URL + handle', () => {
    const env = envFor(builtins.codex, work, { config: { port: 4141 }, keychain: keychain() })
    assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:4141/gateway/v1')
    assert.equal(env.OPENAI_API_KEY, 'barrito:work')
    assert.equal(env.BARRITO_IDENTITY, 'work')
  })

  test('opencode: gateway URL, handle key, BARRITO_HANDLE for the config fragment', () => {
    const env = envFor(builtins.opencode, work, { config: { port: 4141 }, keychain: keychain() })
    assert.equal(env.AI_GATEWAY_API_KEY, 'barrito:work')
    assert.equal(env.VERCEL_AI_GATEWAY_BASE_URL, 'http://127.0.0.1:4141/gateway/v1/ai')
    assert.equal(env.BARRITO_HANDLE, 'barrito:work')
  })

  test('cursor-agent: keychain slot resolved, file credential store', () => {
    // env: {} — ambient CURSOR_API_KEY/AGENT_CLI_CREDENTIAL_STORE must not trigger the parity skip
    const env = envFor(builtins['cursor-agent'], work, { config: { port: 4141 }, keychain: keychain({ 'Cursor Work': 'sk-cursor-work' }), env: {} })
    assert.equal(env.CURSOR_API_KEY, 'sk-cursor-work')
    assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, 'file')
  })

  test('env-level vars already set in the environment are never stomped (old shim parity)', () => {
    const base = { config: {}, keychain: keychain({ 'Cursor Work': 'sk-cursor-work' }) }
    const preset = envFor(builtins['cursor-agent'], work, { ...base, env: { CURSOR_API_KEY: 'ambient' } })
    assert.equal('CURSOR_API_KEY' in preset, false)
    assert.equal(preset.AGENT_CLI_CREDENTIAL_STORE, 'file')

    const both = envFor(builtins['cursor-agent'], work, { ...base, env: { CURSOR_API_KEY: 'ambient', AGENT_CLI_CREDENTIAL_STORE: 'keychain' } })
    assert.deepEqual(Object.keys(both).sort(), ['BARRITO_IDENTITY'])

    const empty = envFor(builtins['cursor-agent'], work, { ...base, env: { CURSOR_API_KEY: '' } })
    assert.equal(empty.CURSOR_API_KEY, 'sk-cursor-work') // empty counts as unset, like the old `[ -z ]` guard
  })

  test('empty keychain item warns on stderr and drops the var; unknown slot drops silently', (t) => {
    const err = t.mock.method(console, 'error', () => {})
    const env = envFor(builtins['cursor-agent'], work, { config: {}, keychain: keychain(), env: {} })
    assert.equal('CURSOR_API_KEY' in env, false)
    assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, 'file')
    const warned = err.mock.calls.map((c) => String(c.arguments[0])).find((m) => m.includes('keychain "Cursor Work" empty for work'))
    assert.ok(warned, 'expected empty-keychain warning')
    assert.match(warned, /cursor-agent will fall back to its own login$/)

    err.mock.resetCalls()
    const noSlot: Identity = { ...work, keychain: {} }
    envFor(builtins['cursor-agent'], noSlot, { config: {}, keychain: keychain(), env: {} })
    assert.equal(err.mock.calls.length, 0)
  })

  test('port comes from config', () => {
    const env = envFor(builtins.codex, work, { config: { port: 9999 }, keychain: keychain() })
    assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:9999/gateway/v1')
  })

  test('{identity} template and custom harnesses from config', () => {
    const env = envFor({ name: 'mybot', bin: 'mybot', level: 'gateway', env: { WHO: '{identity}', KEY: '{handle}', URL: '{gateway}/v1' } }, work, { config: {}, keychain: keychain() })
    assert.equal(env.WHO, 'work')
    assert.equal(env.KEY, 'barrito:work')
    assert.equal(env.URL, 'http://127.0.0.1:4141/gateway/v1')
  })

  test('undefined values are never exported', () => {
    const env = envFor({ name: 'x', bin: 'x', level: 'full' }, { id: 'work' } as Identity, {}) // no claude_config_dir
    assert.equal('CLAUDE_CONFIG_DIR' in env, false)
    assert.ok(Object.values(env).every((value) => value !== undefined))
  })
})

describe('realBin', () => {
  const mk = (name: string, body = '#!/usr/bin/env bash\ntrue\n') => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'barrito-realbin-'))
    const file = join(dir, name)
    fs.writeFileSync(file, body)
    fs.chmodSync(file, 0o755)
    return { dir, file }
  }

  test('skips the shims dir, resolves symlinks, returns the first real executable', () => {
    const shim = mk('claude')
    const real = mk('claude')
    const target = mk('claude-real') // real binary is itself a symlink
    fs.rmSync(real.file)
    fs.symlinkSync(target.file, real.file)
    assert.equal(realBin('claude', { path: `${shim.dir}:${real.dir}`, shims: shim.dir }), fs.realpathSync(target.file))
  })

  test('a PATH dir symlinked to the shims dir is also skipped', () => {
    const shim = mk('claude')
    const real = mk('claude')
    const link = join(mk('dir').dir, 'shim-link')
    fs.symlinkSync(shim.dir, link)
    assert.equal(realBin('claude', { path: `${link}:${real.dir}`, shims: shim.dir }), fs.realpathSync(real.file))
  })

  test('skips a candidate that IS the shim itself (--self), even outside the shims dir', () => {
    const selfDir = mk('claude')
    const real = mk('claude')
    assert.equal(realBin('claude', { path: `${selfDir.dir}:${real.dir}`, self: selfDir.file, shims: mk('s').dir }), fs.realpathSync(real.file))
  })

  test('skips any candidate whose first 3 lines carry the barrito marker', () => {
    const shimLike = mk('claude', `#!/usr/bin/env bash\n# ${MARKER} — do not edit\nexec whatever "$@"\n`)
    const real = mk('claude')
    assert.equal(realBin('claude', { path: `${shimLike.dir}:${real.dir}`, shims: mk('s').dir }), fs.realpathSync(real.file))
    assert.equal(realBin('claude', { path: shimLike.dir, shims: mk('s').dir }), null)
  })

  test('nothing outside the shims dir → null', () => {
    const shim = mk('claude')
    assert.equal(realBin('claude', { path: shim.dir, shims: shim.dir }), null)
    assert.equal(realBin('claude', { path: '', shims: shim.dir }), null)
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { paths, home, expand, platform } from '../src/paths.ts'

const KEYS = ['BARRITO_HOME', 'BARRITO_CONFIG', 'BARRITO_STATE', 'BARRITO_LOG', 'BARRITO_SHIMS', 'BARRITO_PLATFORM', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']

const withEnv = (patch: Record<string, string | undefined>, fn: () => void): void => {
  const saved = Object.keys(patch).reduce<Record<string, string | undefined>>((memo, k) => {
    memo[k] = process.env[k]
    return memo
  }, {})
  Object.entries(patch).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
  try {
    fn()
  } finally {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    })
  }
}

const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'barrito-paths-'))

test('home: BARRITO_HOME wins, falls back to os.homedir', () => {
  withEnv({ BARRITO_HOME: '/h' }, () => {
    assert.equal(home(), '/h')
    assert.equal(expand('~'), '/h')
    assert.equal(expand('~/x/y'), '/h/x/y')
  })
  withEnv({ BARRITO_HOME: undefined }, () => {
    assert.equal(home(), homedir())
  })
})

test('expand: leaves non-~ paths alone', () => {
  assert.equal(expand('/abs/x'), '/abs/x')
  assert.equal(expand('rel/x'), 'rel/x')
})

test('platform: BARRITO_PLATFORM override, override validation, process.platform fallback', () => {
  withEnv({ BARRITO_PLATFORM: 'linux' }, () => assert.equal(platform(), 'linux'))
  withEnv({ BARRITO_PLATFORM: 'darwin' }, () => assert.equal(platform(), 'darwin'))
  withEnv({ BARRITO_PLATFORM: 'plan9' }, () => {
    assert.throws(() => platform(), /BARRITO_PLATFORM must be "darwin" or "linux"/)
  })
  withEnv({ BARRITO_PLATFORM: undefined }, () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      assert.equal(platform(), 'linux')
    } finally {
      if (desc) Object.defineProperty(process, 'platform', desc)
    }
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      assert.throws(() => platform(), /unsupported platform "win32" — macOS and Linux only/)
    } finally {
      if (desc) Object.defineProperty(process, 'platform', desc)
    }
  })
})

test('macOS paths: unchanged layout', () => {
  withEnv({ BARRITO_HOME: '/h', BARRITO_PLATFORM: 'darwin' }, () => {
    assert.equal(paths.config, '/h/.config/barrito/config.toml')
    assert.equal(paths.state, '/h/.local/state/barrito')
    assert.equal(paths.logs, '/h/Library/Logs/barrito.log')
    assert.equal(paths.backup, '/h/.config/barrito/backup')
    assert.equal(paths.shims, '/h/.local/shims')
  })
})

test('macOS paths: XDG vars ignored, BARRITO_* overrides win', () => {
  withEnv({
    BARRITO_HOME: '/h', BARRITO_PLATFORM: 'darwin',
    XDG_CONFIG_HOME: '/xdg/config', XDG_STATE_HOME: '/xdg/state',
    BARRITO_CONFIG: '/custom/config.toml', BARRITO_STATE: '/custom/state', BARRITO_LOG: '/custom.log', BARRITO_SHIMS: '/custom/shims',
  }, () => {
    assert.equal(paths.config, '/custom/config.toml')
    assert.equal(paths.state, '/custom/state')
    assert.equal(paths.logs, '/custom.log')
    assert.equal(paths.shims, '/custom/shims')
  })
})

test('linux paths: XDG defaults mirror the macOS layout', () => {
  withEnv({ BARRITO_HOME: '/h', BARRITO_PLATFORM: 'linux', XDG_CONFIG_HOME: undefined, XDG_STATE_HOME: undefined }, () => {
    assert.equal(paths.config, '/h/.config/barrito/config.toml')
    assert.equal(paths.state, '/h/.local/state/barrito')
    assert.equal(paths.logs, '/h/.local/state/barrito/barrito.log')
    assert.equal(paths.backup, '/h/.config/barrito/backup')
    assert.equal(paths.shims, '/h/.local/shims')
  })
})

test('linux paths: XDG vars resolve', () => {
  const cfg = tmp()
  const state = tmp()
  try {
    withEnv({
      BARRITO_PLATFORM: 'linux', BARRITO_HOME: '/h',
      XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: state,
    }, () => {
      assert.equal(paths.config, path.join(cfg, 'barrito', 'config.toml'))
      assert.equal(paths.state, path.join(state, 'barrito'))
      assert.equal(paths.logs, path.join(state, 'barrito', 'barrito.log'))
      assert.equal(paths.backup, path.join(cfg, 'barrito', 'backup'))
      assert.equal(paths.shims, '/h/.local/shims')
    })
  } finally {
    rmSync(cfg, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

test('linux paths: BARRITO_* overrides win over XDG', () => {
  withEnv({
    BARRITO_PLATFORM: 'linux',
    XDG_CONFIG_HOME: '/xdg/config', XDG_STATE_HOME: '/xdg/state',
    BARRITO_CONFIG: '/custom/config.toml', BARRITO_STATE: '/custom/state', BARRITO_LOG: '/custom.log',
  }, () => {
    assert.equal(paths.config, '/custom/config.toml')
    assert.equal(paths.state, '/custom/state')
    assert.equal(paths.logs, '/custom.log')
  })
})

test('linux paths: log follows a BARRITO_STATE override', () => {
  withEnv({ BARRITO_PLATFORM: 'linux', BARRITO_STATE: '/custom/state', BARRITO_LOG: undefined }, () => {
    assert.equal(paths.logs, '/custom/state/barrito.log')
  })
})

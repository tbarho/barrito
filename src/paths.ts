import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// everything below is lazy (fn/getter) so tests can set BARRITO_* after import;
// `home` is a function, not a string, for the same reason — call it: home()
export const home = (): string => process.env.BARRITO_HOME || os.homedir()

export const expand = (p: string): string => {
  if (p === '~') return home()
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(home(), p.slice(2))
  return p
}

let cachedRoot: string | undefined

const ours = (dir: string): boolean => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return pkg.name === 'barrito'
  } catch {
    return false
  }
}

// absolute package root — walks up from this file until a dir holds our
// package.json; works from src/ (dev) and dist/src/ (built); cached
export const root = (): string => {
  if (cachedRoot) return cachedRoot
  let dir = path.dirname(fileURLToPath(import.meta.url))
  const top = path.parse(dir).root
  while (true) {
    if (ours(dir)) {
      cachedRoot = dir
      return dir
    }
    if (dir === top) throw new Error(`paths: package root not found — no package.json with name "barrito" above ${dir}`)
    dir = path.dirname(dir)
  }
}

// every platform decision in paths (and callers) goes through this —
// BARRITO_PLATFORM lets tests and CI force a platform without lying about process
export const platform = (): 'darwin' | 'linux' => {
  const o = process.env.BARRITO_PLATFORM
  if (o === 'darwin' || o === 'linux') return o
  if (o) throw new Error(`barrito: BARRITO_PLATFORM must be "darwin" or "linux", got "${o}"`)
  if (process.platform === 'darwin' || process.platform === 'linux') return process.platform
  throw new Error(`barrito: unsupported platform "${process.platform}" — macOS and Linux only`)
}

const xdg = (name: 'XDG_CONFIG_HOME' | 'XDG_STATE_HOME', ...fallback: string[]): string =>
  process.env[name] || path.join(home(), ...fallback)

export const paths = {
  get config(): string {
    if (process.env.BARRITO_CONFIG) return process.env.BARRITO_CONFIG
    if (platform() === 'linux') return path.join(xdg('XDG_CONFIG_HOME', '.config'), 'barrito', 'config.toml')
    return path.join(home(), '.config', 'barrito', 'config.toml')
  },
  get state(): string {
    if (process.env.BARRITO_STATE) return process.env.BARRITO_STATE
    if (platform() === 'linux') return path.join(xdg('XDG_STATE_HOME', '.local', 'state'), 'barrito')
    return path.join(home(), '.local', 'state', 'barrito')
  },
  get logs(): string {
    if (process.env.BARRITO_LOG) return process.env.BARRITO_LOG
    if (platform() === 'linux') return path.join(paths.state, 'barrito.log')
    return path.join(home(), 'Library', 'Logs', 'barrito.log')
  },
  get backup(): string { return path.join(path.dirname(paths.config), 'backup') },
  get shims(): string { return process.env.BARRITO_SHIMS || path.join(home(), '.local', 'shims') },
}

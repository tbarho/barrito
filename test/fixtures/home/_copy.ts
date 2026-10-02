import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const fixture = path.dirname(fileURLToPath(import.meta.url))

// Claude Code encodes a cwd by replacing non-alphanumerics with '-'
export const encode = (p: string): string => String(p).replace(/[^A-Za-z0-9]/g, '-')

// mkdtemp keeps the home dash-free so an encoded project dir decodes unambiguously
const base = tmpdir().includes('-') ? '/tmp' : tmpdir()
const dest = () => fs.mkdtempSync(path.join(base, 'bh'))

const chmodx = (dir: string): void => {
  fs.readdirSync(dir).forEach((name) => {
    const p = path.join(dir, name)
    if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o755)
  })
}

// copy the fixture HOME to a fresh temp dir; rename the placeholder project
// dirs to real encoded paths for the temp home
export const copy = (): string => {
  const home = dest()
  fs.cpSync(fixture, home, {
    recursive: true,
    dereference: false,
    filter: (src) => !src.endsWith('_copy.js'),
  })
  const projects = path.join(home, '.claude', 'projects')
  const names: Record<string, string> = {
    __work__: `${home}/Code/acme/api`,
    __personal__: `${home}/Code/you/dotfiles`,
    __other__: '/private/tmp/somewhere',
  }
  Object.entries(names).forEach(([placeholder, real]) => {
    fs.renameSync(path.join(projects, placeholder), path.join(projects, encode(real)))
  })
  chmodx(path.join(home, '.local', 'shims'))
  chmodx(path.join(home, 'bin'))
  return home
}

export const env = (home: string): string => {
  process.env.BARRITO_HOME = home
  process.env.BARRITO_CONFIG = path.join(home, '.config', 'barrito', 'config.toml')
  process.env.BARRITO_STATE = path.join(home, '.local', 'state', 'barrito')
  process.env.BARRITO_LOG = path.join(home, 'Library', 'Logs', 'barrito.log')
  process.env.BARRITO_SHIMS = path.join(home, '.local', 'shims')
  return home
}

// recursive snapshot: path → type(: symlink target), for write-nothing assertions
export const snap = (root: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    fs.readdirSync(dir).forEach((name) => {
      const p = path.join(dir, name)
      const stat = fs.lstatSync(p)
      if (stat.isSymbolicLink()) { out[p] = `link:${fs.readlinkSync(p)}`; return }
      if (stat.isDirectory()) { out[p] = 'dir'; walk(p); return }
      out[p] = `file:${fs.readFileSync(p, 'utf8')}`
    })
  }
  walk(root)
  return out
}

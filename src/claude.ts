import fsx from 'node:fs'
import path from 'node:path'
import { home as homeDir } from './paths.ts'
import type { Reader } from './types.ts'

type Fs = Pick<Reader, 'readFileSync'>
type Obj = Record<string, unknown>

// Claude Code picks its login by whether CLAUDE_CONFIG_DIR is SET, not by the path: unset →
// ~/.claude.json + keychain "Claude Code-credentials"; set (even to ~/.claude) → <dir>/.claude.json
// + "Claude Code-credentials-<sha256(dir)[:8]>", a separate login. So the default dir is reached
// only by leaving the variable unset — the shim unsets it, and this mirrors that.
export const isDefault = (dir: string, home: string = homeDir()): boolean => !!dir && path.resolve(dir) === path.join(home, '.claude')

// the env a shim exports for a config dir: '' means unset
export const configDirEnv = (dir: string, home: string = homeDir()): string => isDefault(dir, home) ? '' : dir

export const loginCommand = (dir: string, short: (p: string) => string = (p) => p, home: string = homeDir()): string =>
  isDefault(dir, home) ? 'env -u CLAUDE_CONFIG_DIR claude' : `CLAUDE_CONFIG_DIR=${short(dir)} claude`

const files = (dir: string, home: string): string[] => [
  isDefault(dir, home) ? path.join(home, '.claude.json') : path.join(dir, '.claude.json'),
  path.join(dir, '.credentials.json'),
]

const read = (fs: Fs, file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const prop = (v: unknown, key: string): unknown => (typeof v === 'object' && v !== null ? (v as Obj)[key] : undefined)

export const account = (
  dir: string,
  { home = homeDir(), fs = fsx, env = process.env }: { home?: string; fs?: Fs; env?: Record<string, string | undefined> } = {},
): { loggedIn: boolean; email: string | null; uuid: string | null } => {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { loggedIn: true, email: null, uuid: null } // CI: token in env, no ~/.claude.json
  const oauth = files(dir, home).reduce<unknown>((memo, file) => memo ?? prop(read(fs, file), 'oauthAccount') ?? null, null)
  return {
    loggedIn: oauth != null,
    email: (prop(oauth, 'emailAddress') ?? null) as string | null,
    uuid: (prop(oauth, 'accountUuid') ?? null) as string | null,
  }
}

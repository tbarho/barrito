import fsx from 'node:fs'
import path from 'node:path'
import { home as homeDir } from './paths.ts'
import type { Reader } from './types.ts'

type Fs = Pick<Reader, 'readFileSync'>
type Obj = Record<string, unknown>

// Claude Code keeps the account file at ~/.claude.json for the default dir, inside the dir when CLAUDE_CONFIG_DIR is set
const files = (dir: string, home: string): string[] => {
  const own = path.join(dir, '.claude.json')
  if (path.resolve(dir) === path.join(home, '.claude')) {
    return [path.join(home, '.claude.json'), own, path.join(dir, '.credentials.json')]
  }
  return [own, path.join(dir, '.credentials.json')]
}

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
): { loggedIn: boolean; email: string | null } => {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { loggedIn: true, email: null } // CI: token in env, no ~/.claude.json
  const oauth = files(dir, home).reduce<unknown>((memo, file) => memo ?? prop(read(fs, file), 'oauthAccount') ?? null, null)
  return { loggedIn: oauth != null, email: (prop(oauth, 'emailAddress') ?? null) as string | null }
}

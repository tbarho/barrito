import fsx from 'node:fs'
import path from 'node:path'
import { paths } from './paths.ts'
import * as keychain from './keychain/index.ts'
import type { Recorder, SecretEntry } from './keychain/index.ts'
import type { Exec } from './types.ts'

const stamp = () => new Date().toISOString().slice(0, 16)

export type BackupEntry =
  | { original: string; saved: string; symlink?: undefined }
  | { original: string; saved: string; symlink: true; target: string }

export interface BackupManifest {
  version: number
  created: string
  files: BackupEntry[]
  launchd: string[]
  removed: string[]
  keychain: SecretEntry[]
}

export interface Backup extends Recorder {
  root: string
  manifest: BackupManifest
  save: (file: string) => string
  record: (kind: 'launchd' | 'removed', data: string) => void
  write: () => string
}

export interface CreateOpts {
  ts?: string
  dir?: string
  fs?: typeof fsx
  now?: Date
}

// save() copies files (symlinks stay symlinks) into <dir>/<ts>/, record() collects
// launchd labels and removed paths, write() drops the manifest restore() reads back
export const create = ({ ts = stamp(), dir = paths.backup, fs = fsx, now = new Date() }: CreateOpts = {}): Backup => {
  const root = path.join(dir, ts)
  const manifest: BackupManifest = { version: 1, created: now.toISOString(), files: [], launchd: [], removed: [], keychain: [] }

  const save = (file: string): string => {
    fs.mkdirSync(root, { recursive: true })
    const saved = path.join(root, `${String(manifest.files.length).padStart(3, '0')}-${path.basename(file)}`)
    if (fs.lstatSync(file).isSymbolicLink()) {
      const target = fs.readlinkSync(file)
      fs.symlinkSync(target, saved)
      manifest.files.push({ original: file, saved, symlink: true, target })
      return saved
    }
    fs.copyFileSync(file, saved)
    manifest.files.push({ original: file, saved })
    return saved
  }

  const record = (kind: 'launchd' | 'removed', data: string): void => {
    manifest[kind] = [...(manifest[kind] ?? []), data]
  }

  // names only: which item was overwritten and which in-keyring item holds the old value
  const secret = (entry: SecretEntry): void => {
    if (manifest.keychain.some((e) => e.backup === entry.backup)) return
    manifest.keychain.push({ kind: 'keychain', service: entry.service, account: entry.account, backup: entry.backup })
  }

  const write = (): string => {
    fs.mkdirSync(root, { recursive: true })
    const file = path.join(root, 'manifest.json')
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
    return file
  }

  return { root, ts, manifest, save, record, secret, write }
}

const corrupt = (manifestPath: string): Error =>
  new Error(`barrito: backup manifest ${manifestPath} is corrupt`)

const isStr = (v: unknown): v is string => typeof v === 'string'

const isEntry = (v: unknown): v is BackupEntry => {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  if (!isStr(e.original) || !isStr(e.saved)) return false
  return e.symlink === undefined || (e.symlink === true && isStr(e.target))
}

const isSecret = (v: unknown): v is SecretEntry => {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return e.kind === 'keychain' && isStr(e.service) && isStr(e.account) && isStr(e.backup)
}

const parse = (manifestPath: string, fs: typeof fsx): BackupManifest => {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    throw corrupt(manifestPath)
  }
  if (typeof raw !== 'object' || raw === null) throw corrupt(manifestPath)
  const m = raw as Record<string, unknown>
  if (m.version !== 1 || !Array.isArray(m.files) || !Array.isArray(m.launchd) || !Array.isArray(m.removed)) {
    throw corrupt(manifestPath)
  }
  if (!m.files.every(isEntry) || !m.launchd.every(isStr) || !m.removed.every(isStr)) throw corrupt(manifestPath)
  const secrets = m.keychain ?? []
  if (!Array.isArray(secrets) || !secrets.every(isSecret)) throw corrupt(manifestPath)
  return {
    version: 1,
    created: isStr(m.created) ? m.created : '',
    files: m.files,
    launchd: m.launchd,
    removed: m.removed,
    keychain: secrets,
  }
}

export const read = (manifestPath: string, fs: typeof fsx = fsx): BackupManifest => parse(manifestPath, fs)

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'error'

// each overwritten keychain item gets its backup's value back (a verified set), then the
// backup item goes; a missing backup is skipped, never fatal
const secrets = (entries: SecretEntry[], opts: keychain.SetOpts, report: (line: string) => void): void => {
  entries.forEach((e) => {
    try {
      if (!keychain.recover(e.service, e.backup, { ...opts, account: e.account })) {
        report(`! skipped keychain "${e.service}" (backup "${e.backup}" is missing)`)
        return
      }
      report(`✓ restored keychain "${e.service}"`)
    } catch (err) {
      report(`! skipped keychain "${e.service}" (${why(err)})`)
    }
  })
}

// puts files and symlinks back, re-bootstraps the backed-up launchd plists, then the
// overwritten keychain items
export const restore = (
  manifestPath: string,
  { exec, fs = fsx, keyring = {}, report = () => {} }: { exec?: Exec; fs?: typeof fsx; keyring?: keychain.SetOpts; report?: (line: string) => void } = {},
): BackupManifest => {
  const dir = path.dirname(manifestPath)
  const manifest = parse(manifestPath, fs)

  manifest.files.forEach((entry) => {
    const saved = path.join(dir, path.basename(entry.saved))
    fs.mkdirSync(path.dirname(entry.original), { recursive: true })
    if (fs.existsSync(entry.original)) fs.rmSync(entry.original, { force: true })
    if (entry.symlink) {
      fs.symlinkSync(entry.target, entry.original)
      return
    }
    fs.copyFileSync(saved, entry.original)
  })

  manifest.launchd.forEach((label) => {
    const plist = manifest.files.find((f) => path.basename(f.original) === `${label}.plist`)
    if (plist) exec!('/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, plist.original])
  })

  secrets(manifest.keychain, keyring, report)
  return manifest
}

export interface Listed {
  ts: string
  manifest: string
  created: string
  summary: string
  entries: number
}

const summarize = (m: BackupManifest): string => {
  const parts = [
    m.files.length && `${m.files.length} file(s)`,
    m.launchd.length && `${m.launchd.length} launchd`,
    m.keychain.length && `${m.keychain.length} keychain`,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'nothing to restore'
}

// valid backups only (dir holds a manifest the parser accepts), newest first by the
// manifest's `created`, dir mtime as fallback; foreign dirs and corrupt manifests are ignored
export const list = (dir: string = paths.backup, fs: typeof fsx = fsx): Listed[] => {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).reduce<(Listed & { at: number })[]>((memo, ts) => {
    const manifest = path.join(dir, ts, 'manifest.json')
    try {
      const m = parse(manifest, fs)
      const at = Date.parse(m.created) || fs.statSync(path.join(dir, ts)).mtimeMs
      const entries = m.files.length + m.launchd.length + m.keychain.length
      memo.push({ ts, manifest, created: m.created || new Date(at).toISOString(), summary: summarize(m), entries, at })
    } catch {}
    return memo
  }, []).sort((a, b) => b.at - a.at || b.ts.localeCompare(a.ts))
}

// manifest for `barrito uninstall --restore`: `from` (a backup dir name) wins, else the
// newest backup that has at least one file/launchd/keychain entry
export const latest = (dir: string = paths.backup, fs: typeof fsx = fsx, from?: string): string | null => {
  const all = list(dir, fs)
  if (from) return all.find((b) => b.ts === from)?.manifest ?? null
  return all.find((b) => b.entries > 0)?.manifest ?? null
}

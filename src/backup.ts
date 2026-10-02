import fsx from 'node:fs'
import path from 'node:path'
import { paths } from './paths.ts'
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
}

export interface Backup {
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
  const manifest: BackupManifest = { version: 1, created: now.toISOString(), files: [], launchd: [], removed: [] }

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

  const write = (): string => {
    fs.mkdirSync(root, { recursive: true })
    const file = path.join(root, 'manifest.json')
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
    return file
  }

  return { root, manifest, save, record, write }
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
  return {
    version: 1,
    created: isStr(m.created) ? m.created : '',
    files: m.files,
    launchd: m.launchd,
    removed: m.removed,
  }
}

// puts files and symlinks back, then re-bootstraps the backed-up launchd plists
export const restore = (
  manifestPath: string,
  { exec, fs = fsx }: { exec?: Exec; fs?: typeof fsx } = {},
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

  return manifest
}

// newest backup's manifest, for `barrito uninstall --restore`
export const latest = (dir: string = paths.backup, fs: typeof fsx = fsx): string | null => {
  if (!fs.existsSync(dir)) return null
  const ts = fs.readdirSync(dir).sort().at(-1)
  const manifest = ts ? path.join(dir, ts, 'manifest.json') : null
  return manifest && fs.existsSync(manifest) ? manifest : null
}

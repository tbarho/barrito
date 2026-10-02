import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import * as macos from './macos.ts'
import * as linux from './linux.ts'
import { expand, platform } from '../paths.ts'
import type { Exec } from '../types.ts'

type Adapter = {
  get: (service: string, opts?: { exec?: Exec }) => string | null
  set: (service: string, value: string, opts?: { account?: string; exec?: Exec }) => void
  has?: (service: string, opts?: { exec?: Exec }) => boolean
  del?: (service: string, opts?: { exec?: Exec }) => boolean
  list?: (opts?: { exec?: Exec }) => string[]
}

const adapters: Record<string, Adapter> = { darwin: macos, linux }

const adapter = (): Adapter => {
  const a = adapters[platform()]
  if (!a) throw new Error(`barrito: no keychain adapter for "${platform()}"`)
  return a
}

// what a keychain slot in config.toml refers to — doctor reports per kind
export const kind = (ref: string): 'env' | 'file' | 'keyring' =>
  ref.startsWith('env:') ? 'env' : ref.startsWith('file:') ? 'file' : 'keyring'

// barrito owns its own Keychain items: "barrito: <slot> <identity>", account "barrito",
// created with -T /usr/bin/security — creation never asks, reads never prompt again.
// Items made by other tools are copied into these, never modified.
export const ownName = (slot: string, identity: string): string => `barrito: ${slot} ${identity}`
export const owned = (ref: string): boolean => ref.startsWith('barrito: ')

type Env = Record<string, string | undefined>

// subset of node:fs stats the symlink guards look at
export type Stats = {
  isSymbolicLink: () => boolean
  mode: number
  uid: number
}

export type SecretFs = {
  readFileSync: (file: string, encoding: 'utf8') => string
  lstatSync: (file: string) => Stats
  statSync: (file: string) => Stats
  readlinkSync: (file: string) => string
  openSync: (file: string, flags: 'wx', mode: number) => number
  writeSync: (fd: number, data: string) => number
  fsyncSync: (fd: number) => void
  closeSync: (fd: number) => void
  renameSync: (from: string, to: string) => void
  mkdirSync: (dir: string, opts?: { recursive?: boolean }) => void
  readdirSync: (dir: string) => string[]
  rmSync: (file: string, opts?: { force?: boolean }) => void
}

// names only — a manifest never holds a secret value
export type SecretEntry = { kind: 'keychain'; service: string; account: string; backup: string }

// the slice of a backup handle (src/backup.ts) set() needs: its ts names the backup
// item, secret() records it in the manifest
export type Recorder = { ts: string; secret: (entry: SecretEntry) => void }

export type GetOpts = { exec?: Exec; env?: Env; fs?: SecretFs }
export type SetOpts = GetOpts & { account?: string; backup?: Recorder; now?: () => Date }

const missing = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'

const exists = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST'

const refuse = (msg: string): Error => new Error(`barrito: ${msg}`)

// getuid is optional in types (windows); a sentinel that matches no real file
const uid = (): number => process.getuid?.() ?? -1

// a symlinked secret may only point at the user's own private file
const throughSafeLink = (ref: string, file: string, files: SecretFs): boolean => {
  const target = path.resolve(path.dirname(file), files.readlinkSync(file))
  let st: Stats
  try {
    st = files.statSync(target)
  } catch (err) {
    if (missing(err)) return false // dangling link → nothing to read
    throw err
  }
  if (st.uid === uid() && (st.mode & 0o077) === 0) return true
  throw refuse(`refusing to read ${ref} — symlink target is not owned by you or is group/world-accessible`)
}

const refuseUnsafeDest = (ref: string, file: string, files: SecretFs): void => {
  let st: Stats | null = null
  try {
    st = files.lstatSync(file)
  } catch (err) {
    if (!missing(err)) throw err // no destination yet is the normal case
  }
  if (st?.isSymbolicLink()) throw refuse(`refusing to write ${ref} — destination is a symlink`)
  const dir = files.statSync(path.dirname(file))
  if ((dir.mode & 0o022) !== 0 && (dir.mode & 0o1000) === 0)
    throw refuse(`refusing to write ${ref} — parent dir is group/world-writable without the sticky bit`)
}

// O_EXCL ('wx') on a random name closes the pre-planted-symlink window; the
// secret only ever exists at 0600, fsynced before the atomic rename
const fileSet = (ref: string, value: string, files: SecretFs): void => {
  const file = expand(ref.slice(5))
  files.mkdirSync(path.dirname(file), { recursive: true })
  refuseUnsafeDest(ref, file, files)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number
  try {
    fd = files.openSync(tmp, 'wx', 0o600)
  } catch (err) {
    if (exists(err)) throw refuse(`refusing to write ${ref} — temp path already exists (possible symlink attack)`)
    throw err
  }
  try {
    files.writeSync(fd, value)
    files.fsyncSync(fd)
  } finally {
    files.closeSync(fd)
  }
  files.renameSync(tmp, file)
}

export const get = (service: string, opts: GetOpts = {}): string | null => {
  if (kind(service) === 'env') {
    const v = (opts.env ?? process.env)[service.slice(4)]
    const value = typeof v === 'string' ? v.trim() : ''
    return value || null
  }
  if (kind(service) === 'file') {
    const files = opts.fs ?? fs
    const file = expand(service.slice(5))
    try {
      if (files.lstatSync(file).isSymbolicLink() && !throughSafeLink(service, file, files)) return null
    } catch (err) {
      if (missing(err)) return null
      throw err
    }
    try {
      const value = files.readFileSync(file, 'utf8').trim()
      return value || null
    } catch (err) {
      if (missing(err)) return null
      throw err
    }
  }
  return adapter().get(service, opts)
}

// existence without touching the secret — on macOS this reads attributes only (no
// -w), so probing an item another tool made never triggers an access prompt
export const has = (service: string, opts: GetOpts = {}): boolean => {
  if (kind(service) !== 'keyring') return get(service, opts) != null
  const probe = adapter().has
  return probe ? probe(service, opts) : get(service, opts) != null
}

// remove a keyring item — only ever called on barrito-owned items (we created them
// with -T /usr/bin/security, so deleting needs no approval)
export const del = (service: string, opts: GetOpts = {}): boolean => {
  if (kind(service) === 'env') throw new Error('barrito: env: secrets are read-only')
  if (kind(service) === 'file') throw new Error(`barrito: not a keyring item: ${service}`)
  const remove = adapter().del
  if (!remove) throw new Error(`barrito: keyring deletion is unsupported on "${platform()}"`)
  return remove(service, opts)
}

const write = (service: string, value: string, opts: SetOpts): void => {
  if (kind(service) === 'file') {
    fileSet(service, value, opts.fs ?? fs)
    return
  }
  adapter().set(service, value, opts)
}

// every overwrite is preceded by a backup of the old value: a keyring item becomes
// "barrito backup: <service> <ts>" in the same keyring (never on disk), a file: secret
// a 0600 sibling "<file>.barrito-bak-<ts>"; the newest RETAIN per service are kept
export const RETAIN = 3
export const BACKUP = 'barrito backup: '
const FILE_BAK = '.barrito-bak-'

export const backupName = (service: string, ts: string): string =>
  kind(service) === 'file' ? `${service}${FILE_BAK}${ts}` : `${BACKUP}${service} ${ts}`

export type BackupItem = { service: string; ts: string; backup: string }

export const parseBackup = (name: string): BackupItem | null => {
  const m = name.match(/^barrito backup: (.+) (\S+)$/) ?? name.match(/^(file:.+)\.barrito-bak-([^/]+)$/)
  return m ? { service: m[1] ?? '', ts: m[2] ?? '', backup: name } : null
}

const stamp = (now: Date): string => now.toISOString().slice(0, 19)

const newest = (a: BackupItem, b: BackupItem): number => b.ts.localeCompare(a.ts)

const fileBackups = (ref: string, files: SecretFs): BackupItem[] => {
  const file = expand(ref.slice(5))
  const base = `${path.basename(file)}${FILE_BAK}`
  let names: string[] = []
  try {
    names = files.readdirSync(path.dirname(file))
  } catch (err) {
    if (!missing(err)) throw err
  }
  return names
    .filter((n) => n.startsWith(base))
    .map((n) => ({ service: ref, ts: n.slice(base.length), backup: `${ref}${FILE_BAK}${n.slice(base.length)}` }))
}

// barrito backup items, newest first: every keyring one, plus the siblings of the given file: refs
export const backups = (opts: GetOpts & { files?: string[] } = {}): BackupItem[] => {
  const files = opts.fs ?? fs
  const ring = adapter().list?.(opts) ?? []
  const keyed = ring.map(parseBackup).filter((b): b is BackupItem => b != null)
  const onDisk = [...new Set(opts.files ?? [])].filter((r) => kind(r) === 'file').flatMap((r) => fileBackups(r, files))
  return [...keyed, ...onDisk].sort(newest)
}

const listFor = (service: string, opts: GetOpts): BackupItem[] =>
  kind(service) === 'file' ? fileBackups(service, opts.fs ?? fs).sort(newest) : backups(opts).filter((b) => b.service === service)

export const drop = (ref: string, opts: GetOpts = {}): boolean => {
  if (kind(ref) === 'file') {
    (opts.fs ?? fs).rmSync(expand(ref.slice(5)), { force: true })
    return true
  }
  return del(ref, opts)
}

const prune = (service: string, opts: GetOpts): void => {
  listFor(service, opts).slice(RETAIN).forEach((b) => drop(b.backup, opts))
}

// one backup per (service, ts): a second overwrite inside the same run keeps the first —
// that one holds the value from before barrito touched it
const preserve = (service: string, old: string, opts: SetOpts): void => {
  const ts = opts.backup?.ts ?? stamp((opts.now ?? (() => new Date()))())
  const name = backupName(service, ts)
  if (!has(name, opts)) write(name, old, { ...opts, account: 'barrito' })
  opts.backup?.secret({ kind: 'keychain', service, account: opts.account ?? 'barrito', backup: name })
}

const current = (service: string, opts: SetOpts): string | null => {
  try {
    return get(service, opts)
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err)
    throw refuse(`refusing to overwrite "${service}" — its current value couldn't be read for a backup (${why})`)
  }
}

// a symlinked file: destination is refused before its old value is ever read
const refuseLink = (ref: string, files: SecretFs): void => {
  try {
    if (files.lstatSync(expand(ref.slice(5))).isSymbolicLink()) throw refuse(`refusing to write ${ref} — destination is a symlink`)
  } catch (err) {
    if (!missing(err)) throw err
  }
}

export const set = (service: string, value: string, opts: SetOpts = {}): void => {
  if (kind(service) === 'env') throw new Error('barrito: env: secrets are read-only')
  if (kind(service) === 'file') refuseLink(service, opts.fs ?? fs)
  const old = current(service, opts)
  const saving = old != null && old !== value
  if (saving) preserve(service, old, opts)
  write(service, value, opts)
  if (saving) prune(service, opts)
}

// put a backup item's value back on its service (that write is itself backed up),
// then delete the backup — false when the backup item is gone
export const recover = (service: string, backup: string, opts: SetOpts = {}): boolean => {
  const value = get(backup, opts)
  if (value == null) return false
  set(service, value, opts)
  drop(backup, opts)
  return true
}

// manual restore: the newest backup of a service, or the one taken at `from`
export const restore = (service: string, opts: SetOpts & { from?: string } = {}): BackupItem | null => {
  const pick = listFor(service, opts).find((b) => !opts.from || b.ts === opts.from)
  if (!pick) return null
  return recover(service, pick.backup, opts) ? pick : null
}

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ClaudeSettings, PickerRow } from './types.ts'

type Obj = Record<string, unknown>

const file = (configDir: string): string => path.join(configDir, 'settings.json')
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

// settings.json is user-owned: unrecognizable env/statusLine/modelPicker shapes are
// dropped (or their bad rows/entries) instead of trusted — anything else passes through
const asEnv = (v: unknown): Record<string, string> | undefined =>
  isObj(v)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => isStr(x))) as Record<string, string>
    : undefined

const asStatusLine = (v: unknown): NonNullable<ClaudeSettings['statusLine']> | undefined =>
  isObj(v) && v.type === 'command' && isStr(v.command)
    ? v as NonNullable<ClaudeSettings['statusLine']>
    : undefined

const asPicker = (v: unknown): NonNullable<ClaudeSettings['modelPicker']> | undefined => {
  if (!isObj(v) || !Array.isArray(v.options)) return undefined
  const rows = v.options.filter(
    (row): row is PickerRow => isObj(row) && isStr(row.model) && isStr(row.label) && isStr(row.description),
  )
  return { ...v, options: rows } as NonNullable<ClaudeSettings['modelPicker']>
}

const narrow = (raw: Obj): ClaudeSettings => {
  const shapes: Record<string, (v: unknown) => unknown> = {
    env: asEnv,
    statusLine: asStatusLine,
    modelPicker: asPicker,
  }
  return Object.entries(raw).reduce<ClaudeSettings>((out, [k, v]) => {
    const shape = shapes[k]
    const good = shape ? shape(v) : v
    if (good !== undefined) out[k] = good
    return out
  }, {})
}

export const read = (configDir: string): ClaudeSettings => {
  const f = file(configDir)
  if (!existsSync(f)) return {}
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(f, 'utf8'))
  } catch (err) {
    throw new Error(`settings: ${f}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isObj(settings)) throw new Error(`settings: ${f} is not a JSON object`)
  return narrow(settings)
}

const deep = (base: Obj, over: Obj): Obj => Object.entries(over).reduce((memo, [k, v]) => {
  const cur = memo[k]
  memo[k] = isObj(v) && isObj(cur) ? deep(cur, v) : v
  return memo
}, { ...base })

const write = (configDir: string, settings: ClaudeSettings): void => {
  const f = file(configDir)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(`${f}.tmp`, JSON.stringify(settings, null, 2) + '\n')
  renameSync(`${f}.tmp`, f)
}

// merge/remove back up a corrupt settings.json to settings.json.bad-<ts> and start
// fresh instead of dying; read() alone still throws. Warnings land in `lastWarnings`.
export const lastWarnings: string[] = []

const salvage = (configDir: string): ClaudeSettings => {
  const f = file(configDir)
  try {
    return read(configDir)
  } catch (err) {
    const bad = `${f}.bad-${Date.now()}`
    renameSync(f, bad)
    lastWarnings.push(`settings: ${f} unreadable (${err instanceof Error ? err.message : String(err)}) — moved to ${bad}, starting fresh`)
    return {}
  }
}

export const merge = (configDir: string, fragment: ClaudeSettings): ClaudeSettings => {
  lastWarnings.length = 0
  const settings = deep(salvage(configDir), fragment) as ClaudeSettings
  write(configDir, settings)
  return settings
}

const del = (obj: Obj, parts: string[]): void => {
  const [head, ...rest] = parts
  if (!head) return
  if (!rest.length) {
    delete obj[head]
    return
  }
  const next = obj[head]
  if (!isObj(next)) return
  del(next, rest)
  if (!Object.keys(next).length) delete obj[head]
}

export const remove = (configDir: string, keyPaths: string | string[]): ClaudeSettings => {
  lastWarnings.length = 0
  if (!existsSync(file(configDir))) return {}
  const settings = salvage(configDir)
  const keys = Array.isArray(keyPaths) ? keyPaths : [keyPaths]
  keys.forEach((dotted) => del(settings, dotted.split('.')))
  write(configDir, settings)
  return settings
}

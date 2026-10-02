import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'smol-toml'
import { paths, expand, home } from './paths.ts'
import type { Config, ConfigInput, GraftConfig, Identity, ModelRules } from './types.ts'

export const defaults = { port: 4141, default: 'personal', identities: {}, models: {}, graft: { roots: [], repos: [] }, harness: {} }

type Obj = Record<string, unknown>
type RawIdentity = Identity & Obj

const known = ['port', 'default', 'identities', 'models', 'graft', 'harness']
const idKeys = ['claude_config_dir', 'share_from', 'fallback', 'match', 'keychain']
const modelDefaults = () => ({
  include: [], exclude: [], require: ['tool-use'], max_input_price: null, pin: [], labels: {},
  agents: { astra: 'openai/gpt-6-astra', glm: 'zai/glm-5.3[1m]', deepseek: 'deepseek/deepseek-v4.1-flash[1m]' },
})

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const code = (err: unknown): unknown => (typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined)

// smol-toml parses into null-prototype tables — rewrap as plain objects
const plain = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(plain)
  if (!isObj(v)) return v
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
}

const merge = <T>(base: object, over: object): T => {
  const memo = { ...base } as Obj
  return Object.entries(over as Obj).reduce((m, [k, v]) => {
    const cur = m[k]
    if (isObj(v) && isObj(cur)) m[k] = merge<Obj>(cur, v)
    else m[k] = v
    return m
  }, memo) as T
}

const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string')

const checkIdentity = (file: string, id: string, v: unknown): void => {
  if (!isObj(v)) throw new Error(`config ${file}: identities.${id} must be a table`)
  if (v.match === undefined) return
  if (!isObj(v.match)) throw new Error(`config ${file}: identities.${id}.match must be a table with remotes = ["github.com/owner/*"] and paths = ["~/Code/**"]`)
  if (v.match.remotes !== undefined && !strings(v.match.remotes)) throw new Error(`config ${file}: identities.${id}.match.remotes must be an array of strings, e.g. ["github.com/owner/*"]`)
  if (v.match.paths !== undefined && !strings(v.match.paths)) throw new Error(`config ${file}: identities.${id}.match.paths must be an array of strings, e.g. ["~/Code/**"]`)
}

const checkKeychain = (file: string, id: string, v: unknown): void => {
  if (!isObj(v) || v.keychain === undefined) return
  if (!isObj(v.keychain)) throw new Error(`config ${file}: identities.${id}.keychain must be a table of item names, e.g. { gateway = "Vercel AI Gateway" }`)
  Object.entries(v.keychain).forEach(([slot, name]) => {
    if (typeof name !== 'string') throw new Error(`config ${file}: identities.${id}.keychain.${slot} must be a string (the keychain item name)`)
  })
}

const validate = (config: Config, file: string): void => {
  const port = config.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`config ${file}: port must be an integer between 1 and 65535, got ${JSON.stringify(port)} — e.g. port = 4141`)
  }
  if (!isObj(config.identities)) throw new Error(`config ${file}: [identities] must be a table`)
  const ids = Object.keys(config.identities)
  if (ids.length && !ids.includes(config.default)) {
    throw new Error(`config ${file}: default identity "${config.default}" is not defined — add [identities.${config.default}] or set default to one of: ${ids.join(', ')}`)
  }
  Object.entries(config.identities).forEach(([id, v]) => {
    checkIdentity(file, id, v)
    checkKeychain(file, id, v)
  })
}

// missing `fallback` = [] ("stop and tell me") — init writes the user's choice; never inject a paid chain
const identity = (id: string, raw: unknown): RawIdentity => {
  const merged = merge<RawIdentity>({ share_from: null, fallback: [], match: { remotes: [], paths: [] }, keychain: {} }, isObj(raw) ? raw : {})
  merged.id = id
  merged.claude_config_dir = expand(merged.claude_config_dir)
  merged.share_from = merged.share_from === null ? null : expand(merged.share_from)
  merged.match.paths = merged.match.paths.map(expand)
  return merged
}

export const load = (file: string = paths.config): Config & { warnings: string[] } => {
  let raw: Obj = {}
  try {
    raw = plain(parse(readFileSync(file, 'utf8'))) as Obj
  } catch (err) {
    if (code(err) !== 'ENOENT') throw new Error(`config ${file}: ${msg(err)}`)
  }
  const config = merge<Config>(defaults, raw)
  validate(config, file)
  const rawIdentities: Obj = isObj(raw.identities) ? raw.identities : {}
  config.warnings = [
    ...Object.keys(raw).filter((k) => !known.includes(k)).map((k) => `unknown key "${k}" ignored (known: ${known.join(', ')})`),
    ...Object.entries(rawIdentities)
      .flatMap(([id, v]) => (isObj(v)
        ? Object.keys(v).filter((k) => !idKeys.includes(k)).map((k) => `unknown key "${k}" in identities.${id} ignored (known: ${idKeys.join(', ')})`)
        : [])),
  ]
  config.identities = Object.fromEntries(Object.entries(config.identities).map(([id, v]) => [id, identity(id, v)] as const))
  config.models = merge<ModelRules>(modelDefaults(), config.models)
  config.graft = merge<GraftConfig>(defaults.graft, config.graft)
  config.graft.roots = config.graft.roots.map(expand)
  config.graft.repos = config.graft.repos.map((repo) => ({ ...repo, path: expand(repo.path) }))
  config.harness = merge<Config['harness']>({}, config.harness)
  return config as Config & { warnings: string[] }
}

const dropNulls = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(dropNulls)
  if (!isObj(v)) return v
  return Object.fromEntries(
    Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)])
  )
}

const collapse = (p: string): string => {
  const h = home()
  if (p === h) return '~'
  if (p.startsWith(h + path.sep)) return '~/' + p.slice(h.length + 1)
  return p
}

const collapseOpt = (p: string | null): string | null => (p === null ? null : collapse(p))

const collapseIdentity = (v: RawIdentity): RawIdentity => {
  v.claude_config_dir = collapse(v.claude_config_dir)
  v.share_from = collapseOpt(v.share_from)
  v.match.paths = v.match.paths.map(collapse)
  return v
}

export const save = (config: ConfigInput, file: string = paths.config): void => {
  const { warnings: _warnings, ...rest } = config
  const out: Omit<ConfigInput, 'warnings'> = rest
  // same normalization as load(): identities saved without `match`/`keychain` still round-trip
  out.identities = Object.fromEntries(
    Object.entries(rest.identities ?? {}).map(([id, raw]) => {
      const { id: _id, ...v } = collapseIdentity(identity(id, raw))
      return [id, v] as const
    })
  )
  if (out.graft) {
    const graft = out.graft
    graft.roots = (graft.roots ?? []).map(collapse)
    graft.repos = (graft.repos ?? []).map((repo) => ({ ...repo, path: collapse(repo.path) }))
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, stringify(dropNulls(out)))
  renameSync(tmp, file)
}

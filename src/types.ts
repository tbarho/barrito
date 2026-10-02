// Shared shapes for every module. Owners may add fields; changing an existing one needs the coordinator.

import type { ExecFileSyncOptions, SpawnOptions } from 'node:child_process'
import type { TransformState, Transforms } from './router/transforms.ts'

// ── outside world ────────────────────────────────────────────────────────────

export type Exec = (file: string, args: string[], opts?: ExecFileSyncOptions) => string
export type Git = (args: string[], opts: { cwd: string }) => string | null
// subset of a ChildProcess the detached-serve path reads (fakes may return less)
export interface ChildLike {
  pid?: number
  unref?: () => void
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  exitCode?: number | null
}

export type Spawn = (cmd: string[], opts?: SpawnOptions & { detached?: boolean; env?: NodeJS.ProcessEnv }) => ChildLike
export type Clock = () => number
export type Fetch = typeof globalThis.fetch
export type Print = (line: string) => void
export type Notify = (title: string, message: string, group?: string) => void
export type Log = (line: string) => void

export interface Keychain {
  get: (service: string) => string | null
  has?: (service: string) => boolean
  set?: (service: string, value: string, opts?: { account?: string }) => void
}

// ── config ───────────────────────────────────────────────────────────────────

export interface Match {
  remotes: string[]
  paths: string[]
}

export interface Identity {
  id: string
  claude_config_dir: string
  share_from: string | null
  fallback: string[]
  match: Match
  keychain: Partial<Record<'gateway' | 'cursor', string>> & Record<string, string>
  transforms?: Partial<TransformState>
}

export interface ModelRules {
  include: string[]
  exclude: string[]
  require: string[]
  max_input_price: number | null
  pin: string[]
  labels: Record<string, string>
  suffix?: Record<string, '[1m]' | ''>
  agents: Record<string, string>
}

export interface GraftRepo {
  path: string
  summaries: boolean
}

export interface GraftConfig {
  roots: string[]
  repos: GraftRepo[]
}

export type HarnessLevel = 'full' | 'gateway' | 'env'

export interface Harness {
  name: string
  bin: string
  level: HarnessLevel
  aliases?: string[]
  env?: Record<string, string>
}

export interface Config {
  port: number
  default: string
  identities: Record<string, Identity>
  models: ModelRules
  graft: GraftConfig
  harness: Record<string, Partial<Harness>>
  transforms?: TransformState
  warnings?: string[]
}

// ── identity ─────────────────────────────────────────────────────────────────

export type Rule = 'env' | 'remote' | 'path' | 'default'

export interface Resolution {
  id: string
  rule: Rule
  detail: string | null
}

// ── project histories (<claude_config_dir>/projects/<encoded cwd>/) ─────────

export type HistoryHow = 'remote' | 'path' | 'default' | 'metadata' | 'unknown'

export interface HistoryProject {
  dir: string            // absolute project dir under the owning identity's projects/
  cwd: string            // recovered original cwd (session `cwd`, else the decoded dir name)
  sessions: number       // top-level *.jsonl files
  memory: boolean        // memory/ holds at least one entry
  from: string           // identity whose claude_config_dir holds the dir
  to: string | null      // resolved identity; null when unknown
  how: HistoryHow
}

export interface HistoryMove extends HistoryProject {
  to: string
  target: string         // <to's claude_config_dir>/projects/<dir name>
  copy: string[]         // relative files missing at the target
  same: number           // relative files already there with identical size + mtime
  conflicts: string[]    // relative files at the target that differ — never overwritten
}

// ── router / tiers ───────────────────────────────────────────────────────────

export type Tier = 'max' | 'fallback' | 'pinned'
export type Reason = 'quota' | 'outage' | 'pinned'
export type Pin = 'max' | string | null

export type Route = { to: 'direct' } | { to: 'gateway'; model: string; reason: Reason }

export type Retry =
  | { to: 'direct'; delay: number }
  | { to: 'gateway'; model: string; reason: Reason }

export interface Observation {
  to: 'direct' | 'gateway'
  model: string
  status: number
  headers: Record<string, string>
  error?: string
}

export interface TierSnapshot {
  tier: Tier
  reason: Reason | null
  model: string | null
  since: number | null
  resetAt: number | null
  util5h: number | null
  util7d: number | null
  pin: Pin
  throttled429Today: number // unconfirmed 429s passed through to Claude Code today
}

export interface Tiers {
  route: (id: string, model: string) => Route
  observe: (id: string, obs: Observation) => { retry: Retry | null }
  pin: (id: string, value: Pin) => void
  snapshot: () => Record<string, TierSnapshot>
}

export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface Price {
  input: number
  output: number
  input_cache_read: number | null
}

export interface Spend {
  record: (id: string, model: string, usage: Usage) => number
  today: () => Record<string, number>
}

export interface Upstreams {
  direct: string
  gateway: string
}

export interface Status {
  pid: number
  uptime: number
  identities: Record<string, TierSnapshot>
  spend: Record<string, number>
}

// ── catalog / models ─────────────────────────────────────────────────────────

export interface InputTier {
  cost: string
  min?: number
  max?: number
}

export interface CatalogModel {
  id: string
  name: string
  type: string
  owned_by?: string
  context_window?: number
  tags?: string[]
  pricing?: {
    input?: string
    output?: string
    input_cache_read?: string
    input_tiers?: InputTier[]
    [key: string]: unknown
  }
}

export interface PickerRow {
  model: string
  label: string
  description: string
}

// ── settings ─────────────────────────────────────────────────────────────────

export interface ClaudeSettings {
  env?: Record<string, string>
  statusLine?: { type: 'command'; command: string; padding?: number }
  modelPicker?: { options: PickerRow[] }
  [key: string]: unknown
}

// ── cli ──────────────────────────────────────────────────────────────────────

export interface Ctx {
  config: Config | null
  print: Print
  exit: (code: number) => never
}

export type Command = (argv: string[], ctx: Ctx) => Promise<void>

// every command except init: bin/barrito.ts loads the config before dispatch,
// and the exit wrapper returns after process.exit
export interface CommandCtx {
  config: Config
  print: Print
  exit: (code: number) => void
}

export type CommandFn = (argv: string[], ctx: CommandCtx) => Promise<void>

// ── router / tiers state (persisted in <statePath>/tiers.json) ─────────────────

export interface TierState {
  tier: Tier
  reason: Reason | null
  model: string | null
  since: number | null
  resetAt: number | null
  util5h: number | null
  util7d: number | null
  pin: Pin
  halfOpenAt: number | null
  backoff: number | null
  failAt: number | null
  retryDirect: boolean
}

// structural slice of Config that tiers/label read — full Config is assignable
export interface TiersConfig {
  identities?: Record<string, { fallback?: string[] }>
  models?: { labels?: Record<string, string> }
}

// ── injectable fs / fetch subsets (tests pass in-memory fakes) ────────────────

export interface Reader {
  existsSync: (file: string) => boolean
  readFileSync: (file: string, encoding: 'utf8') => string
}

export interface Fs {
  readFileSync: (file: string, encoding: 'utf8') => string
  writeFileSync: (file: string, data: string) => void
  mkdirSync: (dir: string, opts?: { recursive?: boolean }) => void
}

export interface Writer {
  mkdir: (dir: string, opts?: { recursive?: boolean }) => unknown
  writeFile: (file: string, data: string) => unknown
  rename: (from: string, to: string) => unknown
}

export interface CatalogCache {
  fetchedAt: number
  data: CatalogModel[]
}

// ── models ───────────────────────────────────────────────────────────────────

export interface TierNote {
  threshold: number | undefined
  factor: number
}

export interface Selected {
  id: string
  name: string
  price: Price | null
  tiers: TierNote | null
}

export type SelectRules = Partial<ModelRules> & { all?: boolean }

// slice of ConfigInput the models fns read — full Config is assignable
export type ModelsConfig = Pick<ConfigInput, 'identities' | 'models'>

export interface Skipped {
  id: string
  why: string
}

export interface Removed {
  id: string
  reason: 'retired' | 'rules'
}

export interface SyncDir {
  dir: string
  ok: boolean
  error?: string
  added: string[]
  removed: Removed[]
  unchanged: string[]
  updated: string[]
}

export interface SyncResult {
  added: string[]
  removed: Removed[]
  unchanged: string[]
  updated: string[]
  dirs: SyncDir[]
  missing: string[]
  protected: string[]
  skipped: Skipped[]
}

export interface Settings {
  read: (dir: string) => ClaudeSettings
  merge: (dir: string, fragment: ClaudeSettings) => ClaudeSettings
}

// ── config input (partial configs accepted by save()) ────────────────────────

export interface ConfigInput {
  port?: number
  default?: string
  identities?: Record<string, Partial<Identity>>
  models?: Partial<ModelRules>
  graft?: Partial<GraftConfig>
  harness?: Record<string, Partial<Harness>>
  transforms?: Partial<TransformState>
  warnings?: string[]
}

// ── service ──────────────────────────────────────────────────────────────────

export interface ServiceStatus {
  running: boolean
  pid: number | null
}

// ── wave 2 cli (status / doctor / statusline / serve) ────────────────────────

// FetchJson + method/body/signal: fetchJson/postJson race requests against an abort timer
export type FetchJson = (
  url: string,
  init?: { method?: string; body?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>

// loose /status payload: Status with pid/uptime nullable and per-identity snapshots partial
// (parsed JSON, any field may be absent)
export interface StatusData extends Omit<Status, 'pid' | 'uptime' | 'identities'> {
  pid: number | null
  uptime: number | null
  identities: Record<string, Partial<TierSnapshot>>
  transforms?: Record<string, StatusTransforms>
  rtk?: boolean
}

// Claude Code statusline stdin JSON
export interface StatuslineInput {
  cwd?: string
  workspace?: { current_dir?: string }
  model?: { id?: string; display_name?: string }
  rate_limits?: {
    resets_at?: string
    five_hour?: { used_percentage?: number }
    seven_day?: { used_percentage?: number }
  }
}

export interface DoctorCheck {
  level: 'ok' | 'warn' | 'fail'
  text: string
}

// ── graft ────────────────────────────────────────────────────────────────────

export type Child = ReturnType<typeof import('node:child_process').spawn>

export type RunOpts = { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv | null }
export type RunResult = string | Child

// injectable cmd runner: real impl returns stdout (sync) or the spawned child
// (detached); fakes record calls and may return void
export type GraftExec = (cmd: string[], opts?: RunOpts) => RunResult | void

export interface Run {
  (cmd: string[], opts?: RunOpts & { detached: true }): Child
  (cmd: string[], opts?: RunOpts): string
}

export interface ScanEntry {
  path: string
  remote: string
  loc: number
  partial?: true
}

export interface MissingError extends Error {
  missing: boolean
}

// structural slice of Config that graft fns accept — full Config is assignable
export interface GraftConfigSlice {
  port?: number
  default?: string
  graft?: { repos?: { path: string; summaries?: boolean }[] }
}

// ── harness builtins (indexed dynamically by name in detect/migrate) ──────────

export interface Builtin {
  bin: string
  level: HarnessLevel
  env?: Record<string, string>
  aliases?: string[]
}

export interface IdentityCacheEntry {
  top: string | null
  commonDir: string | null
  configFile: string | null
  mtimeMs: number | null
  url: string | null
  result: Resolution
  fp: string
}

export interface IdentityCache {
  get: (key: string) => IdentityCacheEntry | null
  set: (key: string, value: IdentityCacheEntry) => void
}

// ── router server (owner: A) ──────────────────────────────────────────────────

export type RawHeaders = Record<string, string | string[] | undefined>

export type UpstreamResponse = Awaited<ReturnType<Fetch>>

// structural slice of Identity the router reads — full Identity is assignable
export interface GatewayIdentity {
  id: string
  keychain?: { gateway?: string } & Record<string, string>
}

// structural slice of Config the router reads — full Config is assignable
export interface RouterConfig {
  identities: Record<string, GatewayIdentity>
}

export interface Keys {
  get: (identity: GatewayIdentity) => string | null
  bust: (identity: GatewayIdentity) => void
}

export interface SendOpts {
  headers: RawHeaders
  body?: Buffer
  key?: string
  keys: Keys
  identity: GatewayIdentity
  keyHeader: string
  signal: AbortSignal
}

// one upstream hop outcome: missing key | upstream answered | connect error
export type Attempt =
  | { missing: true; up?: undefined; error?: undefined }
  | { up: UpstreamResponse; missing?: false; error?: undefined }
  | { error: Error; up?: undefined; missing?: false }

export interface LineInfo {
  id?: string
  method?: string
  path: string
  model?: string
  to?: string
  reason?: string
  status: number
  transforms?: string
}

export interface Parsed {
  [key: string]: unknown
}

export interface Meter {
  push: (chunk: Buffer, sse: boolean) => void
  done: (sse: boolean) => Usage | null
}

export interface StartOpts {
  config: RouterConfig
  port: number
  tiers: RouterTiers
  spend: Spend
  keychain: Keychain
  log: Log
  upstreams: Upstreams
  transforms?: Transforms
  maxBody?: number
}

// Tiers whose snapshot may return partial entries (the router only reads what it needs);
// a real Tiers is still assignable — full TierSnapshot satisfies Partial<TierSnapshot>
export type RouterTiers = Omit<Tiers, 'snapshot'> & { snapshot: () => Record<string, Partial<TierSnapshot>> }

// ── transforms (rtk tool-output compression + caveman replies) ─────────────────
// shapes owned by src/router/transforms.ts; re-exported here for every non-router module

export type { Applied, Caveman, TransformState, Transforms } from './router/transforms.ts'

// one identity's /status transform entry: its state plus bytes/compressions saved today
export interface StatusTransforms {
  state: TransformState
  saved: number
  compressed: number
}

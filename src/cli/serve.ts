import { parseArgs } from 'node:util'
import { spawn as cpSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { paths } from '../paths.ts'
import * as keychain from '../keychain/index.ts'
import * as tiers from '../router/tiers.ts'
import * as spend from '../router/spend.ts'
import * as transforms from '../router/transforms.ts'
import { notify } from '../router/notify.ts'
import * as catalog from '../catalog.ts'
import { start as startServer } from '../router/server.ts'
import { create as createLog } from '../log.ts'
import { tail } from './logs.ts'
import type { CommandCtx, Config, Exec, FetchJson, Keychain, Log, Spawn, Spend, Tiers, TransformState, Transforms, Upstreams } from '../types.ts'

const DAY = 86400e3

export interface StartArgs {
  config: Config
  port: number
  tiers: Tiers
  spend: Spend
  keychain: Keychain
  log: Log
  upstreams: Upstreams
  transforms: Transforms
}

export interface ServerLike {
  listen: (port: number, host: string, cb?: () => void) => unknown
  close: (cb?: () => void) => unknown
  closeIdleConnections?: () => void
}

export interface ServeOpts {
  statePath?: string
  keychain?: Keychain
  refresh?: () => Promise<void>
  fetch?: FetchJson
  start?: (args: StartArgs) => Promise<ServerLike> | ServerLike
  upstreams?: Upstreams
  transforms?: Transforms
  on?: (sig: 'SIGTERM' | 'SIGINT', fn: () => void) => void
  exit?: (code: number) => void
  // detached mode
  spawn?: Spawn
  bin?: string
  node?: string
  env?: NodeJS.ProcessEnv
  alive?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
  tries?: number
}

// ── pidfile: the router itself owns it — a stale or foreign pid is never trusted ──

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const pidfile = (statePath: string): string => path.join(statePath, 'barrito.pid')

const writePidfile = (statePath: string, port: number): void => {
  mkdirSync(statePath, { recursive: true })
  writeFileSync(pidfile(statePath), `${JSON.stringify({ pid: process.pid, port, startedAt: Date.now(), token: randomUUID() })}\n`)
}

const readPid = (file: string): { pid: number; port: number } | null => {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const pid = (raw as { pid?: unknown }).pid
  const port = (raw as { port?: unknown }).port
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 2) return null // 0/-1/non-integer is stale, never a target
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1) return null
  return { pid, port }
}

// identity proof: only a process answering /status with the pidfile's pid is our router
const statusPid = async (fetch: FetchJson, port: number): Promise<number | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    if (!res.ok) return null
    const data = await res.json()
    if (typeof data !== 'object' || data === null) return null
    const pid = (data as { pid?: unknown }).pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

// ── detached mode: spawn `barrito serve` in the background, wait for its pidfile ──

// [transforms] defaults + per-identity overrides resolve per identity for the transforms module
export const transformDefaults = (config: Config): ((identityId: string) => TransformState) => {
  const global = config.transforms
  return (identityId: string): TransformState => {
    const over = config.identities[identityId]?.transforms ?? {}
    return {
      rtk: over.rtk ?? global?.rtk ?? true,
      caveman: over.caveman ?? global?.caveman ?? 'lite',
    }
  }
}

const spawnDefault: Spawn = (cmd, opts = {}) => {
  const [bin, ...rest] = cmd
  if (!bin) throw new Error('serve: empty command')
  return cpSpawn(bin, rest, opts)
}

const defaultFetch: FetchJson = (url, init) => globalThis.fetch(url, init)

// a reaped-never child (no init in a container) still answers kill(0); /proc says it's a zombie
const zombie = (pid: number): boolean => {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') ?? false } catch { return false }
}

export const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0) } catch { return false }
  return !zombie(pid)
}

const aliveDefault = isAlive

export interface DetachOpts {
  config: Config
  port?: number
  exec?: Exec
  spawn?: Spawn
  fetch?: FetchJson
  statePath?: string
  logFile?: string
  bin?: string
  node?: string
  env?: NodeJS.ProcessEnv
  alive?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
  tries?: number
}

export interface Detached {
  pid: number
  port: number
  existing: boolean
}

export const startDetached = async (o: DetachOpts): Promise<Detached> => {
  const port = Number(o.port ?? process.env.BARRITO_PORT ?? o.config.port)
  const statePath = o.statePath ?? paths.state
  const file = pidfile(statePath)
  const health = o.fetch ?? defaultFetch
  const alive = o.alive ?? aliveDefault

  const prior = readPid(file)
  if (prior && alive(prior.pid) && (await statusPid(health, prior.port)) === prior.pid) {
    return { pid: prior.pid, port: prior.port, existing: true }
  }
  rmSync(file, { force: true }) // missing, stale, or foreign — the child writes a fresh one

  const logs = o.logFile ?? paths.logs
  mkdirSync(path.dirname(logs), { recursive: true })
  const out = openSync(logs, 'a')
  const run = o.spawn ?? spawnDefault
  const child = run([o.node ?? process.execPath, o.bin ?? process.argv[1] ?? 'barrito', 'serve'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...o.env, BARRITO_PORT: String(port) },
  })
  closeSync(out)
  const pid = child.pid
  if (typeof pid !== 'number') throw new Error('serve: detached spawn returned no pid')
  child.unref?.()

  const wait = o.wait ?? sleep
  for (let i = 0; i < (o.tries ?? 100); i++) {
    const code = child.exitCode
    if (typeof code === 'number') throw new Error(`barrito: router exited early with code ${code} — log: ${logs}`)
    const pf = readPid(file)
    if (pf && pf.pid === pid && (await statusPid(health, pf.port)) === pid) return { pid, port: pf.port, existing: false }
    await wait(50)
  }
  throw new Error(`barrito: router did not answer /status within 5s (pid ${pid}) — log: ${logs}`)
}

export interface StopOpts {
  statePath?: string
  fetch?: FetchJson
  kill?: (pid: number, sig?: string | number) => void
  alive?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
}

// signal only a router we proved via /status; SIGTERM, ≤3s, SIGKILL, drop the pidfile
export const stopDetached = async ({ statePath, fetch, kill, alive, wait }: StopOpts = {}): Promise<boolean> => {
  const file = pidfile(statePath ?? paths.state)
  const prior = readPid(file)
  if (!prior) {
    if (existsSync(file)) rmSync(file, { force: true }) // unreadable or invalid (pid 0/-1) — clean it, signal nothing
    return false
  }
  const gone = alive ?? aliveDefault
  const health = fetch ?? defaultFetch
  if (!gone(prior.pid) || (await statusPid(health, prior.port)) !== prior.pid) {
    rmSync(file, { force: true }) // stale, or an unrelated process that recycled the pid — never signal it
    return false
  }

  const stop = kill ?? ((pid: number, sig?: string | number): void => { process.kill(pid, (sig ?? 'SIGTERM') as NodeJS.Signals) })
  const pause = wait ?? sleep
  stop(prior.pid, 'SIGTERM')
  for (let i = 0; i < 60 && gone(prior.pid); i++) await pause(50)
  if (gone(prior.pid)) stop(prior.pid, 'SIGKILL')
  rmSync(file, { force: true })
  return true
}

export default async (argv: string[], ctx: CommandCtx, opts: ServeOpts = {}): Promise<void> => {
  const config = ctx.config
  const port = Number(process.env.BARRITO_PORT ?? config.port)
  const { values } = parseArgs({ args: argv, options: { detach: { type: 'boolean' } } })

  if (values.detach) {
    try {
      const r = await startDetached({
        config,
        port,
        spawn: opts.spawn,
        fetch: opts.fetch,
        statePath: opts.statePath,
        bin: opts.bin,
        node: opts.node,
        env: opts.env,
        alive: opts.alive,
        wait: opts.wait,
        tries: opts.tries,
      })
      ctx.print(r.existing
        ? `barrito already running on http://127.0.0.1:${r.port} (pid ${r.pid})`
        : `barrito listening on http://127.0.0.1:${r.port} (pid ${r.pid})`)
      return ctx.exit(0)
    } catch (err) {
      ctx.print(`barrito: ${err instanceof Error ? err.message : String(err)}`)
      ;(tail(paths.logs, 10) ?? []).forEach((l) => ctx.print(l))
      return ctx.exit(1)
    }
  }

  const statePath = opts.statePath ?? paths.state
  const log = createLog({ file: paths.logs })
  const t = tiers.create({ config, statePath, notify })
  const s = spend.create({
    prices: (id: string) => catalog.price(catalog.cached({ statePath }) || [], id),
    statePath,
  })
  const tx = opts.transforms ?? transforms.create({ defaults: transformDefaults(config), statePath })
  const kc = opts.keychain ?? keychain

  // refresh the catalog once a day with the first identity's gateway key; never crash the router
  const daily = opts.refresh ?? (async () => {
    const first = Object.values(config.identities ?? {})[0]
    const key = first?.keychain?.gateway ? kc.get(first.keychain.gateway) : null
    await catalog.refresh({ key: key ?? undefined, statePath, fetch: opts.fetch })
  })

  const start = opts.start ?? startServer
  const server = await start({
    config,
    port,
    tiers: t,
    spend: s,
    keychain: kc,
    log,
    transforms: tx,
    upstreams: opts.upstreams ?? {
      direct: process.env.BARRITO_DIRECT || 'https://api.anthropic.com',
      gateway: process.env.BARRITO_GATEWAY || 'https://ai-gateway.vercel.sh',
    },
  })

  daily().catch(() => {})
  const timer = setInterval(() => daily().catch(() => {}), DAY)
  timer.unref?.()

  const on = opts.on ?? ((sig, fn) => process.on(sig, fn))
  const exit = opts.exit ?? ctx.exit
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    server.closeIdleConnections?.()
    server.close(() => {
      rmSync(pidfile(statePath), { force: true }) // ours: we wrote it on listening
      exit(0)
    })
  }
  on('SIGTERM', stop)
  on('SIGINT', stop)

  server.listen(port, '127.0.0.1', () => {
    writePidfile(statePath, port)
    ctx.print(`barrito listening on http://127.0.0.1:${port}`)
  })
}

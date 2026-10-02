import { parseArgs } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { appendFileSync } from 'node:fs'
import * as config from '../config.ts'
import { home as homeDir } from '../paths.ts'
import { builtins } from '../harnesses.ts'
import { writeShims } from './shim.ts'
import { default as statusCmd } from './status.ts'
import { startDetached, stopDetached } from './serve.ts'
import type { CommandCtx, Config, ConfigInput } from '../types.ts'

export interface Flags {
  identity: string
  gatewayKey: string
  fallback: string[]
  port: number | null
  config: string | null
  stop: boolean
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export const flags = (argv: string[]): Flags => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      identity: { type: 'string' },
      'gateway-key': { type: 'string' },
      fallback: { type: 'string', multiple: true },
      port: { type: 'string' },
      config: { type: 'string' },
    },
  })
  if (positionals.length && positionals[0] !== 'stop') throw new Error('usage: barrito ci [--identity …] [--gateway-key env:…] [--fallback …] [--port …] [--config <file>] | barrito ci stop')
  const port = values.port == null ? null : Number(values.port)
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`--port must be an integer between 1 and 65535, got "${values.port}"`)
  const identity = values.identity ?? 'ci'
  if (!ID.test(identity)) throw new Error(`--identity "${identity.replaceAll('\n', '\\n')}" must match ${ID} (letters, digits, _ -, max 64 chars) — newlines are never allowed`)
  return {
    identity,
    gatewayKey: values['gateway-key'] ?? 'env:AI_GATEWAY_API_KEY',
    fallback: (values.fallback ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean),
    port,
    config: values.config ?? null,
    stop: positionals[0] === 'stop',
  }
}

// keyring item names can't resolve on a CI runner — only env:/file: refs survive
export const build = (f: Flags, { home = homeDir() }: { home?: string } = {}): ConfigInput => {
  if (!(f.gatewayKey.startsWith('env:') || f.gatewayKey.startsWith('file:'))) {
    throw new Error(`--gateway-key "${f.gatewayKey}" is a keyring item name — CI has no keyring; use env:VAR or file:/path, e.g. --gateway-key env:AI_GATEWAY_API_KEY`)
  }
  return {
    port: f.port ?? 4141,
    default: f.identity,
    identities: {
      [f.identity]: {
        claude_config_dir: path.join(home, '.claude'),
        fallback: f.fallback,
        keychain: { gateway: f.gatewayKey },
      },
    },
  }
}

const keyring = (cfg: Config, file: string): void => {
  const bad = Object.entries(cfg.identities).find(([, v]) => v.keychain.gateway != null && !/^(env:|file:)/.test(v.keychain.gateway ?? ''))
  if (!bad) return
  const [id, v] = bad
  throw new Error(`config ${file}: identities.${id}.keychain.gateway "${v.keychain.gateway}" is a keyring item name — CI has no keyring; use env:VAR or file:/path`)
}

export const envLines = (x: { config: string; state: string; shims: string; log: string; identity: string }): string[] => [
  `BARRITO_CONFIG=${x.config}`,
  `BARRITO_STATE=${x.state}`,
  `BARRITO_SHIMS=${x.shims}`,
  `BARRITO_LOG=${x.log}`,
  `BARRITO_IDENTITY=${x.identity}`,
]

// GITHUB_ENV/GITHUB_PATH files are line-oriented: a CR or LF in any value would inject a new variable
const guard = (label: string, v: string): string => {
  if (/[\r\n]/.test(v)) throw new Error(`${label} contains a newline — refusing to write it to the GitHub Actions environment`)
  return v
}

const chain = (fallback: string[]): string => fallback.length ? fallback.join(', ') : 'none'

export interface StartArgs {
  config: Config
  port: number
  statePath?: string
  logFile?: string
  env?: NodeJS.ProcessEnv
}

export interface CiOpts {
  env?: NodeJS.ProcessEnv
  tmp?: string
  home?: string
  shims?: typeof writeShims
  status?: (argv: string[], ctx: CommandCtx) => Promise<void>
  start?: (args: StartArgs) => Promise<{ pid: number; port: number }>
  stop?: (args: { statePath: string }) => Promise<boolean>
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ci stop never fails the job: summary + stop errors become warnings, exit 0
const teardown = async (ctx: CommandCtx, { env, status, stop, statePath }: { env: NodeJS.ProcessEnv; status: (argv: string[], ctx: CommandCtx) => Promise<void>; stop: (args: { statePath: string }) => Promise<boolean>; statePath: string }): Promise<void> => {
  const lines: string[] = []
  try {
    await status(['--markdown'], {
      config: ctx.config,
      print: (s: string) => { lines.push(s); ctx.print(s) },
      exit: (code: number) => { throw new Error(`status exited ${code}`) },
    })
  } catch (err) {
    ctx.print(`barrito: warning: status failed — ${msg(err)}`)
  }
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n\n`)
    } catch (err) {
      ctx.print(`barrito: warning: could not write the step summary — ${msg(err)}`)
    }
  }
  try {
    if (await stop({ statePath })) return
    ctx.print('barrito: warning: ci router was not running')
  } catch (err) {
    ctx.print(`barrito: warning: could not stop the ci router — ${msg(err)}`)
  }
}

export default async (argv: string[], ctx: CommandCtx, opts: CiOpts = {}): Promise<void> => {
  const env = opts.env ?? process.env
  const f = flags(argv)
  const base = env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, 'barrito') : path.join(opts.tmp ?? os.tmpdir(), 'barrito-ci')
  const dirs = {
    config: f.config ?? path.join(base, 'config.toml'),
    state: path.join(base, 'state'),
    shims: path.join(base, 'shims'),
    log: path.join(base, 'barrito.log'),
  }
  if (f.stop) {
    const stop = opts.stop ?? ((args: { statePath: string }) => stopDetached(args))
    await teardown(ctx, { env, status: opts.status ?? statusCmd, stop, statePath: dirs.state })
    return
  }

  // nothing below may write before these checks pass
  guard('the shims dir', dirs.shims)
  envLines({ ...dirs, identity: f.identity }).forEach((l) => guard('a BARRITO_* value', l))

  let cfg: Config
  if (f.config) {
    cfg = config.load(f.config)
    keyring(cfg, f.config)
  } else {
    config.save(build(f, { home: opts.home ?? homeDir() }), dirs.config)
    cfg = config.load(dirs.config)
  }

  const names = [...new Set([...Object.keys(builtins), ...Object.keys(cfg.harness)])]
  const shims = (opts.shims ?? writeShims)({ config: cfg, harnesses: names, dir: dirs.shims, force: false, print: ctx.print })
  if (shims.refused.length) {
    shims.refused.forEach((file) => console.error(`barrito: refusing to overwrite ${file} (not generated by barrito)`))
    return ctx.exit(1)
  }

  const gha = env.GITHUB_ACTIONS === 'true'
  if (gha && env.GITHUB_PATH) appendFileSync(env.GITHUB_PATH, `${dirs.shims}\n`)
  else ctx.print(`export PATH=${JSON.stringify(dirs.shims)}:$PATH`)
  const lines = envLines({ ...dirs, identity: f.identity })
  if (gha && env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `${lines.join('\n')}\n`)
  else lines.forEach((l) => ctx.print(`export ${JSON.stringify(l)}`))

  // the router must write state and logs under RUNNER_TEMP, not the runner's HOME
  const start: (args: StartArgs) => Promise<{ pid: number; port: number }> = opts.start ?? startDetached
  const { pid: _pid, port: live } = await start({
    config: cfg,
    port: f.port ?? cfg.port,
    statePath: dirs.state,
    logFile: dirs.log,
    env: {
      BARRITO_CONFIG: dirs.config,
      BARRITO_STATE: dirs.state,
      BARRITO_LOG: dirs.log,
      BARRITO_SHIMS: dirs.shims,
    },
  })

  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    ctx.print(`::notice::CLAUDE_CODE_OAUTH_TOKEN not set — Claude Code will run on the gateway only (fallback ${chain(f.fallback)}) — no Max`)
  }
  ctx.print(`barrito ci ready · identity ${f.identity} · fallback ${chain(f.fallback)} · http://127.0.0.1:${live}`)
}

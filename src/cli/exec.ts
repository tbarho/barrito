import { spawn } from 'node:child_process'
import { paths } from '../paths.ts'
import { resolve } from '../identity.ts'
import { builtins, find, envFor, realBin } from '../harnesses.ts'
import type { CommandFn, CommandCtx, Harness } from '../types.ts'

const sigCode: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGTERM: 15 }

export default (async (argv: string[], ctx: CommandCtx): Promise<void> => {
  // a single leading -- after the bin is a pass-through marker, not an arg (`barrito exec claude -- -p x`)
  const [bin, ...raw] = argv
  const rest = raw[0] === '--' ? raw.slice(1) : raw
  if (!bin) {
    console.error('usage: barrito exec <bin> [--] [args…]')
    return ctx.exit(2)
  }

  const config = ctx.config
  const names = [...Object.keys(builtins), ...Object.keys(config.harness ?? {})]
  const harness: Harness = names.map((n) => find(n, config)).find((h) => h?.bin === bin) ?? { name: bin, bin, level: 'gateway', env: {} }

  const r = resolve(process.cwd(), { config })
  const identity = config.identities?.[r.id]
  if (!identity || (harness.level === 'full' && !identity.claude_config_dir)) {
    console.error(`barrito: unknown identity "${r.id}" — run barrito doctor`)
    return ctx.exit(2)
  }

  const real = realBin(bin)
  if (!real) {
    console.error(`barrito: no real "${bin}" on PATH outside the shim dir (${paths.shims}); install it or check PATH order with: barrito doctor`)
    return ctx.exit(127)
  }

  const child = spawn(real, rest, { stdio: 'inherit', env: { ...process.env, ...envFor(harness, identity, { config }) } })
  ;(['SIGINT', 'SIGTERM'] as const).forEach((sig) => process.on(sig, () => child.kill(sig as NodeJS.Signals)))

  const code = await new Promise<number>((done) => {
    child.on('exit', (c, signal) => done(c ?? (signal ? 128 + (sigCode[signal] ?? 0) : 1)))
    child.on('error', (err) => {
      console.error(`barrito: ${err.message}`)
      done(127)
    })
  })
  ctx.exit(code)
}) satisfies CommandFn

import { parseArgs } from 'node:util'
import { paths } from '../paths.ts'
import { resolve, peek } from '../identity.ts'
import { find, envFor, realBin } from '../harnesses.ts'
import type { CommandFn, CommandCtx } from '../types.ts'

const quote = (v: string): string => `'${String(v).replaceAll("'", "'\\''")}'`

export default (async (argv: string[], ctx: CommandCtx): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { shell: { type: 'boolean' }, harness: { type: 'string' }, self: { type: 'string' } },
  })
  const cwd = positionals[0] ?? process.cwd()
  const config = ctx.config
  const shell = values.shell
  const fail = (code: number, msg: string): void => {
    console.error(msg)
    if (shell) ctx.print(`exit ${code}`) // so `eval "$(barrito env --shell …)"` exits too
    return ctx.exit(code)
  }

  const name = values.harness ?? 'claude'
  const harness = find(name, config)
  if (!harness) return fail(2, `barrito: unknown harness "${name}"`)

  const r = resolve(cwd, { config })
  const identity = config.identities?.[r.id]
  if (!identity || (harness.level === 'full' && !identity.claude_config_dir)) {
    return fail(2, `barrito: unknown identity "${r.id}" — run barrito doctor`)
  }

  const real = realBin(harness.bin, { self: values.self })
  if (!real) {
    return fail(127, `barrito: no real "${harness.bin}" on PATH outside the shim dir (${paths.shims}); install it or check PATH order with: barrito doctor`)
  }

  const env: Record<string, string> = { ...envFor(harness, identity, { config }), BARRITO_REAL_BIN: real }
  if (process.env.BARRITO_DEBUG === '1') {
    console.error(`barrito: ${r.id} ← ${r.rule} ${r.detail}`)
    console.error(`barrito: ${Object.keys(env).sort().map((k) => `${k}=<redacted:${String(env[k]).length}>`).join(' ')}`)
  }

  const out = Object.keys(env)
    .sort()
    .map((k) => (shell ? `export ${k}=${quote(env[k]!)}` : `${k}=${env[k]}`))
    .join('\n')
  if (out) ctx.print(out)

  try {
    const graft = await import('../graft.ts')
    if (!graft.ensure) return
    const entry = peek(cwd, { config })
    graft.ensure(cwd, {
      config,
      ...(entry && { git: () => (entry.top ? `${entry.top}\n${entry.commonDir}` : null) }),
    })
  } catch {}
}) satisfies CommandFn

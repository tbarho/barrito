import { parseArgs } from 'node:util'
import { resolve } from '../identity.ts'
import type { CommandCtx, CommandFn } from '../types.ts'

export default (async (argv: string[], ctx: CommandCtx): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  })
  const r = resolve(positionals[0] ?? process.cwd(), { config: ctx.config })
  if (values.json) return ctx.print(JSON.stringify(r))
  const wording = {
    env: 'env BARRITO_IDENTITY',
    remote: `remote ${r.detail}`,
    path: `path ${r.detail}`,
    default: 'default',
  }[r.rule]
  ctx.print(`${r.id}  ← ${wording}`)
}) satisfies CommandFn

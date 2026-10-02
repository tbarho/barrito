import { parseArgs } from 'node:util'
import { base, postJson } from './status.ts'
import type { CommandCtx } from '../types.ts'

export default async (argv: string[], ctx: CommandCtx): Promise<void> => {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true })
  const [id] = positionals
  if (!id) {
    console.error('usage: barrito unpin <identity>')
    return ctx.exit(2)
  }
  if (!ctx.config?.identities?.[id]) {
    console.error(`barrito: unknown identity "${id}" — have: ${Object.keys(ctx.config?.identities ?? {}).join(', ')}`)
    return ctx.exit(2)
  }

  const res = await postJson(`${base(ctx.config)}/pin`, { identity: id, value: null })
  if (!res) {
    console.error('router not running — barrito doctor')
    return ctx.exit(1)
  }
  if (res.status !== 200) {
    console.error(`barrito: router rejected the unpin (${res.status})`)
    return ctx.exit(1)
  }
  ctx.print(`unpinned ${id}`)
}

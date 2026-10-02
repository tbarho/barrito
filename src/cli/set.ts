import { parseArgs } from 'node:util'
import { base, postJson } from './status.ts'
import type { CommandCtx, TransformState } from '../types.ts'

const CAVEMAN = ['off', 'lite', 'full', 'ultra']
const USAGE = 'usage: barrito set <identity> [rtk on|off] [caveman off|lite|full|ultra] [--reset]'

const render = (state: TransformState): string =>
  [`rtk ${state.rtk ? 'on' : 'off'}`, `caveman ${state.caveman}`].join(' · ')

export default async (argv: string[], ctx: CommandCtx): Promise<void> => {
  const { positionals, values } = parseArgs({ args: argv, options: { reset: { type: 'boolean' } }, allowPositionals: true })
  const [id, ...rest] = positionals
  if (!id) {
    console.error(USAGE)
    return ctx.exit(2)
  }
  const identity = ctx.config?.identities?.[id]
  if (!identity) {
    console.error(`barrito: unknown identity "${id}" — have: ${Object.keys(ctx.config?.identities ?? {}).join(', ')}`)
    return ctx.exit(2)
  }

  const patch: { rtk?: boolean; caveman?: string } = {}
  for (let i = 0; i < rest.length; i += 2) {
    const [key, value] = [rest[i], rest[i + 1]]
    if (key === 'rtk' && (value === 'on' || value === 'off')) {
      patch.rtk = value === 'on'
      continue
    }
    if (key === 'caveman' && value !== undefined && CAVEMAN.includes(value)) {
      patch.caveman = value
      continue
    }
    console.error(USAGE)
    return ctx.exit(2)
  }

  const res = await postJson(`${base(ctx.config)}/transforms`, {
    identity: id,
    rtk: patch.rtk,
    caveman: patch.caveman,
    reset: values.reset || undefined,
  })
  if (!res) {
    console.error('router not running — barrito doctor')
    return ctx.exit(1)
  }
  if (res.status !== 200) {
    console.error(`barrito: router rejected the set (${res.status})`)
    return ctx.exit(1)
  }
  const state = (res.data as { state?: TransformState } | null)?.state
  if (!state) {
    console.error('barrito: router did not answer with a transform state')
    return ctx.exit(1)
  }
  ctx.print(`${id} → ${render(state)}`)
}

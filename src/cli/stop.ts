import { execFileSync } from 'node:child_process'
import { platform } from '../paths.ts'
import * as service from '../service/index.ts'
import { stopDetached } from './serve.ts'
import type { CommandCtx, Exec, FetchJson } from '../types.ts'

export interface StopOpts {
  stop?: typeof stopDetached
  exec?: Exec
  fetch?: FetchJson
}

export default async (argv: string[], ctx: CommandCtx & { io?: { exec?: Exec } }, opts: StopOpts = {}): Promise<void> => {
  // a service-manager router is not ours to kill (Restart=always would just bring it back) — check first
  const exec = opts.exec ?? ctx.io?.exec ?? ((bin: string, args: string[]): string => execFileSync(bin, args, { encoding: 'utf8' }))
  const svc = service.status({ exec })
  if (svc.running) {
    const how = platform() === 'linux'
      ? 'systemctl --user stop barrito'
      : `launchctl bootout gui/${process.getuid!()}/${service.label}`
    ctx.print(`barrito runs as a system service — stop it with \`barrito uninstall\`, or \`${how}\``)
    return ctx.exit(1)
  }

  const stopped = await (opts.stop ?? stopDetached)({ fetch: opts.fetch })
  if (stopped) {
    ctx.print('barrito stopped')
    return ctx.exit(0)
  }

  ctx.print('no barrito router is running')
  return ctx.exit(0)
}

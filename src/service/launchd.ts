import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { root } from '../paths.ts'
import type { Exec, ServiceStatus } from '../types.ts'

export const uid = (): number => process.getuid!()

export const run = (exec: Exec | undefined, args: string[]): string => {
  if (exec) return exec('/bin/launchctl', args, { encoding: 'utf8' })
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8' })
}

const esc = (s: unknown): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const render = ({ node = process.execPath, bin, port, logs, pathEnv = process.env.PATH || '' }: {
  node?: string | null
  bin?: string
  port?: number
  logs?: string
  pathEnv?: string
}): string => {
  if (!node || !bin) throw new Error('service: install needs the node binary and the barrito bin path (node + bin)')
  return readFileSync(path.join(root(), 'templates', 'router.plist'), 'utf8')
    .replaceAll('__NODE__', esc(node))
    .replaceAll('__BIN__', esc(bin))
    .replaceAll('__PORT__', esc(port))
    .replaceAll('__LOGS__', esc(logs))
    .replaceAll('__PATH__', esc(`${path.dirname(node)}:${pathEnv}`))
}

export const parse = (out: string): ServiceStatus => ({
  running: /^\s*state = running\b/m.test(out),
  pid: Number((out.match(/^\s*pid = (\d+)/m) || [])[1]) || null,
})

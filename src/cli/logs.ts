import { parseArgs } from 'node:util'
import fs from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { paths } from '../paths.ts'
import type { CommandCtx } from '../types.ts'

export const tail = (file: string, n: number): string[] | null => {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  return (lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines).slice(-n)
}

export interface LogsOpts {
  watch?: (dir: string, cb: () => void) => { close?: () => void }
  on?: (sig: 'SIGINT' | 'SIGTERM', fn: () => void) => void
  interval?: number
  write?: (s: string) => void
}

// print bytes appended to `file` forever (rotation-safe); returns a stop() handle
export const follow = (
  file: string,
  { print = (s) => process.stdout.write(s), watch = (dir, cb) => fs.watch(dir, cb), interval = 500 }: {
    print?: (s: string) => void
    watch?: (dir: string, cb: () => void) => { close?: () => void }
    interval?: number
  } = {},
): () => void => {
  let size = 0
  try { size = fs.statSync(file).size } catch {}

  const dump = () => {
    let st: Stats
    try { st = fs.statSync(file) } catch { return }
    if (st.size < size) size = 0 // rotated
    if (st.size <= size) return
    let out = ''
    try {
      const buf = Buffer.alloc(st.size - size)
      const fh = fs.openSync(file, 'r')
      try {
        fs.readSync(fh, buf, 0, buf.length, size)
        out = buf.toString('utf8')
      } finally {
        fs.closeSync(fh)
      }
    } catch {}
    size = st.size
    if (out) print(out)
  }

  const watcher = watch(path.dirname(file), () => dump())
  const timer = setInterval(dump, interval)
  timer.unref?.()
  return () => {
    watcher?.close?.()
    clearInterval(timer)
  }
}

export default async (argv: string[], ctx: CommandCtx, { watch, on = (sig, fn) => process.on(sig, fn), interval, write }: LogsOpts = {}): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { f: { type: 'boolean' }, n: { type: 'string', default: '50' } },
  })
  const file = paths.logs
  const n = Math.max(0, Number(values.n) || 50)
  const lines = tail(file, n)
  if (lines === null) {
    console.error(`barrito: no logs yet at ${file} — is the router running?`)
    return ctx.exit(1)
  }
  lines.forEach((l) => ctx.print(l))
  if (!values.f) return

  const stop = follow(file, { print: write ?? ((s) => process.stdout.write(s)), watch, interval })
  const quit = () => {
    stop()
    ctx.exit(0)
  }
  on('SIGINT', quit)
  on('SIGTERM', quit)
  await new Promise(() => {})
}

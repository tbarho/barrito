#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { load } from '../src/config.ts'
import { root } from '../src/paths.ts'
import { usage } from '../src/usage.ts'
import type { Command, CommandFn } from '../src/types.ts'

const commands = Object.keys(usage)

const help = (): void => {
  console.log(`barrito — one router, every identity

usage: barrito <command> [args]

commands:
  ${commands.join('  ')}

run \`barrito <command> --help\` for details`)
}

const main = async (): Promise<void> => {
  const [name, ...argv] = process.argv.slice(2)
  if (!name || name === '--help' || name === '-h') {
    help()
    return
  }
  if (name === '--version' || name === '-v') {
    const pkg = JSON.parse(readFileSync(path.join(root(), 'package.json'), 'utf8')) as { version?: string }
    console.log(pkg.version)
    return
  }
  if (!commands.includes(name)) {
    console.error(`barrito: unknown command "${name}"`)
    help()
    process.exit(2)
  }
  // per-command help answers before config load or command import (parseArgs never sees it)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage[name])
    return
  }
  const print = (s: string): void => { process.stdout.write(`${s}\n`) }
  const exit = (code: number): never => { process.exit(code) }
  // import as .ts when running this file directly, .js when running the build
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  if (name === 'init') {
    const mod = await import(new URL(`../src/cli/${name}${ext}`, import.meta.url).href)
    const cmd = mod as { default: Command }
    await cmd.default(argv, { config: null, print, exit })
    return
  }
  const config = load()
  const mod = await import(new URL(`../src/cli/${name}${ext}`, import.meta.url).href)
  const cmd = mod as { default: CommandFn }
  await cmd.default(argv, { config, print, exit })
}

main().catch((err: unknown) => {
  console.error(`barrito: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

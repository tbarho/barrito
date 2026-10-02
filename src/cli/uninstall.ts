import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { paths, home, platform } from '../paths.ts'
import * as service from '../service/index.ts'
import * as settings from '../settings.ts'
import { restore, latest } from '../backup.ts'
import * as keychain from '../keychain/index.ts'
import { unwrapStatusline, short, stripRcBlock } from '../migrate.ts'
import { marker, rcOf } from '../detect.ts'
import { create, prompts } from '../ui.ts'
import type { Ui } from '../ui.ts'
import type { Config, Ctx, Exec, Identity } from '../types.ts'

type Loose = { port?: number; identities?: Record<string, Identity> }

const shims = (dir: string): void => {
  if (!fs.existsSync(dir)) return
  fs.readdirSync(dir).forEach((name) => {
    const file = path.join(dir, name)
    // ours = generated content, or a symlink (agent → cursor-agent) resolving to it
    try {
      const target = fs.lstatSync(file).isSymbolicLink() ? path.resolve(dir, fs.readlinkSync(file)) : file
      if (fs.readFileSync(target, 'utf8').includes(marker)) fs.rmSync(file, { force: true })
    } catch {}
  })
}

// only the keys barrito owns: the base URL if it points at our port, the statusline
// if it's ours (a wrapped one is unwrapped back to the original, not dropped)
const cleanSettings = (identity: Identity, config: Loose, ui: Ui): void => {
  const dir = identity.claude_config_dir
  if (!fs.existsSync(path.join(dir, 'settings.json'))) return
  const current = settings.read(dir)
  const keys: string[] = []
  if (current.env?.ANTHROPIC_BASE_URL === `http://127.0.0.1:${config.port}`) keys.push('env.ANTHROPIC_BASE_URL')
  const wrapped = unwrapStatusline(current.statusLine?.command)
  if (current.statusLine?.command === 'barrito statusline') keys.push('statusLine')
  if (wrapped) settings.merge(dir, { statusLine: { type: 'command', command: wrapped } })
  if (keys.length) settings.remove(dir, keys)
  fs.rmSync(path.join(dir, 'commands', 'barrito.md'), { force: true })
  ui.item(ui.c.red('-'), `cleaned barrito keys from ${short(dir)}/settings.json`)
}

export default async (argv: string[], ctx: Ctx & { io?: { exec?: Exec } }): Promise<void> => {
  const { values } = parseArgs({ args: argv, options: { restore: { type: 'boolean' }, yes: { type: 'boolean' } } })
  const deps = { exec: (bin: string, args: string[]): string => execFileSync(bin, args, { encoding: 'utf8' }), ...ctx.io }
  const config: Config | Loose = ctx.config ?? {}

  const ui = create({ print: ctx.print })
  ui.intro('barrito uninstall')
  if (!values.yes) {
    const message = values.restore
      ? 'remove barrito and put the backed-up setup back?'
      : 'remove barrito (service, shims, settings fragments)?'
    const go = await prompts(ui, 'aborted').confirm(message)
    ui.section('Confirm')
    ui.answered(message, go ? 'Yes' : 'No')
    if (!go) {
      ui.outro('aborted — nothing removed')
      return ctx.exit(1)
    }
  }

  ui.section('Removing')
  service.uninstall({ exec: deps.exec })
  ui.item(ui.c.red('-'), 'router service')
  shims(paths.shims)
  ui.item(ui.c.red('-'), `generated shims in ${short(paths.shims)}`)
  // the marked PATH block init wrote — hand-written PATH lines are never touched
  const rc = rcOf({ home: home(), shell: process.env.SHELL, platform: platform() }).file
  if (stripRcBlock(rc)) ui.item(ui.c.red('-'), `barrito PATH block from ${short(rc)}`)
  Object.values(config.identities ?? {}).forEach((identity) => cleanSettings(identity, config, ui))

  if (values.restore) {
    // barrito-owned copies the current config points at — restore brings config.toml
    // back to the items it referenced before adoption, so the copies are barrito's to
    // remove (we created them with -T /usr/bin/security: deleting needs no prompt)
    const ownedRefs = [...new Set(Object.values(config.identities ?? {}).flatMap((i) => Object.values(i.keychain ?? {})))]
      .filter((ref): ref is string => typeof ref === 'string' && keychain.kind(ref) === 'keyring' && keychain.owned(ref))
    ui.section('Restore')
    const manifest = latest(paths.backup, fs)
    if (!manifest) {
      ui.warn('no backup manifest found')
      ui.outro(ui.c.red('nothing to restore'))
      return ctx.exit(1)
    }
    // keychain writes take the injected exec only: deps.exec drops stdin, which `security -i` needs
    const restored = new Set<string>()
    const report = (line: string): void => {
      if (line.startsWith('! ')) return ui.warn(line.slice(2))
      restored.add(line.replace(/^✓ restored keychain "(.*)"$/, '$1'))
      ui.item(ui.mark('ok'), line.slice(2))
    }
    restore(manifest, { exec: deps.exec, fs, keyring: { exec: ctx.io?.exec }, report })
    ui.item(ui.c.green('+'), `restored from ${short(path.dirname(path.dirname(manifest)))}`)
    if (platform() === 'darwin') {
      ownedRefs.filter((ref) => !restored.has(ref)).forEach((ref) => {
        if (keychain.del(ref, { exec: deps.exec })) ui.item(ui.c.red('-'), `barrito-owned keychain item "${ref}"`)
      })
    }
  }

  ui.outro(`barrito removed.${values.restore ? ' The old setup is back.' : ` config left at ${short(paths.config)} — delete it to fully remove`}`)
}

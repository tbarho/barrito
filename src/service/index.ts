import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { paths, home, platform } from '../paths.ts'
import * as launchd from './launchd.ts'
import * as systemd from './systemd.ts'
import type { Exec, ServiceStatus } from '../types.ts'

export const label = 'dev.barrito.router'
export const legacy = 'com.tybarho.claude-router'

const linux = (): boolean => platform() === 'linux'

export interface InstallOpts {
  bin?: string
  port?: number
  exec?: Exec
  dir?: string
  node?: string | null
  pathEnv?: string
  sleep?: (ms: number) => Promise<void>
  user?: string
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const agents = (dir: string | undefined): string => dir || path.join(home(), 'Library', 'LaunchAgents')
const write = (file: string, data: string): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, data)
  renameSync(`${file}.tmp`, file)
}

const plist = (dir: string | undefined, name: string): string => path.join(agents(dir), `${name}.plist`)

// bootout is async and bootstrapping immediately races it (I/O error 5): ignore
// the bootout result, then give launchd a beat before bootstrap
const settle = (exec: Exec | undefined, name: string): void => {
  try { launchd.run(exec, ['bootout', `gui/${launchd.uid()}/${name}`]) } catch {}
}

export const install = async (o: InstallOpts = {}): Promise<string> => {
  if (linux()) return systemd.install(o)
  const { bin, port, exec, dir, node, pathEnv, sleep: snooze = sleep } = o
  const file = plist(dir, label)
  const xml = launchd.render({ node, bin, port, logs: paths.logs, pathEnv })
  write(file, xml)
  settle(exec, label)
  await snooze(1000)
  launchd.run(exec, ['bootstrap', `gui/${launchd.uid()}`, file])
  return xml
}

export const uninstall = (o: { exec?: Exec; dir?: string } = {}): void => {
  if (linux()) return systemd.uninstall(o)
  settle(o.exec, label)
  rmSync(plist(o.dir, label), { force: true })
}

export const removeLegacy = (o: { exec?: Exec; dir?: string } = {}): void => {
  if (linux()) return // no legacy plist on linux
  settle(o.exec, legacy)
  rmSync(plist(o.dir, legacy), { force: true })
}

export const status = (o: { exec?: Exec } = {}): ServiceStatus => {
  if (linux()) return systemd.status(o)
  try {
    return launchd.parse(launchd.run(o.exec, ['print', `gui/${launchd.uid()}/${label}`]))
  } catch {
    return { running: false, pid: null }
  }
}

export const restart = (o: { exec?: Exec } = {}): void => {
  if (linux()) return systemd.restart(o)
  launchd.run(o.exec, ['kickstart', '-k', `gui/${launchd.uid()}/${label}`])
}

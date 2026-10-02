import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { root } from '../paths.ts'

const onPath = new Map<string, boolean>()

// async spawn never surfaces ENOENT, so availability is probed synchronously once per binary
const which = (bin: string): boolean => {
  if (!onPath.has(bin)) {
    const r = spawnSync('sh', ['-c', `command -v ${JSON.stringify(bin)}`], { stdio: 'ignore' })
    onPath.set(bin, r.error == null && r.status === 0)
  }
  return onPath.get(bin) === true
}

// the real notification fires detached; the probe already guaranteed the binary exists
const fire = (bin: string, args: string[]): boolean => {
  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

const esc = (s: string) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r')

const line = (s: NodeJS.WriteStream) => (t: string) => {
  s.write(`${t}\n`)
}

// GitHub workflow commands: the data part escapes %, CR and LF; property values also : and ,
const data = (s: string): string => s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const prop = (s: string): string => data(s).replaceAll(':', '%3A').replaceAll(',', '%2C')

export interface NotifyOpts {
  probe?: (bin: string) => boolean
  exec?: (bin: string, args: string[]) => unknown
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  // the identity (or kind) the notice belongs to — macOS groups repeats so they replace, not stack
  group?: string
  out?: (t: string) => void
  err?: (t: string) => void
}

const icon = (): string => path.join(root(), 'templates', 'icon.png')

const mac = (
  title: string,
  message: string,
  group: string | undefined,
  probe: (bin: string) => boolean,
  exec: (bin: string, args: string[]) => unknown,
): void => {
  if (probe('terminal-notifier')) {
    // contentImage shows the burrito on the right; -appIcon is unreliable on modern macOS
    return void exec('terminal-notifier', [
      '-title', title, '-message', message, '-contentImage', icon(), '-group', group ? `barrito-${group}` : 'barrito',
    ])
  }
  exec('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`])
}

// Never throws, never blocks. probe(bin) → is the binary on PATH; exec fires it detached. Injected in tests.
export const notify = (
  title: string,
  message: string,
  { probe = which, exec = fire, env = process.env, platform = process.platform, group, out = line(process.stdout), err = line(process.stderr) }: NotifyOpts = {},
): void => {
  try {
    if (env.GITHUB_ACTIONS === 'true') {
      out(`::${message.includes('is back') ? 'notice' : 'warning'} title=${prop(title)}::${data(message)}`)
      return
    }
    if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
      if (probe('notify-send')) return void exec('notify-send', ['-a', 'barrito', '-i', icon(), title, message])
    }
    if (platform === 'darwin') return mac(title, message, group, probe, exec)
    err(`barrito: ${message}`)
  } catch {}
}

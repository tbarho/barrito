import { stripVTControlCharacters as strip } from 'node:util'
import pc from 'picocolors'
import * as p from '@clack/prompts'
import type { Option } from '@clack/prompts'
import { spine } from './glyphs.ts'
import { home } from './paths.ts'

type Env = Record<string, string | undefined>
export type Level = 'ok' | 'warn' | 'bad'
export interface Term { write: (s: string) => unknown; isTTY?: boolean; columns?: number }
export interface UiOpts { print?: (s: string) => void; env?: Env; out?: Term }
export interface Item { label: string; detail?: string; on?: boolean }

const chars = (s: string): number => [...strip(s)].length

export const tilde = (p: string | null | undefined): string => {
  const h = home()
  return typeof p === 'string' && p.startsWith(h) ? `~${p.slice(h.length)}` : p ?? ''
}

export const loc = (n: number): string => {
  if (n < 1000) return `${n} loc`
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k loc`
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M loc`
}

// first version-looking token of a `--version` line: "2.1.287 (Claude Code)" → "2.1.287"
export const version = (raw: string): string => /\d+(?:\.\d+)+/.exec(raw)?.[0] ?? raw.trim()

// rows one line occupies after clack's hard word wrap (wrap-ansi semantics: the joining
// space counts toward the row, a word that overflows starts a new row, long words split)
export const rowsOf = (line: string, cols: number): number => {
  if (chars(line) <= cols) return 1
  const end = strip(line).split(' ').reduce((memo, word, i) => {
    const len = [...word].length
    const cur = i > 0 && memo.cur > 0 ? memo.cur + 1 : memo.cur
    if (len > cols) {
      const total = cur + len
      return { rows: memo.rows + Math.ceil(total / cols) - 1, cur: total % cols || cols }
    }
    if (cur + len > cols && cur > 0 && len > 0) return { rows: memo.rows + 1, cur: len }
    return { rows: memo.rows, cur: cur + len }
  }, { rows: 1, cur: 0 })
  return end.rows
}

export const create = ({
  print = (s) => { process.stdout.write(`${s}\n`) },
  env = process.env,
  out = process.stdout,
}: UiOpts = {}) => {
  const g = spine(env)
  const c = pc.createColors(!env.NO_COLOR && pc.isColorSupported)
  const tty = Boolean(out.isTTY)
  const cols = (): number => out.columns || 80
  // the spacer `│` goes between blocks, never between the rows of one block
  let last: 'none' | 'section' | 'steps' = 'none'
  let running: string | null = null
  let held: string[] = []

  const emit = (s: string): void => {
    if (running != null) {
      held.push(s)
      return
    }
    print(s)
  }
  const bar = (): string => c.gray(g.bar)
  const mark = (level: Level): string =>
    level === 'ok' ? c.green(g.ok) : level === 'bad' ? c.red(g.bad) : c.yellow(g.warn)
  // TTY rows wrap inside the spine with a hanging indent; piped output keeps whole lines (greppable)
  const wrap = (s: string, hang: number): string[] => {
    const width = cols() - 3
    if (!tty || chars(s) <= width) return [s]
    return s.split(' ').reduce<string[]>((memo, word) => {
      const lineNo = memo.length - 1
      const cur = memo[lineNo] ?? ''
      if (cur && chars(cur) + 1 + chars(word) > width) return [...memo, `${' '.repeat(hang)}${word}`]
      memo[lineNo] = cur ? `${cur} ${word}` : word
      return memo
    }, [''])
  }
  const row = (s = '', hang = 0): void => {
    if (!s) return emit(bar())
    wrap(s, hang).forEach((l) => emit(`${bar()}  ${l}`))
  }
  const item = (sign: string, s: string): void => row(`${sign} ${s}`, chars(sign) + 1)
  const pad = (labels: string[]): number => labels.reduce((memo, l) => Math.max(memo, chars(l)), 0) + 2
  const fill = (s: string, width: number): string => s + ' '.repeat(Math.max(width - chars(s), 1))

  const intro = (title: string): void => {
    print(c.bold(title))
    print('')
  }

  const section = (title: string, lines: string[] = []): void => {
    if (last !== 'none') emit(bar())
    emit(`${c.green(g.step)}  ${title}`)
    last = 'section'
    lines.forEach((l) => row(l))
  }

  const rows = (kv: Array<[string, string]>): void => {
    const w = pad(kv.map(([k]) => k))
    kv.forEach(([k, v]) => row(`${c.dim(fill(k, w))}${v}`, w))
  }

  const list = (items: Item[]): void => {
    const w = pad(items.map((i) => i.label))
    items.forEach((i) => {
      const box = i.on == null ? '' : `${i.on ? c.green(g.on) : c.dim(g.off)} `
      row(`${box}${i.detail ? `${fill(i.label, w)}${c.dim(i.detail)}` : i.label}`, chars(box))
    })
  }

  const answered = (question: string, answer: string): void => row(`${c.dim(question)} ${answer}`)
  const warn = (msg: string): void => item(mark('warn'), msg)
  const note = (msg: string): void => row(c.dim(msg))

  // clack leaves a 3-line submit frame (`│`, `◇  message`, `│  answer`) — erase it so the
  // caller can re-render the answer as one spine row; TTY only, piped output is never rewritten
  const erase = (message: string, answer: string): void => {
    if (!tty) return
    const n = [g.bar, `${g.step}  ${message}`, `${g.bar}  ${answer}`].reduce((memo, l) => memo + rowsOf(l, cols()), 0)
    out.write(`\x1b[${n}A\r\x1b[J`)
  }

  // one apply step: `◆ msg` while it runs, rewritten in place to `◇ msg` (or ✗) when done;
  // rows printed meanwhile are held until the step line settles
  const step = (msg: string): ((level?: Level) => void) => {
    if (last === 'section') print(bar())
    last = 'steps'
    const max = cols() - 4
    if (tty) out.write(`${c.cyan(g.active)}  ${chars(msg) > max ? `${[...msg].slice(0, max - 1).join('')}…` : msg}`)
    running = msg
    return (level = 'ok') => {
      if (running !== msg) return
      if (tty) out.write('\r\x1b[2K')
      running = null
      print(`${level === 'ok' ? c.green(g.step) : mark(level)}  ${msg}`)
      held.forEach(print)
      held = []
    }
  }

  const outro = (msg: string): void => {
    if (last !== 'none') emit(bar())
    emit(`${c.gray(g.end)}  ${msg}`)
    last = 'none'
  }

  return { g, c, tty, mark, intro, section, row, item, rows, list, answered, warn, note, erase, step, outro }
}

export type Ui = ReturnType<typeof create>

// interactive prompts — injectable so tests can script a fully interactive run
export interface Prompts {
  confirm: (message: string, opts?: { value?: boolean }) => Promise<boolean>
  text: (message: string, opts?: { default?: string; validate?: (value: string) => string | undefined }) => Promise<string>
  select: <V extends string>(message: string, opts: { initialValue?: V; options: Array<{ value: V; label: string; hint?: string }> }) => Promise<V>
  multiselect: <V extends string>(message: string, opts: { options: Array<{ value: V; label: string; hint?: string }>; initialValues?: V[]; required?: boolean }) => Promise<V[]>
}

const settled = <T>(answer: T | symbol, cancel: string): T => {
  if (!p.isCancel(answer)) return answer
  p.cancel(cancel)
  return process.exit(1)
}

// clack's submit frame is erased right after each answer — the caller re-renders it as one spine row
export const prompts = (ui: Ui, cancel = 'aborted — nothing written'): Prompts => ({
  confirm: async (message, opts) => {
    const answer = settled(await p.confirm({ message, initialValue: opts?.value }), cancel)
    ui.erase(message, answer ? 'Yes' : 'No')
    return answer
  },
  text: async (message, opts) => {
    const answer = settled(await p.text({ message, defaultValue: opts?.default, validate: opts?.validate }), cancel) ?? ''
    ui.erase(message, answer)
    return answer
  },
  select: async <V extends string>(message: string, opts: { initialValue?: V; options: Array<{ value: V; label: string; hint?: string }> }) => {
    // @clack's Option<Value> is a deferred conditional — resolvable only through a cast
    const answer = settled(await p.select<V>({ message, options: opts.options as Option<V>[], initialValue: opts.initialValue }), cancel)
    ui.erase(message, opts.options.find((o) => o.value === answer)?.label ?? answer)
    return answer
  },
  multiselect: async <V extends string>(message: string, opts: { options: Array<{ value: V; label: string; hint?: string }>; initialValues?: V[]; required?: boolean }) => {
    const answer = settled(await p.multiselect<V>({ message, options: opts.options as Option<V>[], initialValues: opts.initialValues, required: opts.required }), cancel)
    ui.erase(message, opts.options.filter((o) => answer.includes(o.value)).map((o) => o.label).join(', ') || 'none')
    return answer
  },
})

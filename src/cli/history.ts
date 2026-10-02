import { parseArgs } from 'node:util'
import fsx from 'node:fs'
import { copy, moves, pending, scan } from '../history.ts'
import { create, tilde } from '../ui.ts'
import type { Term } from '../ui.ts'
import type { CommandCtx, Git, HistoryMove, HistoryProject } from '../types.ts'

export interface HistoryOpts {
  fs?: typeof fsx
  git?: Git
  env?: Record<string, string | undefined>
  term?: Term
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const newSessions = (m: HistoryMove): number => m.copy.filter((f) => /^[^/]+\.jsonl$/.test(f)).length

const detail = (p: HistoryProject, extra: string[] = []): string =>
  [plural(p.sessions, 'session'), p.memory && 'memory', p.how, ...extra].filter(Boolean).join(' · ')

export default async (argv: string[], ctx: CommandCtx, opts: HistoryOpts = {}): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      apply: { type: 'boolean' },
      json: { type: 'boolean' },
      'include-unknown': { type: 'string' },
    },
  })
  if (positionals[0] !== 'sync') {
    ctx.print('usage: barrito history sync [--apply] [--json] [--include-unknown <identity>]')
    return ctx.exit(2)
  }
  const include = values['include-unknown'] ?? null
  if (include && !ctx.config.identities[include]) {
    ctx.print(`barrito: unknown identity "${include}" — one of ${Object.keys(ctx.config.identities).join(', ')}`)
    return ctx.exit(2)
  }
  const fs = opts.fs ?? fsx
  const projects = scan({ config: ctx.config, fs, git: opts.git })
  const all = moves(projects, { config: ctx.config, fs, include })
  const todo = all.filter(pending)
  const shown = all.filter((m) => pending(m) || m.conflicts.length)
  const conflicts = all.reduce((n, m) => n + m.conflicts.length, 0)
  const synced = all.length - todo.length
  const unknown = projects.filter((p) => p.how === 'unknown' && !include)
  const inPlace = projects.filter((p) => p.to === p.from).length + synced
  const sessions = todo.reduce((n, m) => n + newSessions(m), 0)
  const copied = values.apply ? todo.map((m) => ({ move: m, files: copy(m, { fs }) })) : []

  if (values.json) {
    ctx.print(JSON.stringify({
      apply: Boolean(values.apply),
      projects,
      moves: shown,
      copied: copied.map((c) => ({ dir: c.move.dir, target: c.move.target, files: c.files })),
      summary: { copy: todo.length, sessions, unknown: unknown.length, inPlace, conflicts },
    }, null, 2))
    return
  }

  const ui = create({ print: ctx.print, env: opts.env, out: opts.term })
  ui.intro(`barrito history sync${values.apply ? '' : ' (dry run)'}`)
  const pairs = shown.reduce<Record<string, HistoryMove[]>>((memo, m) => {
    const key = `${m.from} ${ui.g.arrow} ${m.to}`
    memo[key] = [...(memo[key] ?? []), m]
    return memo
  }, {})
  Object.entries(pairs).forEach(([pair, list]) => {
    ui.section(pair)
    ui.list(list.map((m) => ({
      label: tilde(m.cwd),
      detail: detail(m, [m.conflicts.length ? plural(m.conflicts.length, 'conflict') : '']),
    })))
    list.forEach((m) => m.conflicts.forEach((f) => ui.warn(`${tilde(m.target)}/${f} differs — never overwritten`)))
  })
  if (unknown.length) {
    ui.section('unknown — not copied')
    ui.list(unknown.map((p) => ({ label: tilde(p.cwd), detail: detail(p, [`in ${p.from}`]) })))
    ui.note('copy them anyway: barrito history sync --apply --include-unknown <identity>')
  }
  if (copied.length) {
    ui.section('Copied')
    copied.forEach(({ move, files }) => ui.item(ui.mark('ok'), `${tilde(move.cwd)} ${ui.g.arrow} ${tilde(move.target)} (${plural(files.length, 'file')})`))
  }
  const line = [
    `${plural(todo.length, 'project')} ${values.apply ? 'copied' : 'to copy'} (${plural(sessions, 'session')})`,
    `${unknown.length} unknown`,
    `${inPlace} already in place`,
    conflicts && plural(conflicts, 'conflict'),
  ].filter(Boolean).join(', ')
  ui.outro(values.apply || !todo.length ? line : `${line} — barrito history sync --apply`)
}

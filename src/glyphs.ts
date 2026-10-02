// ASCII-only status glyphs. Some terminal fonts (tmux) render the fancy code
// points as missing boxes, so every status surface — statusline, `barrito status`
// — draws from this one map. A future --unicode flag swaps these values, never
// the call sites.
export const glyphs = {
  sep: ' | ', // part separator
  warn: '!', // marks a non-max tier
  reroute: ' > ', // session's model vs what actually answers
  api: '(API)', // API credits, not Max plan
  resets: 'Max resets', // quota window reset prefix
  throttled: 'throttled, retry', // throttle probe reset prefix
  pin: 'pin', // identity pinned to a model
  pinMax: 'pin max', // identity pinned to max
}

type Env = Record<string, string | undefined>

// the init/doctor spine: box-drawing only on a UTF-8 locale with color allowed —
// NO_COLOR or a C/POSIX locale gets plain ASCII that survives any font or log file
export const unicode = (env: Env = process.env): boolean =>
  !env.NO_COLOR && /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')

export const spine = (env: Env = process.env) => unicode(env)
  ? { bar: '│', step: '◇', active: '◆', end: '└', ok: '✓', bad: '✗', warn: '!', on: '◼', off: '◻', radio: '●', arrow: '→', dot: '·' }
  : { bar: '|', step: 'o', active: '*', end: '+', ok: 'ok', bad: 'x', warn: '!', on: '[x]', off: '[ ]', radio: '*', arrow: '->', dot: '-' }
